import { noteId as rustNoteId } from "@0xcurvy/rs-core-wasm/core";
import {
  type Address,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  type Hex,
  type Log,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
  zeroHash,
} from "viem";
import { isAddressEqual } from "viem/utils";
import { aggregatorAbi, portalFactoryAbi, vaultAbi } from "../contracts";
import { ensureRustCore } from "../merchant/internal/rustCore";
import type { PaymentVerifyClient } from "../merchant/verifyPayment";

export const CHAIN_ID = 31_337;
export const TOKEN = getAddress("0x0000000000000000000000000000000000000003");
export const OTHER_TOKEN = getAddress("0x0000000000000000000000000000000000000013");
export const AGGREGATOR = getAddress("0x0000000000000000000000000000000000000004");
export const OTHER = getAddress("0x0000000000000000000000000000000000000005");
export const VAULT = getAddress("0x0000000000000000000000000000000000000007");
export const PORTAL_FACTORY = getAddress("0x0000000000000000000000000000000000000006");
export const PORTAL = getAddress("0x00000000000000000000000000000000000000A1");
export const RECOVERY = getAddress("0x00000000000000000000000000000000000000B2");
export const RECIPIENT = {
  S: "18841156662615403723520443807716409278140486251221355574263061434503921265588.98357793752770194678499426326386336085357653965912017495890904868125096440617",
  V: "1760020198064161165795911805578555709740706783603233189380229091027759021973.19520756004562638043874842910851983303596751292314679321770725659462577589821",
  babyJubjubPublicKey:
    "5509359784107808046541889973707062912186356978136525798140528612444721440004.5125768395023217094469327424244994953312297627197683956739233494456001838760",
};

/** Vault token ids and fees the mocked chain reports. */
export const TOKEN_ID = 2n;
export const OTHER_TOKEN_ID = 3n;
export const DEPOSIT_FEE_BPS = 10n;
export const PENDING_NOTE_COMMITMENT_FEE = 50n;
export const PORTAL_DEPLOYMENT_FEE = 200n;

export function txHashOf(byte: string): Hex {
  return `0x${byte.repeat(32)}`;
}

/** rs-core noteId, the same Poseidon(ownerHash, netAmount, token) the aggregator emits. */
export async function computeNoteId(ownerHash: bigint | string, amount: bigint, token: bigint): Promise<bigint> {
  await ensureRustCore();
  return BigInt(rustNoteId(BigInt(ownerHash).toString(), amount.toString(), token.toString()));
}

export interface PendingSlot {
  noteId: bigint;
  ephemeralKey: readonly [bigint, bigint];
  viewTag: number;
  token: bigint;
  amount: bigint;
  isPlaintext?: boolean;
}

interface LogLocation {
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex?: number;
}

export function pendingNotesLog(address: Address, slots: readonly PendingSlot[], location: LogLocation): Log {
  return {
    address,
    blockHash: zeroHash,
    blockNumber: location.blockNumber,
    data: encodeAbiParameters(
      [
        { type: "uint256[]" },
        { type: "uint256[][2]" },
        { type: "uint16[]" },
        { type: "uint256[]" },
        { type: "uint256[]" },
        { type: "bool[]" },
      ],
      [
        slots.map((slot) => slot.noteId),
        [slots.map((slot) => slot.ephemeralKey[0]), slots.map((slot) => slot.ephemeralKey[1])],
        slots.map((slot) => slot.viewTag),
        slots.map((slot) => slot.token),
        slots.map((slot) => slot.amount),
        slots.map((slot) => slot.isPlaintext ?? true),
      ],
    ),
    logIndex: location.logIndex ?? 0,
    removed: false,
    topics: encodeEventTopics({ abi: aggregatorAbi, eventName: "PendingNotes" }) as [Hex, ...Hex[]],
    transactionHash: location.transactionHash,
    transactionIndex: 0,
  };
}

export function shieldPortalDeployedLog(address: Address, ownerHash: bigint | string, location: LogLocation): Log {
  return {
    address,
    blockHash: zeroHash,
    blockNumber: location.blockNumber,
    data: "0x",
    logIndex: location.logIndex ?? 1,
    removed: false,
    topics: encodeEventTopics({
      abi: portalFactoryAbi,
      eventName: "ShieldPortalDeployed",
      args: { portalAddress: PORTAL, ownerHash: BigInt(ownerHash), recovery: RECOVERY },
    }) as [Hex, ...Hex[]],
    transactionHash: location.transactionHash,
    transactionIndex: 0,
  };
}

