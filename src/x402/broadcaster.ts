import type { Address, Hex } from "viem";
import { getAddress, isAddress, isHex } from "viem";
import { record } from "../utils/validation";
import { parseCurvyDeployment, parseUint } from "./parse";
import type { CurvyDeployment } from "./protocol";

export type BroadcasterHeaders =
  | Record<string, string>
  | (() => Record<string, string> | Promise<Record<string, string>>);

export interface BroadcasterClientOptions {
  /** Portal broadcaster base URL. */
  url: string;
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout. Defaults to 30 s. */
  timeoutMs?: number;
  headers?: BroadcasterHeaders;
}

/** Unexpected reply from the portal broadcaster. */
export class BroadcasterError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`broadcaster ${path} returned ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    this.name = "BroadcasterError";
  }
}

/** `POST /portal/payments`: register an already funded payment portal for shielding. */
export interface PortalPaymentRegistration {
  ownerHash: string;
  ephemeralKeyX: string;
  ephemeralKeyY: string;
  viewTag: number;
  recovery: Address;
  /** Base units the portal must hold. */
  expectedAmount: string;
  /** Unix seconds after which the broadcaster gives up on this portal. */
  expiry: number;
  chainId: number;
  token: Address;
}

export type PortalPaymentState =
  | "awaiting_funds"
  | "compliance_checking"
  | "compliance_failed"
  | "bridging"
  | "shielding"
  | "shielded"
  | "expired"
  | "failed"
  | (string & {});

export interface PortalPaymentStatus {
  state: PortalPaymentState;
  portalAddress: Address;
  /** The shield transaction once the portal is `shielded`. */
  txHash?: Hex;
  observedBalance?: string;
  error?: string;
}

/** Portal states the broadcaster never leaves; the funds will not be shielded. */
export const TERMINAL_PORTAL_FAILURES: ReadonlySet<string> = new Set(["compliance_failed", "expired", "failed"]);

/** A token the broadcaster shields on a network. */
export interface CurvyCurrency {
  address: Address;
  symbol: string;
  decimals: number;
  /** The token's id in the Curvy vault. */
  vaultTokenId: string;
}

/** `GET /portal/networks/:chainId`. */
export interface CurvyNetwork extends CurvyDeployment {
  chainId: number;
  name?: string;
  testnet?: boolean;
  /** Portals worth less than this many USD are failed instead of shielded. */
  minPortalUsd?: number;
  currencies: CurvyCurrency[];
}

export interface BroadcasterClient {
  readonly url: string;
  /** The Curvy deployment and shieldable tokens on a chain; `undefined` when the broadcaster does not serve it. */
  network(chainId: number): Promise<CurvyNetwork | undefined>;
  /** Idempotent: re-registering the same portal returns its current status. */
  registerPayment(registration: PortalPaymentRegistration): Promise<PortalPaymentStatus>;
  status(portalAddress: Address): Promise<PortalPaymentStatus | undefined>;
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function parseStatus(value: unknown): PortalPaymentStatus {
  const outer = record(value, "portal status");
  const data = record(outer.data ?? outer, "portal status.data");
  if (typeof data.state !== "string") throw new Error("portal status.state must be a string");
  if (typeof data.portalAddress !== "string" || !isAddress(data.portalAddress)) {
    throw new Error("portal status.portalAddress must be an address");
  }
  const txHash = data.txHash;
  const error = data.error;
  return {
    state: data.state,
    portalAddress: getAddress(data.portalAddress),
    ...(typeof txHash === "string" && isHex(txHash) && txHash.length === 66 ? { txHash } : {}),
    ...(data.observedBalance === undefined || data.observedBalance === null
      ? {}
      : { observedBalance: parseUint(data.observedBalance, "portal status.observedBalance").toString() }),
    ...(typeof error === "string" && error !== "" ? { error } : {}),
  };
}

/** Client for Curvy's portal broadcaster, the service that shields funded payment portals. */
export function createBroadcasterClient(options: BroadcasterClientOptions): BroadcasterClient {
  const url = options.url.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) throw new Error("broadcaster url must be http(s)");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("a fetch implementation is required");
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive integer");

  async function headers(): Promise<Record<string, string>> {
    const extra = typeof options.headers === "function" ? await options.headers() : options.headers;
    return { accept: "application/json", ...extra };
  }

  function parseNetwork(value: unknown): CurvyNetwork {
    const outer = record(value, "network");
    const data = record(outer.data ?? outer, "network.data");
    const deployment = parseCurvyDeployment(data);
    const currencies = Array.isArray(data.currencies) ? data.currencies : [];
    return {
      ...deployment,
      chainId: Number(parseUint(data.chainId, "network.chainId")),
      ...(typeof data.name === "string" ? { name: data.name } : {}),
      ...(typeof data.testnet === "boolean" ? { testnet: data.testnet } : {}),
      ...(typeof data.minPortalUsd === "number" && Number.isFinite(data.minPortalUsd) && data.minPortalUsd >= 0
        ? { minPortalUsd: data.minPortalUsd }
        : {}),
      currencies: currencies.map((entry, index) => {
        const currency = record(entry, `network.currencies[${index}]`);
        if (typeof currency.address !== "string" || !isAddress(currency.address)) {
          throw new Error(`network.currencies[${index}].address must be an address`);
        }
        return {
          address: getAddress(currency.address),
          symbol: typeof currency.symbol === "string" ? currency.symbol : "",
          decimals: Number(parseUint(currency.decimals ?? 0, `network.currencies[${index}].decimals`)),
          vaultTokenId: parseUint(currency.vaultTokenId, `network.currencies[${index}].vaultTokenId`).toString(),
        };
      }),
    };
  }

  return {
    url,
    async network(chainId) {
      if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("chainId must be a positive integer");
      const response = await fetchImpl(`${url}/portal/networks/${chainId}`, {
        headers: await headers(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 404) return undefined;
      const body = await readJson(response);
      if (!response.ok) throw new BroadcasterError("/portal/networks", response.status, body);
      return parseNetwork(body);
    },
    async registerPayment(registration) {
      const response = await fetchImpl(`${url}/portal/payments`, {
        method: "POST",
        headers: { ...(await headers()), "content-type": "application/json" },
        body: JSON.stringify(registration),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const body = await readJson(response);
      if (!response.ok) throw new BroadcasterError("/portal/payments", response.status, body);
      return parseStatus(body);
    },
    async status(portalAddress) {
      const response = await fetchImpl(`${url}/portal/status?address=${getAddress(portalAddress)}`, {
        headers: await headers(),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 404) return undefined;
      const body = await readJson(response);
      if (!response.ok) throw new BroadcasterError("/portal/status", response.status, body);
      return parseStatus(body);
    },
  };
}
