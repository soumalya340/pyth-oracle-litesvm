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

// Canonical Pyth push-oracle PriceUpdateV2 accounts on mainnet (see Misc.md).
// Owned by the Pyth Receiver (rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ).
const BTC_USD_PUSH_FEED = new PublicKey(
  "4cSM2e6rvbGQUFiJbqytoVMi5GgghSMr8LwVrT9VPSPo",
);

const SOL_USD_PUSH_FEED = new PublicKey(
  "7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE", // Misc.md
);

const ETH_USD_PUSH_FEED = new PublicKey(
  "42amVS4KgzR9rA28tkVYqVXjq9Qa8dcZQMbH5EYFX6XC", // Misc.md
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

function readPriceUpdateFields(data: Buffer) {
  return {
    rawPrice: data.readBigInt64LE(73),
    expo: data.readInt32LE(89),
    publishTime: Number(data.readBigInt64LE(93)),
  };
}

function wholeUsd(rawPrice: bigint, expo: number): number {
  return Math.floor(Number(rawPrice) * Math.pow(10, expo));
}

async function cloneMainnetFeed(
  svm: LiteSVM,
  connection: Connection,
  feedAddress: PublicKey,
) {
  const accountInfo = await connection.getAccountInfo(feedAddress);
  if (!accountInfo) {
    throw new Error(
      `Pyth push feed not found on mainnet: ${feedAddress.toBase58()}`,
    );
  }

  const { rawPrice, expo, publishTime } = readPriceUpdateFields(
    Buffer.from(accountInfo.data),
  );

  svm.setAccount(feedAddress, {
    lamports: accountInfo.lamports,
    data: new Uint8Array(accountInfo.data),
    owner: accountInfo.owner,
    executable: accountInfo.executable,
  });

  const clock = svm.getClock();
  clock.unixTimestamp = BigInt(publishTime);
  svm.setClock(clock);

  return { rawPrice, expo, publishTime };
}

async function initializeCurrentPrice(
  svm: LiteSVM,
  program: Program<OraclePractice>,
  user: Keypair,
): Promise<void> {
  const initTx = (await program.methods
    .initialize()
    .accounts({ deployer: user.publicKey })
    .transaction()) as Transaction;
  sendTx(svm, initTx, [user]);
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
    const { rawPrice, expo } = await cloneMainnetFeed(
      svm,
      connection,
      BTC_USD_PUSH_FEED,
    );

    console.log(
      `Mainnet BTC/USD: raw=${rawPrice}, expo=${expo} => ~$${wholeUsd(
        rawPrice,
        expo,
      )}`,
    );

    await initializeCurrentPrice(svm, program, user);

    const priceTx = (await program.methods
      .getBtcPrice()
      .accounts({
        user: user.publicKey,
        btcPriceFeed: BTC_USD_PUSH_FEED,
      })
      .transaction()) as Transaction;

    sendTx(svm, priceTx, [user]);

    const raw = svm.getAccount(currentPricePda);
    expect(raw).to.not.be.null;

    const coder = new BorshAccountsCoder(OraclePracticeIDL as any);
    const decoded = coder.decode("CurrentPrice", Buffer.from(raw!.data));
    const storedPrice = decoded.btc_price.toNumber();
    const expectedWholeUsd = wholeUsd(rawPrice, expo);

    console.log(
      `stored BTC/USD price: $${storedPrice} (mainnet whole-dollar: $${expectedWholeUsd})`,
    );

    expect(storedPrice).to.be.greaterThan(1_000);
    expect(storedPrice).to.be.lessThan(10_000_000);
    expect(storedPrice).to.equal(expectedWholeUsd);
  });

  it("get_sol_price: reads SOL/USD price from cloned mainnet account", async () => {
    const { rawPrice, expo } = await cloneMainnetFeed(
      svm,
      connection,
      SOL_USD_PUSH_FEED,
    );

    console.log(
      `Mainnet SOL/USD: raw=${rawPrice}, expo=${expo} => ~$${wholeUsd(
        rawPrice,
        expo,
      )}`,
    );

    await initializeCurrentPrice(svm, program, user);

    const priceTx = (await program.methods
      .getSolPrice()
      .accounts({
        user: user.publicKey,
        solPriceFeed: SOL_USD_PUSH_FEED,
      })
      .transaction()) as Transaction;

    sendTx(svm, priceTx, [user]);

    const raw = svm.getAccount(currentPricePda);
    const coder = new BorshAccountsCoder(OraclePracticeIDL as any);
    const decoded = coder.decode("CurrentPrice", Buffer.from(raw!.data));
    const storedPrice = decoded.sol_price.toNumber();
    const expectedWholeUsd = wholeUsd(rawPrice, expo);

    console.log(
      `stored SOL/USD price: $${storedPrice} (mainnet whole-dollar: $${expectedWholeUsd})`,
    );

    expect(storedPrice).to.be.greaterThan(1);
    expect(storedPrice).to.be.lessThan(10_000);
    expect(storedPrice).to.equal(expectedWholeUsd);
  });

  it("get_eth_price: reads ETH/USD price from cloned mainnet account", async () => {
    const { rawPrice, expo } = await cloneMainnetFeed(
      svm,
      connection,
      ETH_USD_PUSH_FEED,
    );

    console.log(
      `Mainnet ETH/USD: raw=${rawPrice}, expo=${expo} => ~$${wholeUsd(
        rawPrice,
        expo,
      )}`,
    );

    await initializeCurrentPrice(svm, program, user);

    const priceTx = (await program.methods
      .getEthPrice()
      .accounts({
        user: user.publicKey,
        ethPriceFeed: ETH_USD_PUSH_FEED,
      })
      .transaction()) as Transaction;

    sendTx(svm, priceTx, [user]);

    const raw = svm.getAccount(currentPricePda);
    const coder = new BorshAccountsCoder(OraclePracticeIDL as any);
    const decoded = coder.decode("CurrentPrice", Buffer.from(raw!.data));
    const storedPrice = decoded.eth_price.toNumber();
    const expectedWholeUsd = wholeUsd(rawPrice, expo);

    console.log(
      `stored ETH/USD price: $${storedPrice} (mainnet whole-dollar: $${expectedWholeUsd})`,
    );

    expect(storedPrice).to.be.greaterThan(100);
    expect(storedPrice).to.be.lessThan(100_000);
    expect(storedPrice).to.equal(expectedWholeUsd);
  });
});
