import { type Address, getAddress, isAddress } from "viem";
import type { CurvyDeployment } from "./networks";

/**
 * Curvy's production API gateway. A Curvy deployment is named by its API base URL, as in the Curvy SDK: its metadata
 * registry, portal broadcaster and x402 facilitator all live behind it (`https://api.curvy.dev` on staging).
 */
export const CURVY_API_URL = "https://api.curvy.box";

export interface FetchCurvyDeploymentParameters {
  /** The Curvy deployment's API base URL. Defaults to production, `https://api.curvy.box`. */
  apiBaseUrl?: string;
  chainId: number;
  fetch?: typeof globalThis.fetch;
}

const TIMEOUT_MS = 30_000;
const deployments = new Map<string, Promise<CurvyDeployment>>();

/** An API base URL without trailing slashes; throws unless it is http(s). */
export function normalizeApiBaseUrl(apiBaseUrl: string = CURVY_API_URL): string {
  if (typeof apiBaseUrl !== "string" || !/^https?:\/\//.test(apiBaseUrl)) {
    throw new Error("apiBaseUrl must be an http(s) URL");
  }
  return apiBaseUrl.replace(/\/+$/, "");
}

function address(value: unknown, name: string): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) throw new Error(`${name} must be an address`);
  return getAddress(value);
}

/** A network of the metadata registry (`GET /networks`), as the Curvy SDK reads it. */
function fromRegistry(networks: unknown, chainId: number): CurvyDeployment | undefined {
  const list = (networks as { data?: unknown })?.data ?? networks;
  if (!Array.isArray(list)) return undefined;
  const network = list.find((entry) => Number((entry as { chainId?: unknown })?.chainId) === chainId) as
    | Record<string, unknown>
    | undefined;
  if (!network) return undefined;
  return {
    aggregator: address(network.aggregatorContractAddress, "aggregatorContractAddress"),
    portalFactory: address(network.portalFactoryContractAddress, "portalFactoryContractAddress"),
    vault: address(network.vaultContractAddress, "vaultContractAddress"),
  };
}

/** The portal broadcaster's network (`GET /portal/networks/:chainId`), for a stack that runs no metadata registry. */
function fromBroadcaster(network: unknown): CurvyDeployment {
  const data = ((network as { data?: unknown })?.data ?? network) as Record<string, unknown>;
  return {
    aggregator: address(data?.aggregator, "aggregator"),
    portalFactory: address(data?.portalFactory, "portalFactory"),
    vault: address(data?.vault, "vault"),
  };
}

async function load(apiBaseUrl: string, chainId: number, fetchImpl: typeof globalThis.fetch): Promise<CurvyDeployment> {
  const get = (path: string) => fetchImpl(`${apiBaseUrl}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });

  const registry = await get("/networks");
  if (registry.ok) {
    const deployment = fromRegistry(await registry.json(), chainId);
    if (deployment) return deployment;
  }
  const portal = await get(`/portal/networks/${chainId}`);
  if (portal.ok) return fromBroadcaster(await portal.json());
  throw new Error(`${apiBaseUrl} has no Curvy contracts for chain ${chainId}`);
}

/**
 * The Curvy contracts on `chainId` for the deployment behind `apiBaseUrl`, the way the Curvy SDK reads them: from its
 * metadata registry (`GET /networks`), or from its portal broadcaster (`GET /portal/networks/:chainId`) on a stack
 * that runs no registry. Read once per deployment and chain; a failed read is tried again next time.
 */
export function fetchCurvyDeployment(parameters: FetchCurvyDeploymentParameters): Promise<CurvyDeployment> {
  const { chainId } = parameters;
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error("chainId must be a positive safe integer");
  const apiBaseUrl = normalizeApiBaseUrl(parameters.apiBaseUrl);
  // A custom fetch is its own source (a proxy, a test), so only the global one is cached.
  if (parameters.fetch) return load(apiBaseUrl, chainId, parameters.fetch);

  const key = `${apiBaseUrl}|${chainId}`;
  let deployment = deployments.get(key);
  if (!deployment) {
    deployment = load(apiBaseUrl, chainId, globalThis.fetch);
    deployments.set(key, deployment);
    deployment.catch(() => deployments.delete(key));
  }
  return deployment;
}
