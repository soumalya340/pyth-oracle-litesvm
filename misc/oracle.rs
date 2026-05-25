use std::mem::size_of;

use anchor_lang::prelude::*;
use bytemuck::{try_from_bytes, Pod, Zeroable};



/// Pyth prices are normalized to 1e9 fixed-point precision inside the program.
pub const ORACLE_PRICE_SCALE: u128 = 1_000_000_000;

/// Internal exponent associated with ORACLE_PRICE_SCALE.
pub const ORACLE_TARGET_EXPONENT: i32 = -9;

/// Pyth account discriminator used to validate raw account data.
const PYTH_MAGIC: u32 = 0xa1b2c3d4;
/// Supported Pyth account version for the embedded layout below.
const PYTH_VERSION_2: u32 = 2;
/// Pyth account type value representing a price account.
const PYTH_ACCOUNT_TYPE_PRICE: u32 = 3;
/// Pyth status value meaning the aggregate price is actively trading.
const PYTH_STATUS_TRADING: u8 = 1;
/// Number of component publisher slots stored in a legacy Pyth price account.
const PYTH_NUM_COMPONENTS: usize = 32;

// Pyth oracle helpers used to enforce peg protection and normalize prices.
//
// This module handles reading prices from Pyth Network oracles for depegging
// detection. Pyth is a decentralized oracle network that publishes prices from
// trusted data sources.
//
// WHY USE ORACLES?
//
// The AMM only knows its internal pool prices, which come from reserve ratios.
// External market prices can differ, especially during a depeg event.
// Oracles tell us what the "real world" price is, so the program can detect
// when one of the assets is no longer behaving like a stablecoin.
//
// PYTH BASICS
//
// Each asset has a price feed account on Solana.
// That account contains:
// - price
// - confidence interval
// - exponent
// - timestamp
//
// Pyth stores prices as integers with an exponent. For example:
// - `99_850_000` with exponent `-8` represents `0.99850000`
//
// This module reads those raw values, validates that the account really is a
// Pyth price account, checks that the data is fresh enough, and then normalizes
// the result into the program's shared fixed-point scale before depeg checks.

fn load_scaled_price(price_account_info: &AccountInfo, max_price_age_sec: u64) -> Result<u128> {
    let clock = Clock::get()?;
    let price_account = load_price_account(price_account_info)?;
    let price = select_recent_price(&price_account, clock.unix_timestamp, max_price_age_sec)?;

    scale_price(price.price, price_account.expo)
}

/// Parse a raw account into the embedded Pyth price-account layout.
fn load_price_account(price_account_info: &AccountInfo) -> Result<PythPriceAccount> {
    let data = price_account_info
        .try_borrow_data()
        .map_err(|_| error!(StableSwapError::InvalidOracleAccount))?;
    let bytes = data
        .get(..size_of::<PythPriceAccount>())
        .ok_or_else(|| error!(StableSwapError::InvalidOracleAccount))?;
    let price_account = *try_from_bytes::<PythPriceAccount>(bytes)
        .map_err(|_| error!(StableSwapError::InvalidOracleAccount))?;

    require!(
        price_account.magic == PYTH_MAGIC,
        StableSwapError::InvalidOracleAccount
    );
    require!(
        price_account.ver == PYTH_VERSION_2,
        StableSwapError::InvalidOracleAccount
    );
    require!(
        price_account.atype == PYTH_ACCOUNT_TYPE_PRICE,
        StableSwapError::InvalidOracleAccount
    );

    Ok(price_account)
}

/// Select the newest usable price from the account and enforce freshness.
fn select_recent_price(
    price_account: &PythPriceAccount,
    current_time: i64,
    max_price_age_sec: u64,
) -> Result<PythPrice> {
    let aggregate_price = if price_account.agg.status == PYTH_STATUS_TRADING {
        PythPrice {
            price: price_account.agg.price,
            publish_time: price_account.timestamp,
        }
    } else {
        PythPrice {
            price: price_account.prev_price,
            publish_time: price_account.prev_timestamp,
        }
    };

    let age = aggregate_price.publish_time.abs_diff(current_time);
    require!(age <= max_price_age_sec, StableSwapError::StaleOraclePrice);
    require!(
        aggregate_price.price > 0,
        StableSwapError::InvalidOraclePrice
    );

    Ok(aggregate_price)
}