export function committedNotesLog(address: Address, noteIds: readonly bigint[], location: LogLocation): Log {
  return {
    address,
    blockHash: zeroHash,
    blockNumber: location.blockNumber,
    data: encodeAbiParameters([{ type: "uint256[]" }], [noteIds]),
    logIndex: location.logIndex ?? 0,
    removed: false,
    topics: encodeEventTopics({
      abi: aggregatorAbi,
      eventName: "CommittedNotes",
      args: { batchIndex: 1n },
    }) as [Hex, ...Hex[]],
    transactionHash: location.transactionHash,
    transactionIndex: 0,
  };
}

export interface MockReceipt {
  transactionHash: Hex;
  blockNumber: bigint;
  status: "success" | "reverted";
  logs: Log[];
}

export function receiptOf(
  transactionHash: Hex,
  blockNumber: bigint,
  logs: Log[],
  status: MockReceipt["status"] = "success",
) {
  return { transactionHash, blockNumber, status, logs };
}

export interface MockChain {
  chainId?: number;
  latestBlock?: bigint;
  receipts?: readonly MockReceipt[];
  /** Hashes the RPC knows as pending transactions (no receipt yet). */
  pending?: readonly Hex[];
  pendingNotesLogs?: readonly Log[];
  committedNotesLogs?: readonly Log[];
  /** Tokens registered in the vault; an unregistered token makes getTokenId revert. */
  tokenIds?: ReadonlyMap<Address, bigint>;
}

function tokenNotRegistered(tokenAddress: Address) {
  return new ContractFunctionExecutionError(
    new ContractFunctionRevertedError({ abi: vaultAbi, functionName: "getTokenId", message: "TokenNotRegistered" }),
    { abi: vaultAbi, functionName: "getTokenId", args: [tokenAddress], contractAddress: VAULT },
  );
}

/** A mocked PaymentVerifyClient (`client`); the individual mocks are exposed for call assertions. */
export function mockClient(chain: MockChain = {}) {
  const tokenIds =
    chain.tokenIds ??
    new Map<Address, bigint>([
      [TOKEN, TOKEN_ID],
      [OTHER_TOKEN, OTHER_TOKEN_ID],
    ]);
  const getChainId = vi.fn().mockResolvedValue(chain.chainId ?? CHAIN_ID);
  const getBlockNumber = vi.fn().mockResolvedValue(chain.latestBlock ?? 100n);
  const getTransactionReceipt = vi.fn(async ({ hash }: { hash: Hex }) => {
    const receipt = chain.receipts?.find((candidate) => candidate.transactionHash === hash);
    if (receipt) return receipt;
    throw new TransactionReceiptNotFoundError({ hash });
  });
  const getTransaction = vi.fn(async ({ hash }: { hash: Hex }) => {
    if (chain.pending?.includes(hash)) return { hash, blockNumber: null };
    throw new TransactionNotFoundError({ hash });
  });
  const getLogs = vi.fn(async ({ event }: { event: { name: string } }) => {
    if (event.name === "PendingNotes") return [...(chain.pendingNotesLogs ?? [])];
    if (event.name === "CommittedNotes") return [...(chain.committedNotesLogs ?? [])];
    throw new Error(`unexpected getLogs event ${event.name}`);
  });
  const readContract = vi.fn(
    async ({
      address,
      functionName,
      args,
    }: {
      address: Address;
      functionName: string;
      args?: readonly unknown[];
      blockNumber?: bigint;
    }) => {
      if (isAddressEqual(address, AGGREGATOR) && functionName === "curvyVault") return VAULT;
      if (isAddressEqual(address, AGGREGATOR) && functionName === "portalFactory") return PORTAL_FACTORY;
      if (isAddressEqual(address, VAULT) && functionName === "depositFee") return DEPOSIT_FEE_BPS;
      if (isAddressEqual(address, VAULT) && functionName === "getTokenId") {
        const tokenAddress = args?.[0] as Address;
        const tokenId = [...tokenIds].find(([candidate]) => isAddressEqual(candidate, tokenAddress))?.[1];
        if (tokenId === undefined) throw tokenNotRegistered(tokenAddress);
        return tokenId;
      }
      if (isAddressEqual(address, VAULT) && functionName === "perTokenGasFees") {
        return {
          tokenId: args?.[0] as bigint,
          portalDeployment: PORTAL_DEPLOYMENT_FEE,
          pendingNoteCommitment: PENDING_NOTE_COMMITMENT_FEE,
          withdrawal: 0n,
        };
      }
      throw new Error(`unexpected readContract ${address}.${functionName}`);
    },
  );
  const mocks = { getChainId, getBlockNumber, getTransactionReceipt, getTransaction, getLogs, readContract };
  return { ...mocks, client: mocks as unknown as PaymentVerifyClient };
}
