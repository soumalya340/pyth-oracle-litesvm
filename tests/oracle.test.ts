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
import { createHash } from "crypto";
import path from "path";
import { expect } from "chai";
import OraclePracticeIDL from "../target/idl/oracle_practice.json";
import { OraclePractice } from "../target/types/oracle_practice";

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────
const PROGRAM_ID = new PublicKey(OraclePracticeIDL.address);

// Pyth Solana Receiver program — owner of every PriceUpdateV2 account on-chain.
// Anchor's Account<PriceUpdateV2> checks this automatically.
const PYTH_RECEIVER_PROGRAM_ID = new PublicKey(
  "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ",
);

// BTC/USD Pyth feed ID (32 raw bytes) — same value hard-coded in lib.rs
const BTC_USD_FEED_ID = Buffer.from(
  "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  "hex",
);

const SOL_USD_FEED_ID = Buffer.from(
  "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  "hex",
);

const ETH_USD_FEED_ID = Buffer.from(
  "ff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  "hex",
);

const CURRENT_PRICE_SEED = Buffer.from("current_price");

function hermesUrl(feedIdHex: string): string {
  return `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${feedIdHex}`;
}

// ─────────────────────────────────────────────
// PriceUpdateV2 mock builder
// ─────────────────────────────────────────────
// Binary layout (Anchor/Borsh, 133 bytes):
//   [0..8]     discriminator = sha256("account:PriceUpdateV2")[0..8]
//   [8..40]    write_authority: Pubkey (32 bytes, zeroed)
//   [40]       verification_level: u8  (1 = Full)
//   [41..73]   feed_id: [u8; 32]
//   [73..81]   price: i64 LE
//   [81..89]   conf: u64 LE
//   [89..93]   exponent: i32 LE
//   [93..101]  publish_time: i64 LE      ← must be within MAX_PRICE_AGE_SEC of SVM clock
//   [101..109] prev_publish_time: i64 LE
//   [109..117] ema_price: i64 LE
//   [117..125] ema_conf: u64 LE
//   [125..133] posted_slot: u64 LE
function buildPriceUpdateV2(
  feedId: Buffer,
  priceI64: bigint,
  exponent: number,
  publishTime: number,
): Buffer {
  const buf = Buffer.alloc(133); // zeros fill: write_authority, conf, prev_publish_time, ema_*, posted_slot

  createHash("sha256").update("account:PriceUpdateV2").digest().copy(buf, 0, 0, 8);
  buf.writeUInt8(1, 40);                        // VerificationLevel::Full
  feedId.copy(buf, 41);                         // feed_id
  buf.writeBigInt64LE(priceI64, 73);            // price
  buf.writeInt32LE(exponent, 89);               // exponent
  buf.writeBigInt64LE(BigInt(publishTime), 93); // publish_time

  return buf;
}

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

async function fetchHermesPrice(feedIdHex: string) {
  const resp = await fetch(hermesUrl(feedIdHex));
  if (!resp.ok) throw new Error(`Hermes fetch failed: ${resp.status}`);
  const json = (await resp.json()) as any;
  const livePrice = json.parsed[0].price;
  return {
    priceI64: BigInt(livePrice.price) as bigint,
    exponent: livePrice.expo as number,
    publishTime: livePrice.publish_time as number,
  };
}

function injectPriceFeed(
  svm: LiteSVM,
  feedId: Buffer,
  priceI64: bigint,
  exponent: number,
  publishTime: number,
): PublicKey {
  const feedKey = Keypair.generate();
  const accountData = buildPriceUpdateV2(
    feedId,
    priceI64,
    exponent,
    publishTime,
  );

  svm.setAccount(feedKey.publicKey, {
    lamports: 1_000_000_000,
    data: new Uint8Array(accountData),
    owner: PYTH_RECEIVER_PROGRAM_ID,
    executable: false,
  });

  const clock = svm.getClock();
  clock.unixTimestamp = BigInt(publishTime);
  svm.setClock(clock);

  return feedKey.publicKey;
}

function wholeUsd(priceI64: bigint, exponent: number): number {
  return Math.floor(Number(priceI64) * Math.pow(10, exponent));
}

