//! AUREUS policy vault.
//!
//! The vault holds the owner's NEP-141 capital. The AI agent never holds funds
//! and never sees a full-access key: it can only call `execute_trade`, which
//! releases tokens to a NEAR Intents 1Click deposit address, and only inside
//! the limits the owner set.
//!
//! Privacy model: onchain you can see "the vault sent N of token X to a 1Click
//! deposit address". You cannot see what it bought, where the proceeds went
//! (they settle into the owner's Confidential Intents balance), or why. The
//! reasoning lives off-chain, produced inside a NEAR AI Cloud TEE, and only a
//! sha256 commitment of it is stored here. The owner can later prove any
//! decision to an auditor with `verify_disclosure`, without revealing the rest.

use near_sdk::json_types::{U128, U64};
use near_sdk::store::{IterableMap, Vector};
use near_sdk::{
    env, near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseError,
    PromiseOrValue,
};

const DAY_NS: u64 = 86_400 * 1_000_000_000;
const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
const GAS_CALLBACK: Gas = Gas::from_tgas(15);
const ONE_YOCTO: NearToken = NearToken::from_yoctonear(1);

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct TokenLimit {
    /// Max raw units the agent may move in one trade.
    pub max_per_trade: U128,
    /// Max raw units the agent may move per UTC day.
    pub max_per_day: U128,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Policy {
    /// Drawdown from the NAV high-water mark (basis points) that trips the kill switch.
    pub max_drawdown_bps: u16,
    /// Minimum seconds between two agent trades.
    pub cooldown_secs: u32,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum DecisionStatus {
    Pending,
    Sent,
    Failed,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug)]
pub struct Decision {
    pub id: U64,
    pub timestamp_ns: U64,
    pub token: AccountId,
    pub amount: U128,
    /// 1Click deposit address the funds were released to.
    pub deposit_address: AccountId,
    /// sha256 (hex) of the private decision memo. The memo itself never goes onchain.
    pub commitment: String,
    /// sha256 (hex) of the NEAR AI Cloud attestation report the reasoning ran under.
    pub attestation_hash: String,
    pub status: DecisionStatus,
}

#[near(serializers = [json, borsh])]
#[derive(Clone, Debug, Default)]
pub struct DaySpend {
    pub day: u64,
    pub spent: u128,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Vault {
    owner: AccountId,
    agent: AccountId,
    policy: Policy,
    paused: bool,
    pause_reason: Option<String>,
    limits: IterableMap<AccountId, TokenLimit>,
    balances: IterableMap<AccountId, u128>,
    day_spend: IterableMap<AccountId, DaySpend>,
    decisions: Vector<Decision>,
    nav_high_water_cents: u64,
    last_nav_cents: u64,
    last_trade_ns: u64,
}

#[near(serializers = [json])]
pub struct VaultStatus {
    pub owner: AccountId,
    pub agent: AccountId,
    pub policy: Policy,
    pub paused: bool,
    pub pause_reason: Option<String>,
    pub nav_high_water_cents: U64,
    pub last_nav_cents: U64,
    pub drawdown_bps: u16,
    pub decisions: U64,
}

fn emit(event: &str, data: String) {
    env::log_str(&format!(
        "EVENT_JSON:{{\"standard\":\"aureus\",\"version\":\"1.0.0\",\"event\":\"{event}\",\"data\":{data}}}"
    ));
}

fn is_hex32(s: &str) -> bool {
    s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit())
}

#[near]
impl Vault {
    #[init]
    pub fn new(owner: AccountId, agent: AccountId, policy: Policy) -> Self {
        require!(owner != agent, "owner and agent must be different accounts");
        require!(policy.max_drawdown_bps <= 10_000, "max_drawdown_bps > 10000");
        Self {
            owner,
            agent,
            policy,
            paused: false,
            pause_reason: None,
            limits: IterableMap::new(b"l"),
            balances: IterableMap::new(b"b"),
            day_spend: IterableMap::new(b"d"),
            decisions: Vector::new(b"x"),
            nav_high_water_cents: 0,
            last_nav_cents: 0,
            last_trade_ns: 0,
        }
    }

    // ------------------------------------------------------------------ owner

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner, "owner only");
    }

    pub fn set_policy(&mut self, policy: Policy) {
        self.assert_owner();
        require!(policy.max_drawdown_bps <= 10_000, "max_drawdown_bps > 10000");
        self.policy = policy;
        emit("policy_updated", "{}".into());
    }

    /// Allowlist a token and cap what the agent can move. Tokens without a limit cannot be traded.
    pub fn set_token_limit(&mut self, token: AccountId, limit: TokenLimit) {
        self.assert_owner();
        require!(limit.max_per_trade.0 <= limit.max_per_day.0, "per-trade cap above daily cap");
        self.limits.insert(token, limit);
    }

    pub fn remove_token(&mut self, token: AccountId) {
        self.assert_owner();
        self.limits.remove(&token);
    }

    pub fn set_agent(&mut self, agent: AccountId) {
        self.assert_owner();
        require!(agent != self.owner, "agent cannot be owner");
        self.agent = agent;
        emit("agent_rotated", "{}".into());
    }

    pub fn pause(&mut self, reason: Option<String>) {
        self.assert_owner();
        self.trip(reason.unwrap_or_else(|| "owner pause".into()));
    }

    pub fn resume(&mut self) {
        self.assert_owner();
        self.paused = false;
        self.pause_reason = None;
        // Reset the high-water mark so a resumed vault is measured from today.
        self.nav_high_water_cents = self.last_nav_cents;
        emit("resumed", "{}".into());
    }

    /// Owner can always pull funds out, paused or not.
    pub fn withdraw(&mut self, token: AccountId, amount: U128) -> Promise {
        self.assert_owner();
        self.debit(&token, amount.0);
        Promise::new(token.clone())
            .function_call(
                "ft_transfer",
                format!("{{\"receiver_id\":\"{}\",\"amount\":\"{}\"}}", self.owner, amount.0)
                    .into_bytes(),
                ONE_YOCTO,
                GAS_FT_TRANSFER,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_withdraw(token, amount),
            )
    }

    // ------------------------------------------------------------------ agent

    fn assert_agent(&self) {
        require!(env::predecessor_account_id() == self.agent, "agent only");
    }

    /// Agent reports portfolio NAV (USD cents). A drawdown past policy trips the kill switch.
    pub fn report_nav(&mut self, nav_cents: U64) {
        let caller = env::predecessor_account_id();
        require!(caller == self.agent || caller == self.owner, "agent or owner only");
        let nav = nav_cents.0;
        self.last_nav_cents = nav;
        if nav > self.nav_high_water_cents {
            self.nav_high_water_cents = nav;
        }
        let dd = self.drawdown_bps();
        emit("nav", format!("{{\"nav_cents\":\"{nav}\",\"drawdown_bps\":{dd}}}"));
        if !self.paused && dd > self.policy.max_drawdown_bps {
            self.trip(format!("drawdown {dd} bps > limit {}", self.policy.max_drawdown_bps));
        }
    }

    /// Release `amount` of `token` to a 1Click deposit address, inside policy.
    /// Only a commitment of the reasoning is stored.
    pub fn execute_trade(
        &mut self,
        token: AccountId,
        amount: U128,
        deposit_address: AccountId,
        commitment: String,
        attestation_hash: String,
    ) -> Promise {
        self.assert_agent();
        require!(!self.paused, "vault paused");
        require!(amount.0 > 0, "zero amount");
        require!(is_hex32(&commitment), "commitment must be 32-byte hex");
        require!(is_hex32(&attestation_hash), "attestation_hash must be 32-byte hex");
        require!(deposit_address != self.agent, "cannot pay the agent");
        require!(deposit_address != env::current_account_id(), "cannot pay self");

        let now = env::block_timestamp();
        let cooldown_ns = self.policy.cooldown_secs as u64 * 1_000_000_000;
        require!(
            self.last_trade_ns == 0 || now >= self.last_trade_ns + cooldown_ns,
            "cooldown active"
        );

        let limit = self.limits.get(&token).cloned().unwrap_or_else(|| env::panic_str("token not allowlisted"));
        require!(amount.0 <= limit.max_per_trade.0, "over per-trade cap");

        let day = now / DAY_NS;
        let mut spend = self.day_spend.get(&token).cloned().unwrap_or_default();
        if spend.day != day {
            spend = DaySpend { day, spent: 0 };
        }
        let new_spent = spend.spent.checked_add(amount.0).expect("overflow");
        require!(new_spent <= limit.max_per_day.0, "over daily cap");

        self.debit(&token, amount.0);
        spend.spent = new_spent;
        self.day_spend.insert(token.clone(), spend);
        self.last_trade_ns = now;

        let id = self.decisions.len() as u64;
        self.decisions.push(Decision {
            id: U64(id),
            timestamp_ns: U64(now),
            token: token.clone(),
            amount,
            deposit_address: deposit_address.clone(),
            commitment: commitment.clone(),
            attestation_hash,
            status: DecisionStatus::Pending,
        });
        emit(
            "trade",
            format!("{{\"id\":\"{id}\",\"token\":\"{token}\",\"amount\":\"{}\",\"commitment\":\"{commitment}\"}}", amount.0),
        );

        Promise::new(token.clone())
            .function_call(
                "ft_transfer",
                format!("{{\"receiver_id\":\"{}\",\"amount\":\"{}\",\"memo\":\"aureus:{id}\"}}", deposit_address, amount.0)
                    .into_bytes(),
                ONE_YOCTO,
                GAS_FT_TRANSFER,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_trade_sent(U64(id)),
            )
    }

    // -------------------------------------------------------------- callbacks

    #[private]
    pub fn on_trade_sent(&mut self, id: U64, #[callback_result] res: Result<(), PromiseError>) -> bool {
        let idx = id.0 as u32;
        let mut d = self.decisions.get(idx).cloned().expect("no decision");
        if res.is_ok() {
            d.status = DecisionStatus::Sent;
        } else {
            // Transfer failed: return funds to the book and unwind the daily spend.
            d.status = DecisionStatus::Failed;
            self.credit(&d.token, d.amount.0);
            if let Some(mut s) = self.day_spend.get(&d.token).cloned() {
                if s.day == d.timestamp_ns.0 / DAY_NS {
                    s.spent = s.spent.saturating_sub(d.amount.0);
                    self.day_spend.insert(d.token.clone(), s);
                }
            }
        }
        let ok = res.is_ok();
        self.decisions.replace(idx, d);
        ok
    }

    #[private]
    pub fn on_withdraw(&mut self, token: AccountId, amount: U128, #[callback_result] res: Result<(), PromiseError>) {
        if res.is_err() {
            self.credit(&token, amount.0);
        }
    }

    /// NEP-141 receiver. The owner can fund with any token; swap proceeds (from any
    /// sender) are accepted only in allowlisted tokens. Everything else is returned.
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> PromiseOrValue<U128> {
        let _ = msg;
        let token = env::predecessor_account_id();
        if sender_id != self.owner && self.limits.get(&token).is_none() {
            return PromiseOrValue::Value(amount);
        }
        self.credit(&token, amount.0);
        emit("deposit", format!("{{\"token\":\"{token}\",\"amount\":\"{}\"}}", amount.0));
        PromiseOrValue::Value(U128(0))
    }

    // ------------------------------------------------------------------ views

    /// Selective disclosure: anyone holding the memo can prove it is the one the agent committed to.
    pub fn verify_disclosure(&self, id: U64, memo: String) -> bool {
        let d = self.decisions.get(id.0 as u32).expect("no decision");
        hex::encode(env::sha256(memo.as_bytes())) == d.commitment
    }

    pub fn get_status(&self) -> VaultStatus {
        VaultStatus {
            owner: self.owner.clone(),
            agent: self.agent.clone(),
            policy: self.policy.clone(),
            paused: self.paused,
            pause_reason: self.pause_reason.clone(),
            nav_high_water_cents: U64(self.nav_high_water_cents),
            last_nav_cents: U64(self.last_nav_cents),
            drawdown_bps: self.drawdown_bps(),
            decisions: U64(self.decisions.len() as u64),
        }
    }

    pub fn get_balance(&self, token: AccountId) -> U128 {
        U128(self.balances.get(&token).copied().unwrap_or(0))
    }

    pub fn get_limits(&self) -> Vec<(AccountId, TokenLimit)> {
        self.limits.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
    }

    /// Remaining amount the agent may still move today for `token`.
    pub fn get_remaining_today(&self, token: AccountId) -> U128 {
        let Some(limit) = self.limits.get(&token) else { return U128(0) };
        let day = env::block_timestamp() / DAY_NS;
        let spent = match self.day_spend.get(&token) {
            Some(s) if s.day == day => s.spent,
            _ => 0,
        };
        U128(limit.max_per_day.0.saturating_sub(spent))
    }

    pub fn get_decisions(&self, from: Option<u64>, limit: Option<u64>) -> Vec<Decision> {
        let from = from.unwrap_or(0) as u32;
        let limit = limit.unwrap_or(50) as u32;
        (from..self.decisions.len().min(from.saturating_add(limit)))
            .filter_map(|i| self.decisions.get(i).cloned())
            .collect()
    }

    // --------------------------------------------------------------- internal

    fn drawdown_bps(&self) -> u16 {
        if self.nav_high_water_cents == 0 || self.last_nav_cents >= self.nav_high_water_cents {
            return 0;
        }
        let diff = (self.nav_high_water_cents - self.last_nav_cents) as u128;
        ((diff * 10_000) / self.nav_high_water_cents as u128).min(10_000) as u16
    }

    fn trip(&mut self, reason: String) {
        self.paused = true;
        emit("kill_switch", format!("{{\"reason\":{:?}}}", reason));
        self.pause_reason = Some(reason);
    }

    fn credit(&mut self, token: &AccountId, amount: u128) {
        let cur = self.balances.get(token).copied().unwrap_or(0);
        self.balances.insert(token.clone(), cur.checked_add(amount).expect("overflow"));
    }

    fn debit(&mut self, token: &AccountId, amount: u128) {
        let cur = self.balances.get(token).copied().unwrap_or(0);
        require!(cur >= amount, "insufficient vault balance");
        self.balances.insert(token.clone(), cur - amount);
    }
}

#[cfg(test)]
mod tests;
