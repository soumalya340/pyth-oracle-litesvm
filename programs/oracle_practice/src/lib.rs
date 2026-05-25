use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::{get_feed_id_from_hex, PriceUpdateV2};

declare_id!("Hk8jBgzBYTpa9Qas9i2V8uLNm4fs9E57QLGsLqTbWZpR");

pub const CURRENT_PRICE_SEED: &[u8] = b"current_price";
pub const ANCHOR_DISCRIMINATOR: usize = 8;
/// Accept prices no older than 60 seconds.
pub const MAX_PRICE_AGE_SEC: u64 = 60;

#[program]
pub mod oracle_practice {
    use super::*;

    pub fn initialize(_ctx: Context<Initialize>) -> Result<()> {
        Ok(())
    }

    /// Reads the BTC/USD price from Pyth and saves it into the CurrentPrice account.
    pub fn get_btc_price(ctx: Context<GetBtcPrice>) -> Result<()> {
        let feed_id = get_feed_id_from_hex(
            "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
        )?;

        let price = ctx.accounts.btc_price_feed.get_price_no_older_than(
            &Clock::get()?,
            MAX_PRICE_AGE_SEC,
            &feed_id,
        )?;

        ctx.accounts.current_price.btc_price = whole_usd_from_pyth_price(&price)?;
        Ok(())
    }

    /// Reads the SOL/USD price from Pyth and saves it into the CurrentPrice account.
    pub fn get_sol_price(ctx: Context<GetSolPrice>) -> Result<()> {
        let feed_id = get_feed_id_from_hex(
            "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
        )?;

        let price = ctx.accounts.sol_price_feed.get_price_no_older_than(
            &Clock::get()?,
            MAX_PRICE_AGE_SEC,
            &feed_id,
        )?;

        ctx.accounts.current_price.sol_price = whole_usd_from_pyth_price(&price)?;
        Ok(())
    }

    /// Reads the ETH/USD price from Pyth and saves it into the CurrentPrice account.
    pub fn get_eth_price(ctx: Context<GetEthPrice>) -> Result<()> {
        let feed_id = get_feed_id_from_hex(
            "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
        )?;

        let price = ctx.accounts.eth_price_feed.get_price_no_older_than(
            &Clock::get()?,
            MAX_PRICE_AGE_SEC,
            &feed_id,
        )?;

        ctx.accounts.current_price.eth_price = whole_usd_from_pyth_price(&price)?;
        Ok(())
    }
}

/// Divide by 10^|exponent| to get the whole-dollar USD value.
/// e.g. price=7752876000000, exponent=-8 → 77528
fn whole_usd_from_pyth_price(
    price: &pyth_solana_receiver_sdk::price_update::Price,
) -> Result<u64> {
    require!(price.price > 0, OracleError::InvalidOraclePrice);

    let divisor = 10u64.pow(price.exponent.unsigned_abs());
    (price.price as u64)
        .checked_div(divisor)
        .ok_or(error!(OracleError::InvalidOraclePrice))
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub deployer: Signer<'info>,

    #[account(
        init,
        payer = deployer,
        space = ANCHOR_DISCRIMINATOR + CurrentPrice::INIT_SPACE,
        seeds = [CURRENT_PRICE_SEED, deployer.key().as_ref()],
        bump,
    )]
    pub current_price: Account<'info, CurrentPrice>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct GetBtcPrice<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [CURRENT_PRICE_SEED, user.key().as_ref()],
        bump,
    )]
    pub current_price: Account<'info, CurrentPrice>,

    pub btc_price_feed: Account<'info, PriceUpdateV2>,
}

#[derive(Accounts)]
pub struct GetSolPrice<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [CURRENT_PRICE_SEED, user.key().as_ref()],
        bump,
    )]
    pub current_price: Account<'info, CurrentPrice>,

    pub sol_price_feed: Account<'info, PriceUpdateV2>,
}

#[derive(Accounts)]
pub struct GetEthPrice<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(
        mut,
        seeds = [CURRENT_PRICE_SEED, user.key().as_ref()],
        bump,
    )]
    pub current_price: Account<'info, CurrentPrice>,

    pub eth_price_feed: Account<'info, PriceUpdateV2>,
}

#[account]
#[derive(InitSpace)]
pub struct CurrentPrice {
    pub btc_price: u64,
    pub sol_price: u64,
    pub eth_price: u64,
}

#[error_code]
pub enum OracleError {
    #[msg("Oracle price is invalid")]
    InvalidOraclePrice,
}
