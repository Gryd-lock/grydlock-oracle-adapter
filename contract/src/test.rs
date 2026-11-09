extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{
        Address as _, AuthorizedFunction, AuthorizedInvocation, Events as _, Ledger as _, MockAuth,
        MockAuthInvoke,
    },
    Event, IntoVal, Symbol,
};

struct Setup<'a> {
    env: Env,
    admin: Address,
    id: Address,
    client: RiskOracleClient<'a>,
}

fn setup() -> Setup<'static> {
    let env = Env::default();
    env.ledger().with_mut(|l| {
        l.sequence_number = 1_000;
        l.timestamp = 1_700_000_000;
    });
    let admin = Address::generate(&env);
    let id = env.register(RiskOracle, (&admin,));
    let client = RiskOracleClient::new(&env, &id);
    Setup {
        env,
        admin,
        id,
        client,
    }
}

fn account(env: &Env) -> Target {
    Target::Address(Address::generate(env))
}

#[test]
fn unknown_target_is_unscored_at_current_ledger() {
    let s = setup();
    let (score, stamp, version) = s.client.get_score(&account(&s.env));
    assert_eq!(score, Score::Unscored);
    assert_eq!(stamp.sequence, 1_000);
    assert_eq!(stamp.timestamp, 1_700_000_000);
    assert_eq!(version, INTERFACE_VERSION);
}

#[test]
fn set_score_is_read_back_with_the_ledger_it_was_written_at() {
    let s = setup();
    s.env.mock_all_auths();
    let target = account(&s.env);
    s.client.set_score(&target, &42);

    s.env.ledger().with_mut(|l| {
        l.sequence_number = 1_050;
        l.timestamp = 1_700_000_250;
    });
    let (score, stamp, _) = s.client.get_score(&target);
    assert_eq!(score, Score::Scored(42));
    assert_eq!(
        stamp,
        LedgerStamp {
            sequence: 1_000,
            timestamp: 1_700_000_000
        }
    );
}

#[test]
fn boundary_scores_are_accepted_and_101_is_rejected() {
    let s = setup();
    s.env.mock_all_auths();
    let target = account(&s.env);
    s.client.set_score(&target, &0);
    assert_eq!(s.client.get_score(&target).0, Score::Scored(0));
    s.client.set_score(&target, &100);
    assert_eq!(s.client.get_score(&target).0, Score::Scored(100));

    let err = s.client.try_set_score(&target, &101).unwrap_err();
    assert_eq!(err, Ok(OracleError::ScoreOutOfRange.into()));
    assert_eq!(s.client.get_score(&target).0, Score::Scored(100));
}

#[test]
fn pending_and_clear_round_trip() {
    let s = setup();
    s.env.mock_all_auths();
    let target = account(&s.env);
    s.client.set_pending(&target);
    assert_eq!(s.client.get_score(&target).0, Score::Pending);
    s.client.set_score(&target, &7);
    s.client.clear_score(&target);
    assert_eq!(s.client.get_score(&target).0, Score::Unscored);
}

#[test]
fn asset_and_pool_targets_are_scored_independently_of_the_issuer() {
    let s = setup();
    s.env.mock_all_auths();
    let issuer = Address::generate(&s.env);
    let scam = Target::Asset(String::from_str(&s.env, "SCAM"), issuer.clone());
    let usdc = Target::Asset(String::from_str(&s.env, "USDC"), issuer.clone());
    let pool = Target::Pool(BytesN::from_array(&s.env, &[7; 32]));

    s.client.set_score(&Target::Address(issuer.clone()), &95);
    s.client.set_score(&scam, &97);
    s.client.set_score(&pool, &12);

    assert_eq!(s.client.get_score(&scam).0, Score::Scored(97));
    assert_eq!(s.client.get_score(&usdc).0, Score::Unscored);
    assert_eq!(s.client.get_score(&pool).0, Score::Scored(12));
    assert_eq!(
        s.client.get_score(&Target::Address(issuer)).0,
        Score::Scored(95)
    );
}

#[test]
fn invalid_asset_codes_are_rejected() {
    let s = setup();
    s.env.mock_all_auths();
    let issuer = Address::generate(&s.env);
    for code in ["", "THIRTEENCHARS"] {
        let target = Target::Asset(String::from_str(&s.env, code), issuer.clone());
        let err = s.client.try_set_score(&target, &1).unwrap_err();
        assert_eq!(err, Ok(OracleError::InvalidAssetCode.into()));
    }
}

#[test]
fn set_score_requires_admin_auth() {
    let s = setup();
    s.env.mock_all_auths();
    let target = account(&s.env);
    s.client.set_score(&target, &42);
    assert_eq!(
        s.env.auths(),
        std::vec![(
            s.admin.clone(),
            AuthorizedInvocation {
                function: AuthorizedFunction::Contract((
                    s.id.clone(),
                    Symbol::new(&s.env, "set_score"),
                    (target.clone(), 42u32).into_val(&s.env),
                )),
                sub_invocations: std::vec![],
            }
        )]
    );
}

#[test]
fn a_non_admin_cannot_write() {
    let s = setup();
    let intruder = Address::generate(&s.env);
    let target = account(&s.env);
    s.env.mock_auths(&[MockAuth {
        address: &intruder,
        invoke: &MockAuthInvoke {
            contract: &s.id,
            fn_name: "set_score",
            args: (target.clone(), 0u32).into_val(&s.env),
            sub_invokes: &[],
        },
    }]);
    assert!(s.client.try_set_score(&target, &0).is_err());
    assert_eq!(s.client.get_score(&target).0, Score::Unscored);
}

#[test]
fn writes_without_any_auth_fail() {
    let s = setup();
    let target = account(&s.env);
    assert!(s.client.try_set_score(&target, &5).is_err());
    assert!(s.client.try_set_pending(&target).is_err());
    assert!(s.client.try_clear_score(&target).is_err());
}

#[test]
fn set_score_publishes_a_score_updated_event() {
    let s = setup();
    s.env.mock_all_auths();
    let target = account(&s.env);
    s.client.set_score(&target, &55);
    let expected = ScoreUpdated {
        target,
        score: Score::Scored(55),
        sequence: 1_000,
    };
    assert_eq!(
        s.env.events().all(),
        std::vec![expected.to_xdr(&s.env, &s.id)]
    );
}

#[test]
fn clear_publishes_an_unscored_event() {
    let s = setup();
    s.env.mock_all_auths();
    let target = account(&s.env);
    s.client.clear_score(&target);
    let expected = ScoreUpdated {
        target,
        score: Score::Unscored,
        sequence: 1_000,
    };
    assert_eq!(
        s.env.events().all(),
        std::vec![expected.to_xdr(&s.env, &s.id)]
    );
}

#[test]
fn admin_handover() {
    let s = setup();
    s.env.mock_all_auths();
    assert_eq!(s.client.admin(), s.admin);
    let next = Address::generate(&s.env);
    s.client.set_admin(&next);
    // `events().all()` only covers the most recent invocation, so check it
    // before reading `admin()` again.
    assert_eq!(
        s.env.events().all(),
        std::vec![AdminChanged {
            previous: s.admin.clone(),
            new_admin: next.clone(),
        }
        .to_xdr(&s.env, &s.id)]
    );
    assert_eq!(s.client.admin(), next);
}

#[test]
fn interface_version_is_exposed() {
    let s = setup();
    assert_eq!(s.client.interface_version(), INTERFACE_VERSION);
}
