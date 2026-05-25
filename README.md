# oracle-practice

Anchor program that reads Pyth **BTC/USD**, **SOL/USD**, and **ETH/USD** prices and stores whole-dollar USD values in a `CurrentPrice` PDA. Tests run with **LiteSVM** (in-process) instead of `solana-test-validator`.

## What it does

| Instruction | Description |
|-------------|-------------|
| `initialize` | Creates a per-user `CurrentPrice` PDA (`btc_price`, `sol_price`, `eth_price` — all start at 0) |
| `get_btc_price` | Reads a Pyth `PriceUpdateV2` account and stores BTC/USD |
| `get_sol_price` | Reads a Pyth `PriceUpdateV2` account and stores SOL/USD |
| `get_eth_price` | Reads a Pyth `PriceUpdateV2` account and stores ETH/USD |

Prices must be no older than **60 seconds** (`MAX_PRICE_AGE_SEC`). Exponent is applied on-chain to produce a whole-dollar `u64` (e.g. `7752876000000` at expo `-8` → `$77528`).

## Run tests

Build the program first, then run either test suite:

```sh
anchor build

# Fake PriceUpdateV2 accounts + live Hermes prices (no mainnet RPC for feeds)
yarn test:litesvm_test1

# Clone real mainnet PriceUpdateV2 account bytes via RPC (like --clone)
yarn test:litesvm_test2
```

Both suites finish in ~1–2s. No validator daemon required.

## Two testing strategies

### 1. Hermes + fake account (`tests/oracle.test.ts`)

```
Hermes REST API → buildPriceUpdateV2() → svm.setAccount() → get_*_price
```

- Fetches live prices from [Pyth Hermes](https://hermes.pyth.network)
- Builds mock `PriceUpdateV2` bytes in TypeScript and injects them into LiteSVM
- Uses a random keypair as the feed address — good for testing your **consumer** logic quickly

### 2. Cloned mainnet accounts (`tests/oracle_live_accounts.test.ts`)

```
mainnet RPC → getAccountInfo(feed) → svm.setAccount() → get_*_price
```

- Pulls real on-chain account bytes from mainnet (same idea as `solana-test-validator --clone`)
- Uses canonical Pyth push feed addresses at the real pubkeys
- Syncs LiteSVM clock to the account's `publish_time` so the age check passes

## Mainnet Pyth push feed addresses

See [Misc.md](./Misc.md) for SOL/ETH. BTC push feed:

| Pair | Mainnet account |
|------|-----------------|
| BTC/USD | `4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo` |
| SOL/USD | `7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE` |
| ETH/USD | `42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC` |

Accounts are owned by the Pyth Solana Receiver (`rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ`).

## Key idea

LiteSVM runs your compiled `.so` locally. You seed oracle state yourself instead of forking a validator:

```ts
// clone-style: pull live account from mainnet
const accountInfo = await connection.getAccountInfo(BTC_USD_PUSH_FEED);
svm.setAccount(BTC_USD_PUSH_FEED, { ...accountInfo });

// fake-style: inject hand-built PriceUpdateV2 bytes
svm.setAccount(feedKey.publicKey, {
  data: buildPriceUpdateV2(feedId, price, expo, publishTime),
  owner: PYTH_RECEIVER_PROGRAM_ID,
  ...
});

// warp clock so get_price_no_older_than passes
svm.setClock({ ...clock, unixTimestamp: BigInt(publishTime) });
```

Your program executes for real inside LiteSVM — only the **oracle account source** differs between the two test files.

## Stack

- Anchor 0.31
- LiteSVM 0.1.0
- Pyth Solana Receiver SDK (`PriceUpdateV2`)
- TypeScript + ts-mocha

## Related docs

- [Misc.md](./Misc.md) — mainnet SOL/USD and ETH/USD feed addresses
