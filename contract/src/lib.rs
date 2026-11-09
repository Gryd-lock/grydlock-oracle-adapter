//! Gryd Lock risk oracle: a minimal, admin-curated 0-100 risk-score registry.
//!
//! This is the reference contract for `grydlock-oracle-adapter`'s
//! `SorobanOracle` (see `docs/adr/0001-soroban-oracle-protocol.md` and
//! `contract/README.md`). It is deliberately small. A single admin
//! sets scores by hand, and there is no aggregation, staking or dispute
//! process. It exists so the adapter has a real contract to read on
//! testnet. It is not meant as a production scoring system.
//!
//! Interface (version [`INTERFACE_VERSION`]):
//!
//! - `get_score(target) -> (Score, LedgerStamp, u32)`: read-only. Returns the
//!   outcome, the ledger the outcome was written at, and the interface
//!   version. A target that was never written (or was cleared) returns
//!   `Score::Unscored` stamped with the *current* ledger.
//! - `set_score(target, score)`, `set_pending(target)`, `clear_score(target)`:
//!   admin-only writes. Each one publishes a `score_updated` event.
//! - `admin()`, `set_admin(new_admin)`, `interface_version()`.
#![no_std]

use soroban_sdk::{
    contract, contracterror, contractevent, contractimpl, contracttype, panic_with_error, Address,
    BytesN, Env, String,
};

/// Bumped whenever the shape of `get_score`'s return value changes. The
/// adapter rejects responses outside its supported range.
pub const INTERFACE_VERSION: u32 = 1;

/// Highest valid score (inclusive). The lowest is 0.
pub const MAX_SCORE: u32 = 100;

/// Longest SEP-11 asset code (alphanum12).
const MAX_ASSET_CODE_LEN: u32 = 12;

/// What a score is about. Mirrors the adapter's `ValidatedDestination`:
/// `G` accounts (muxed `M` accounts are scored under their base `G`) and
/// `C` contracts are `Address`; SEP-11 assets are `(code, issuer)`;
/// liquidity pools are their 32-byte pool id.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Target {
    Address(Address),
    Asset(String, Address),
    Pool(BytesN<32>),
}

/// The outcome of a lookup. `Unscored` is never stored; it is what an
/// absent entry reads as.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Score {
    /// A 0-100 risk score.
    Scored(u32),
    /// The target is tracked, but no score has been decided yet.
    Pending,
    /// The oracle has no opinion about this target.
    Unscored,
}

/// The ledger an outcome was written at.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LedgerStamp {
    pub sequence: u32,
    /// Ledger close time, in Unix seconds.
    pub timestamp: u64,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
struct Record {
    score: Score,
    stamp: LedgerStamp,
}

#[contracttype]
#[derive(Clone)]
enum DataKey {
    Admin,
    Entry(Target),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq, PartialOrd, Ord)]
#[repr(u32)]
pub enum OracleError {
    /// `set_score` was called with a score above [`MAX_SCORE`].
    ScoreOutOfRange = 1,
    /// An asset target's code is empty or longer than 12 characters.
    InvalidAssetCode = 2,
}

/// Published on every `set_score`, `set_pending` and `clear_score`.
/// `score` is the new outcome (`Unscored` after a clear).
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScoreUpdated {
    #[topic]
    pub target: Target,
    pub score: Score,
    pub sequence: u32,
}

/// Published when the admin hands over control.
#[contractevent]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdminChanged {
    pub previous: Address,
    pub new_admin: Address,
}

#[contract]
pub struct RiskOracle;

fn stamp(env: &Env) -> LedgerStamp {
    LedgerStamp {
        sequence: env.ledger().sequence(),
        timestamp: env.ledger().timestamp(),
    }
}

fn require_admin(env: &Env) -> Address {
    let admin: Address = env
        .storage()
        .instance()
        .get(&DataKey::Admin)
        .expect("admin is set by the constructor");
    admin.require_auth();
    admin
}

fn validate_target(env: &Env, target: &Target) {
    if let Target::Asset(code, _) = target {
        if code.is_empty() || code.len() > MAX_ASSET_CODE_LEN {
            panic_with_error!(env, OracleError::InvalidAssetCode);
        }
    }
}

/// Keeps the contract instance and, when given, one score entry alive for
/// the network's maximum TTL, so a seeded testnet deployment stays readable
/// without anyone having to restore it.
fn bump(env: &Env, key: Option<&DataKey>) {
    let max = env.storage().max_ttl();
    let threshold = max / 2;
    env.storage().instance().extend_ttl(threshold, max);
    if let Some(key) = key {
        env.storage().persistent().extend_ttl(key, threshold, max);
    }
}

fn write(env: &Env, target: Target, score: Score) {
    validate_target(env, &target);
    let key = DataKey::Entry(target.clone());
    let record = Record {
        score: score.clone(),
        stamp: stamp(env),
    };
    env.storage().persistent().set(&key, &record);
    bump(env, Some(&key));
    ScoreUpdated {
        target,
        score,
        sequence: record.stamp.sequence,
    }
    .publish(env);
}

#[contractimpl]
impl RiskOracle {
    pub fn __constructor(env: Env, admin: Address) {
        env.storage().instance().set(&DataKey::Admin, &admin);
        bump(&env, None);
    }

    /// Reads the outcome for `target`. Never fails for a well-formed target.
    pub fn get_score(env: Env, target: Target) -> (Score, LedgerStamp, u32) {
        let key = DataKey::Entry(target);
        match env.storage().persistent().get::<_, Record>(&key) {
            Some(record) => (record.score, record.stamp, INTERFACE_VERSION),
            None => (Score::Unscored, stamp(&env), INTERFACE_VERSION),
        }
    }

    /// Records a 0-100 score for `target`. Admin only.
    pub fn set_score(env: Env, target: Target, score: u32) {
        require_admin(&env);
        if score > MAX_SCORE {
            panic_with_error!(&env, OracleError::ScoreOutOfRange);
        }
        write(&env, target, Score::Scored(score));
    }

    /// Marks `target` as tracked but not yet scored. Admin only.
    pub fn set_pending(env: Env, target: Target) {
        require_admin(&env);
        write(&env, target, Score::Pending);
    }

    /// Removes any outcome for `target`, so it reads as `Unscored`. Admin only.
    pub fn clear_score(env: Env, target: Target) {
        require_admin(&env);
        validate_target(&env, &target);
        let key = DataKey::Entry(target.clone());
        env.storage().persistent().remove(&key);
        bump(&env, None);
        ScoreUpdated {
            target,
            score: Score::Unscored,
            sequence: env.ledger().sequence(),
        }
        .publish(&env);
    }

    pub fn admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("admin is set by the constructor")
    }

    /// Hands admin rights to `new_admin`. Requires the current admin's auth.
    pub fn set_admin(env: Env, new_admin: Address) {
        let previous = require_admin(&env);
        env.storage().instance().set(&DataKey::Admin, &new_admin);
        bump(&env, None);
        AdminChanged {
            previous,
            new_admin,
        }
        .publish(&env);
    }

    pub fn interface_version() -> u32 {
        INTERFACE_VERSION
    }
}

#[cfg(test)]
mod test;
