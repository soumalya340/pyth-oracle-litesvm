# pyth-oracle-litesvm

Solana program that reads a Pyth BTC/USD price feed, tested with LiteSVM instead of solana-test-validator.

## What it does

- Anchor program reads the Pyth BTC/USD push-oracle account and stores the price
- Tests fetch the live account from mainnet at runtime, inject it into LiteSVM, and run the program in-process
- No validator daemon. Tests finish in ~500ms.

## Run tests

```sh
anchor build
anchor test --skip-local-validator --skip-deploy
```

## Key idea

Instead of spinning up solana-test-validator, LiteSVM lets you:

```ts
// pull live account from mainnet
const accountInfo = await connection.getAccountInfo(BTC_USD_FEED);

// inject it into the in-process SVM
svm.setAccount(BTC_USD_FEED, { ...accountInfo });

// manipulate the clock freely
svm.setClock({ ...clock, unixTimestamp: BigInt(nowSec) });
```

## Stack

- Anchor 0.31
- LiteSVM 0.1.0
- Pyth legacy push-oracle (`GVXRSBjFk6e6J3NbVPXohDJetcTjaeeuykUpbQF8UoMU`)
