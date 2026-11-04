#![allow(unused_must_use)]
use super::*;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::testing_env;

fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
const OWNER: &str = "owner.near";
const AGENT: &str = "agent.near";
const USDC: &str = "usdc.near";
const DEPOSIT: &str = "1click-deposit.near";

fn ctx(pred: &str, ts_secs: u64) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("vault.near"))
        .predecessor_account_id(acc(pred))
        .block_timestamp(ts_secs * 1_000_000_000);
    testing_env!(b.build());
}

fn h(c: char) -> String {
    std::iter::repeat(c).take(64).collect()
}

fn setup() -> Vault {
    ctx(OWNER, 1_000);
    let mut v = Vault::new(acc(OWNER), acc(AGENT), Policy { max_drawdown_bps: 1_000, cooldown_secs: 60 });
    v.set_token_limit(acc(USDC), TokenLimit { max_per_trade: U128(100), max_per_day: U128(250) });
    ctx(USDC, 1_000);
    let r = v.ft_on_transfer(acc(OWNER), U128(1_000), String::new());
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    v
}

fn trade(v: &mut Vault, amount: u128, ts: u64) {
    ctx(AGENT, ts);
    v.execute_trade(acc(USDC), U128(amount), acc(DEPOSIT), h('a'), h('b'));
}

#[test]
fn proceeds_accepted_only_in_allowlisted_tokens() {
    let mut v = setup();
    // Solver returns swap proceeds in an allowlisted token: credited.
    ctx(USDC, 1_000);
    let r = v.ft_on_transfer(acc("solver.near"), U128(5), String::new());
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    assert_eq!(v.get_balance(acc(USDC)).0, 1_005);
    // Unknown token from a stranger: returned.
    ctx("spam.near", 1_000);
    let r = v.ft_on_transfer(acc("stranger.near"), U128(7), String::new());
    assert!(matches!(r, PromiseOrValue::Value(U128(7))));
    assert_eq!(v.get_balance(acc("spam.near")).0, 0);
}

#[test]
fn trade_within_policy_records_commitment_only() {
    let mut v = setup();
    trade(&mut v, 100, 2_000);
    assert_eq!(v.get_balance(acc(USDC)).0, 900);
    let d = &v.get_decisions(None, None)[0];
    assert_eq!(d.commitment, h('a'));
    assert_eq!(d.status, DecisionStatus::Pending);
    assert!(get_logs().iter().any(|l| l.contains("\"event\":\"trade\"")));
}

#[test]
#[should_panic(expected = "agent only")]
fn owner_cannot_impersonate_agent() {
    let mut v = setup();
    ctx(OWNER, 2_000);
    v.execute_trade(acc(USDC), U128(1), acc(DEPOSIT), h('a'), h('b'));
}

#[test]
#[should_panic(expected = "over per-trade cap")]
fn per_trade_cap() {
    let mut v = setup();
    trade(&mut v, 101, 2_000);
}

#[test]
#[should_panic(expected = "over daily cap")]
fn daily_cap() {
    let mut v = setup();
    trade(&mut v, 100, 2_000);
    trade(&mut v, 100, 2_100);
    trade(&mut v, 100, 2_200);
}

#[test]
fn daily_cap_resets_next_day() {
    let mut v = setup();
    trade(&mut v, 100, 2_000);
    trade(&mut v, 100, 2_100);
    trade(&mut v, 100, 2_000 + 86_400);
    ctx(AGENT, 2_000 + 86_400);
    assert_eq!(v.get_remaining_today(acc(USDC)).0, 150);
}

#[test]
#[should_panic(expected = "cooldown active")]
fn cooldown() {
    let mut v = setup();
    trade(&mut v, 10, 2_000);
    trade(&mut v, 10, 2_030);
}

#[test]
#[should_panic(expected = "token not allowlisted")]
fn unknown_token_blocked() {
    let mut v = setup();
    ctx(AGENT, 2_000);
    v.execute_trade(acc("rug.near"), U128(1), acc(DEPOSIT), h('a'), h('b'));
}

#[test]
#[should_panic(expected = "cannot pay the agent")]
fn agent_cannot_pay_itself() {
    let mut v = setup();
    ctx(AGENT, 2_000);
    v.execute_trade(acc(USDC), U128(1), acc(AGENT), h('a'), h('b'));
}

#[test]
#[should_panic(expected = "commitment must be 32-byte hex")]
fn commitment_required() {
    let mut v = setup();
    ctx(AGENT, 2_000);
    v.execute_trade(acc(USDC), U128(1), acc(DEPOSIT), "nope".into(), h('b'));
}

#[test]
fn drawdown_trips_kill_switch_and_blocks_trades() {
    let mut v = setup();
    ctx(AGENT, 2_000);
    v.report_nav(U64(100_000));
    v.report_nav(U64(95_000)); // 5%: fine
    assert!(!v.get_status().paused);
    v.report_nav(U64(89_000)); // 11% > 10%
    let s = v.get_status();
    assert!(s.paused);
    assert_eq!(s.drawdown_bps, 1_100);
    assert!(get_logs().iter().any(|l| l.contains("kill_switch")));
}

#[test]
#[should_panic(expected = "vault paused")]
fn paused_vault_rejects_trades() {
    let mut v = setup();
    ctx(OWNER, 2_000);
    v.pause(None);
    trade(&mut v, 10, 2_100);
}

#[test]
fn owner_resume_resets_high_water_mark() {
    let mut v = setup();
    ctx(AGENT, 2_000);
    v.report_nav(U64(100_000));
    v.report_nav(U64(80_000));
    ctx(OWNER, 2_100);
    v.resume();
    let s = v.get_status();
    assert!(!s.paused);
    assert_eq!(s.drawdown_bps, 0);
    assert_eq!(s.nav_high_water_cents.0, 80_000);
}

#[test]
fn selective_disclosure() {
    let mut v = setup();
    let memo = r#"{"thesis":"rotate 10% into ETH","salt":"x"}"#;
    let commit = hex::encode(env::sha256(memo.as_bytes()));
    ctx(AGENT, 2_000);
    v.execute_trade(acc(USDC), U128(10), acc(DEPOSIT), commit, h('b'));
    assert!(v.verify_disclosure(U64(0), memo.into()));
    assert!(!v.verify_disclosure(U64(0), "forged".into()));
}

#[test]
fn failed_transfer_refunds_book_and_daily_spend() {
    let mut v = setup();
    trade(&mut v, 100, 2_000);
    let mut b = VMContextBuilder::new();
    b.current_account_id(acc("vault.near"))
        .predecessor_account_id(acc("vault.near"))
        .block_timestamp(2_000 * 1_000_000_000);
    testing_env!(b.build());
    let ok = v.on_trade_sent(U64(0), Err(PromiseError::Failed));
    assert!(!ok);
    assert_eq!(v.get_balance(acc(USDC)).0, 1_000);
    assert_eq!(v.get_remaining_today(acc(USDC)).0, 250);
    assert_eq!(v.get_decisions(None, None)[0].status, DecisionStatus::Failed);
}

#[test]
#[should_panic(expected = "owner only")]
fn agent_cannot_change_policy() {
    let mut v = setup();
    ctx(AGENT, 2_000);
    v.set_token_limit(acc(USDC), TokenLimit { max_per_trade: U128(1_000_000), max_per_day: U128(1_000_000) });
}
