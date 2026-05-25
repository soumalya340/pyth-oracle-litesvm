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

const CURRENT_PRICE_SEED = Buffer.from("current_price");

// Pyth Hermes REST endpoint — returns the latest signed price, no wallet needed
const HERMES_URL =
  "https://hermes.pyth.network/v2/updates/price/latest" +
  "?ids[]=e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";

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
    const disc = createHash("sha256")
      .update("account:PriceUpdateV2")
      .digest()
      .subarray(0, 8);

    const buf = Buffer.alloc(133);
    let off = 0;

    disc.copy(buf, off);
    off += 8;
    Buffer.alloc(32).copy(buf, off);
    off += 32; // write_authority (zero pubkey)
    buf.writeUInt8(1, off);
    off += 1; // VerificationLevel::Full
    feedId.copy(buf, off);
    off += 32; // feed_id
    buf.writeBigInt64LE(priceI64, off);
    off += 8;
    buf.writeBigUInt64LE(BigInt(0), off);
    off += 8; // conf
    buf.writeInt32LE(exponent, off);
    off += 4;
    buf.writeBigInt64LE(BigInt(publishTime), off);
    off += 8; // publish_time
    buf.writeBigInt64LE(BigInt(publishTime - 1), off);
    off += 8; // prev_publish_time
    buf.writeBigInt64LE(priceI64, off);
    off += 8; // ema_price
    buf.writeBigUInt64LE(BigInt(0), off);
    off += 8; // ema_conf
    buf.writeBigUInt64LE(BigInt(1), off); // posted_slot

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
    new Connection(clusterApiUrl("devnet")),
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
  it("initialize: creates the CurrentPrice account with btc_price = 0", async () => {
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
    console.log("btc_price after initialize:", decoded.btc_price.toString());
    expect(decoded.btc_price.toNumber()).to.equal(0);
  });

  // ── Test 2: live BTC/USD price via Pyth Hermes + PriceUpdateV2 ───────────
  // Fetches the real-time BTC/USD price from Pyth Hermes (REST, no wallet).
  // Builds a PriceUpdateV2 account in-memory and injects it into LiteSVM.
  // The Pyth receiver program itself is never executed — only its account
  // format and owner ID matter for the Anchor owner/discriminator checks.
  it("get_btc_price: reads live BTC/USD price from Pyth Hermes", async () => {
    // Step 1 — initialize the CurrentPrice PDA
    const initTx = (await program.methods
      .initialize()
      .accounts({ deployer: user.publicKey })
      .transaction()) as Transaction;
    sendTx(svm, initTx, [user]);

    // Step 2 — fetch live BTC/USD price from Pyth Hermes REST API
    const resp = await fetch(HERMES_URL);
    if (!resp.ok) throw new Error(`Hermes fetch failed: ${resp.status}`);
    const json = (await resp.json()) as any;
    const livePrice = json.parsed[0].price;

    const priceI64: bigint = BigInt(livePrice.price); // e.g. 7752876000000
    const exponent: number = livePrice.expo; // e.g. -8
    const publishTime: number = livePrice.publish_time;

    console.log(
      `Hermes BTC/USD: raw=${priceI64}, expo=${exponent} => ~$${Math.round(
        Number(priceI64) * Math.pow(10, exponent),
      )}`,
    );

    // Step 3 — build PriceUpdateV2 account bytes with the live price
    // Use an ephemeral keypair as the account address (we fully own the bytes)
    const feedKey = Keypair.generate();
    const accountData = buildPriceUpdateV2(
      BTC_USD_FEED_ID,
      priceI64,
      exponent,
      publishTime,
    );

    svm.setAccount(feedKey.publicKey, {
      lamports: 1_000_000_000,
      data: new Uint8Array(accountData),
      owner: PYTH_RECEIVER_PROGRAM_ID, // required for Anchor's Account<PriceUpdateV2> check
      executable: false,
    });

    // Step 4 — set SVM clock == publishTime so age = 0 (well within MAX_PRICE_AGE_SEC=60)
    const clock = svm.getClock();
    clock.unixTimestamp = BigInt(publishTime);
    svm.setClock(clock);

    // Step 5 — call get_btc_price
    const priceTx = (await program.methods
      .getBtcPrice()
      .accounts({
        user: user.publicKey,
        btcPriceFeed: feedKey.publicKey,
      })
      .transaction()) as Transaction;

    sendTx(svm, priceTx, [user]);

    // Step 6 — read back the stored whole-dollar price via BorshAccountsCoder
    const raw = svm.getAccount(currentPricePda);
    expect(raw).to.not.be.null;

    const coder = new BorshAccountsCoder(OraclePracticeIDL as any);
    const decoded = coder.decode("CurrentPrice", Buffer.from(raw!.data));
    const storedPrice = decoded.btc_price.toNumber();

    const expectedWholeUsd = Math.floor(
      Number(priceI64) * Math.pow(10, exponent),
    );
    console.log(
      `stored BTC/USD price: $${storedPrice} (Hermes whole-dollar: $${expectedWholeUsd})`,
    );

    expect(storedPrice).to.be.greaterThan(1_000);
    expect(storedPrice).to.be.lessThan(10_000_000);
    expect(storedPrice).to.equal(expectedWholeUsd);
  });
});
