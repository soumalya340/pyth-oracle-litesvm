import {
  AnchorProvider,
  BorshAccountsCoder,
  Program,
  Wallet,
} from "@coral-xyz/anchor";
import {
  clusterApiUrl,
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  FailedTransactionMetadata,
  LiteSVM,
  TransactionMetadata,
} from "litesvm";
import path from "path";
import { expect } from "chai";
import OraclePracticeIDL from "../target/idl/oracle_practice.json";
import { OraclePractice } from "../target/types/oracle_practice";

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
const PROGRAM_ID = new PublicKey(OraclePracticeIDL.address);

const CURRENT_PRICE_SEED = Buffer.from("current_price");

// Canonical Pyth push-oracle BTC/USD account on mainnet.
// Derived by the pyth-push-oracle program (pythWSnswVUd12oZpeFP8e9CVaEqJg25g1Vtc2biRsT)
// using seeds = [shard_id=0 (2 bytes LE), feed_id (32 bytes)].
// Owned by the Pyth Receiver (rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ),
// continuously updated on-chain, and accepted by Anchor's Account<PriceUpdateV2>.
const BTC_USD_PUSH_FEED = new PublicKey(
  "4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo",
);

// ─────────────────────────────────────────────
// SVM helpers
// ─────────────────────────────────────────────
function startSvm(): LiteSVM {
  const svm = new LiteSVM();
  svm.addProgramFromFile(
    PROGRAM_ID,
    path.resolve("./target/deploy/oracle_practice.so"),
  );
  return svm;
}

// Program object is only used for IDL/type resolution; actual execution is via LiteSVM.
function createProgram(): Program<OraclePractice> {
  const wallet = new Wallet(Keypair.generate());
  const provider = new AnchorProvider(
    new Connection(clusterApiUrl("mainnet-beta")),
    wallet,
    {},
  );
  return new Program<OraclePractice>(
    OraclePracticeIDL as OraclePractice,
    provider,
  );
}

function sendTx(
  svm: LiteSVM,
  tx: Transaction,
  signers: Keypair[],
): TransactionMetadata {
  tx.recentBlockhash = svm.latestBlockhash();
  tx.sign(...signers);
  const result = svm.sendTransaction(tx);
  svm.expireBlockhash();
  if (result instanceof FailedTransactionMetadata) {
    throw new Error(result.meta().logs().join("\n"));
  }
  return result;
}

function findCurrentPricePda(user: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [CURRENT_PRICE_SEED, user.toBuffer()],
    PROGRAM_ID,
  );
  return pda;
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────
describe("oracle_live_accounts", () => {
  let svm: LiteSVM;
  let user: Keypair;
  let program: Program<OraclePractice>;
  let currentPricePda: PublicKey;
  let connection: Connection;

  beforeEach(() => {
    svm = startSvm();
    user = Keypair.generate();
    svm.airdrop(user.publicKey, BigInt(10_000_000_000));
    currentPricePda = findCurrentPricePda(user.publicKey);
    program = createProgram();
    connection = new Connection(clusterApiUrl("mainnet-beta"));
  });

  // ── Test 1: cloned mainnet account ────────────────────────────────────────
  // Fetches the real PriceUpdateV2 account bytes from mainnet — the same bytes
  // written by the actual Pyth Receiver program after guardian verification.
  // Injects them into LiteSVM at the canonical feed address (identical to
  // `solana-test-validator --clone`). The SVM clock is synced to the account's
  // publish_time so the MAX_PRICE_AGE_SEC=60 check passes.
  it("get_btc_price: reads BTC/USD price from cloned mainnet account", async () => {
    // Step 1 — fetch the real PriceUpdateV2 account bytes from mainnet
    const accountInfo = await connection.getAccountInfo(BTC_USD_PUSH_FEED);
    if (!accountInfo)
      throw new Error("Pyth BTC/USD push feed not found on mainnet");

    // Read publish_time from offset 93 (i64 LE) — needed to sync the SVM clock
    const publishTime = Number(
      Buffer.from(accountInfo.data).readBigInt64LE(93),
    );

    // Read price and exponent for logging
    const rawPrice = Buffer.from(accountInfo.data).readBigInt64LE(73);
    const expo = Buffer.from(accountInfo.data).readInt32LE(89);
    console.log(
      `Mainnet BTC/USD: raw=${rawPrice}, expo=${expo} => ~$${Math.floor(
        Number(rawPrice) * Math.pow(10, expo),
      )}`,
    );

    // Step 2 — inject the real account bytes into LiteSVM at the canonical address.
    // This is the LiteSVM equivalent of `solana-test-validator --clone <address>`.
    svm.setAccount(BTC_USD_PUSH_FEED, {
      lamports: accountInfo.lamports,
      data: new Uint8Array(accountInfo.data),
      owner: accountInfo.owner,
      executable: accountInfo.executable,
    });

    // Step 3 — sync SVM clock to publish_time so age = 0 (within MAX_PRICE_AGE_SEC=60)
    const clock = svm.getClock();
    clock.unixTimestamp = BigInt(publishTime);
    svm.setClock(clock);

    // Step 4 — initialize the CurrentPrice PDA
    const initTx = (await program.methods
      .initialize()
      .accounts({ deployer: user.publicKey })
      .transaction()) as Transaction;
    sendTx(svm, initTx, [user]);

    // Step 5 — call get_btc_price passing the canonical feed address
    const priceTx = (await program.methods
      .getBtcPrice()
      .accounts({
        user: user.publicKey,
        btcPriceFeed: BTC_USD_PUSH_FEED,
      })
      .transaction()) as Transaction;

    sendTx(svm, priceTx, [user]);

    // Step 6 — decode and verify the stored whole-dollar price
    const raw = svm.getAccount(currentPricePda);
    expect(raw).to.not.be.null;

    const coder = new BorshAccountsCoder(OraclePracticeIDL as any);
    const decoded = coder.decode("CurrentPrice", Buffer.from(raw!.data));
    const storedPrice = decoded.btc_price.toNumber();

    const expectedWholeUsd = Math.floor(Number(rawPrice) * Math.pow(10, expo));
    console.log(
      `stored BTC/USD price: $${storedPrice} (mainnet whole-dollar: $${expectedWholeUsd})`,
    );

    expect(storedPrice).to.be.greaterThan(1_000);
    expect(storedPrice).to.be.lessThan(10_000_000);
    expect(storedPrice).to.equal(expectedWholeUsd);
  });
});