// ─────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────
describe("oracle_practice", () => {
  let svm: LiteSVM;
  let user: Keypair;
  let program: Program<OraclePractice>;
  let currentPricePda: PublicKey;

  beforeEach(() => {
    svm = startSvm();
    user = Keypair.generate();
    svm.airdrop(user.publicKey, BigInt(10_000_000_000));
    currentPricePda = findCurrentPricePda(user.publicKey);
    program = createProgram();
  });

  // ── Test 1: initialize ────────────────────────────────────────────────────
  it("initialize: creates the CurrentPrice account with all prices = 0", async () => {
    const tx = (await program.methods
      .initialize()
      .accounts({ deployer: user.publicKey })
      .transaction()) as Transaction;

    sendTx(svm, tx, [user]);

    const raw = svm.getAccount(currentPricePda);
    expect(raw).to.not.be.null;

    const coder = new BorshAccountsCoder(OraclePracticeIDL as any);
    const decoded = coder.decode("CurrentPrice", Buffer.from(raw!.data));
    console.log("Decoded Value :", decoded);
    expect(decoded.btc_price.toNumber()).to.equal(0);
    expect(decoded.sol_price.toNumber()).to.equal(0);
    expect(decoded.eth_price.toNumber()).to.equal(0);
  });

  // ── Test 2: live BTC/USD price via Pyth Hermes + PriceUpdateV2 ───────────
  // Fetches the real-time BTC/USD price from Pyth Hermes (REST, no wallet).
  // Builds a PriceUpdateV2 account in-memory and injects it into LiteSVM.
  // The Pyth receiver program itself is never executed — only its account
  // format and owner ID matter for the Anchor owner/discriminator checks.
  it("get_btc_price: reads live BTC/USD price from Pyth Hermes", async () => {
    const initTx = (await program.methods
      .initialize()
      .accounts({ deployer: user.publicKey })
      .transaction()) as Transaction;
    sendTx(svm, initTx, [user]);

    const { priceI64, exponent, publishTime } = await fetchHermesPrice(
      BTC_USD_FEED_ID.toString("hex"),
    );

    console.log(
      `Hermes BTC/USD: raw=${priceI64}, expo=${exponent} => ~$${wholeUsd(
        priceI64,
        exponent,
      )}`,
    );

    const feedKey = injectPriceFeed(
      svm,
      BTC_USD_FEED_ID,
      priceI64,
      exponent,
      publishTime,
    );

    const priceTx = (await program.methods
      .getBtcPrice()
      .accounts({
        user: user.publicKey,
        btcPriceFeed: feedKey,
      })
      .transaction()) as Transaction;

    sendTx(svm, priceTx, [user]);

    const raw = svm.getAccount(currentPricePda);
    expect(raw).to.not.be.null;

    const coder = new BorshAccountsCoder(OraclePracticeIDL as any);
    const decoded = coder.decode("CurrentPrice", Buffer.from(raw!.data));
    const storedPrice = decoded.btc_price.toNumber();
    const expectedWholeUsd = wholeUsd(priceI64, exponent);

    console.log(
      `stored BTC/USD price: $${storedPrice} (Hermes whole-dollar: $${expectedWholeUsd})`,
    );

    expect(storedPrice).to.be.greaterThan(1_000);
    expect(storedPrice).to.be.lessThan(10_000_000);
    expect(storedPrice).to.equal(expectedWholeUsd);
  });

  it("get_sol_price: reads live SOL/USD price from Pyth Hermes", async () => {
    const initTx = (await program.methods
      .initialize()
      .accounts({ deployer: user.publicKey })
      .transaction()) as Transaction;
    sendTx(svm, initTx, [user]);

    const { priceI64, exponent, publishTime } = await fetchHermesPrice(
      SOL_USD_FEED_ID.toString("hex"),
    );

    console.log(
      `Hermes SOL/USD: raw=${priceI64}, expo=${exponent} => ~$${wholeUsd(
        priceI64,
        exponent,
      )}`,
    );

    const feedKey = injectPriceFeed(
      svm,
      SOL_USD_FEED_ID,
      priceI64,
      exponent,
      publishTime,
    );

    const priceTx = (await program.methods
      .getSolPrice()
      .accounts({
        user: user.publicKey,
        solPriceFeed: feedKey,
      })
      .transaction()) as Transaction;

    sendTx(svm, priceTx, [user]);

    const raw = svm.getAccount(currentPricePda);
    const coder = new BorshAccountsCoder(OraclePracticeIDL as any);
    const decoded = coder.decode("CurrentPrice", Buffer.from(raw!.data));
    const storedPrice = decoded.sol_price.toNumber();
    const expectedWholeUsd = wholeUsd(priceI64, exponent);

    console.log(
      `stored SOL/USD price: $${storedPrice} (Hermes whole-dollar: $${expectedWholeUsd})`,
    );

    expect(storedPrice).to.be.greaterThan(1);
    expect(storedPrice).to.be.lessThan(10_000);
    expect(storedPrice).to.equal(expectedWholeUsd);
  });

  it("get_eth_price: reads live ETH/USD price from Pyth Hermes", async () => {
    const initTx = (await program.methods
      .initialize()
      .accounts({ deployer: user.publicKey })
      .transaction()) as Transaction;
    sendTx(svm, initTx, [user]);

    const { priceI64, exponent, publishTime } = await fetchHermesPrice(
      ETH_USD_FEED_ID.toString("hex"),
    );

    console.log(
      `Hermes ETH/USD: raw=${priceI64}, expo=${exponent} => ~$${wholeUsd(
        priceI64,
        exponent,
      )}`,
    );

    const feedKey = injectPriceFeed(
      svm,
      ETH_USD_FEED_ID,
      priceI64,
      exponent,
      publishTime,
    );

    const priceTx = (await program.methods
      .getEthPrice()
      .accounts({
        user: user.publicKey,
        ethPriceFeed: feedKey,
      })
      .transaction()) as Transaction;

    sendTx(svm, priceTx, [user]);

    const raw = svm.getAccount(currentPricePda);
    const coder = new BorshAccountsCoder(OraclePracticeIDL as any);
    const decoded = coder.decode("CurrentPrice", Buffer.from(raw!.data));
    const storedPrice = decoded.eth_price.toNumber();
    const expectedWholeUsd = wholeUsd(priceI64, exponent);

    console.log(
      `stored ETH/USD price: $${storedPrice} (Hermes whole-dollar: $${expectedWholeUsd})`,
    );

    expect(storedPrice).to.be.greaterThan(100);
    expect(storedPrice).to.be.lessThan(100_000);
    expect(storedPrice).to.equal(expectedWholeUsd);
  });
});