/// Normalize a Pyth fixed-point price to the program's 1e9 precision.
fn scale_price(price: i64, exponent: i32) -> Result<u128> {
    require!(price > 0, StableSwapError::InvalidOraclePrice);

    let mut normalized = price as u128;

    if exponent > ORACLE_TARGET_EXPONENT {
        let scale = pow10((exponent - ORACLE_TARGET_EXPONENT) as u32)?;
        normalized = normalized
            .checked_mul(scale)
            .ok_or(StableSwapError::MathOverflow)?;
    } else if exponent < ORACLE_TARGET_EXPONENT {
        let scale = pow10((ORACLE_TARGET_EXPONENT - exponent) as u32)?;
        normalized = normalized
            .checked_div(scale)
            .ok_or(StableSwapError::InvalidOraclePrice)?;
    }

    Ok(normalized)
}

/// Compute `10^exponent` using checked integer arithmetic.
fn pow10(exponent: u32) -> Result<u128> {
    let mut value = 1u128;
    for _ in 0..exponent {
        value = value.checked_mul(10).ok_or(StableSwapError::MathOverflow)?;
    }
    Ok(value)
}

/// Lightweight selected Pyth price used after freshness validation.
#[derive(Debug, Clone, Copy)]
struct PythPrice {
    /// Raw price value reported by Pyth.
    price: i64,
    /// Publish time associated with `price`.
    publish_time: i64,
}

/// Minimal in-program representation of Pyth's `PriceInfo` struct.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Pod, Zeroable)]
struct PythPriceInfo {
    /// Aggregate or publisher price value.
    price: i64,
    /// Confidence interval around `price`.
    conf: u64,
    /// Pyth status enum encoded as a byte.
    status: u8,
    /// Corporate action flag from Pyth.
    corp_act: u8,
    /// Padding bytes required by the canonical account layout.
    padding: [u8; 6],
    /// Slot in which the price was published.
    pub_slot: u64,
}

/// Minimal representation of Pyth's rational EMA fields.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Pod, Zeroable)]
struct PythRational {
    /// Pre-computed integer value for convenience.
    val: i64,
    /// Rational numerator.
    numer: i64,
    /// Rational denominator.
    denom: i64,
}

/// Single publisher contribution entry inside the Pyth price account.
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, Pod, Zeroable)]
struct PythPriceComp {
    /// Publisher authority key.
    publisher: Pubkey,
    /// Price contribution used in the current aggregate.
    agg: PythPriceInfo,
    /// Publisher's latest unpublished contribution.
    latest: PythPriceInfo,
}

/// Legacy Solana Pyth price account layout parsed directly from account data.
#[repr(C)]
#[derive(Clone, Copy, Debug, Pod, Zeroable)]
struct PythPriceAccount {
    /// Magic header for account validation.
    magic: u32,
    /// Pyth version number.
    ver: u32,
    /// Pyth account type discriminator.
    atype: u32,
    /// Serialized size recorded by the account itself.
    size: u32,
    /// Price type discriminator.
    ptype: u32,
    /// Base-10 exponent used by all price values in this account.
    expo: i32,
    /// Number of active component prices.
    num: u32,
    /// Number of component prices included in the aggregate.
    num_qt: u32,
    /// Last slot with a valid aggregate.
    last_slot: u64,
    /// Slot threshold used by Pyth for validity.
    valid_slot: u64,
    /// EMA price.
    ema_price: PythRational,
    /// EMA confidence.
    ema_conf: PythRational,
    /// Publish timestamp for the aggregate.
    timestamp: i64,
    /// Minimum publishers required for validity.
    min_pub: u8,
    /// Reserved field from the canonical layout.
    drv2: u8,
    /// Reserved field from the canonical layout.
    drv3: u16,
    /// Reserved field from the canonical layout.
    drv4: u32,
    /// Linked product account.
    prod: Pubkey,
    /// Linked next price account.
    next: Pubkey,
    /// Previous valid slot.
    prev_slot: u64,
    /// Previous valid trading price.
    prev_price: i64,
    /// Previous valid confidence.
    prev_conf: u64,
    /// Previous valid publish timestamp.
    prev_timestamp: i64,
    /// Current aggregate price info.
    agg: PythPriceInfo,
    /// Per-publisher contributions.
    comp: [PythPriceComp; PYTH_NUM_COMPONENTS],
}

#[error_code]
pub enum StableSwapError {
    #[msg("Math overflow")]
    MathOverflow,

    #[msg("Invalid oracle account")]
    InvalidOracleAccount,

    #[msg("Oracle price is stale")]
    StaleOraclePrice,

    #[msg("Oracle price is invalid")]
    InvalidOraclePrice,
}
