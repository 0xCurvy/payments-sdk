import { parseSettleResponse, parseSupportedResponse, parseVerifyResponse } from "./parse";
import {
  X402_VERSION,
  type X402PaymentPayload,
  type X402PaymentRequirements,
  type X402SettleResponse,
  type X402SupportedResponse,
  type X402VerifyResponse,
} from "./protocol";

export type FacilitatorHeaders =
  | Record<string, string>
  | (() => Record<string, string> | Promise<Record<string, string>>);

export interface FacilitatorClientOptions {
  /** Facilitator base URL, for example `https://facilitator.curvy.box`. */
  url: string;
  /** `fetch` implementation; defaults to the global one. */
  fetch?: typeof globalThis.fetch;
  /** Per-request timeout. Defaults to 30 s. A timed-out `settle` is indeterminate: the transfer may still land. */
  timeoutMs?: number;
  /** Extra headers, for example an API key, sent on every request. */
  headers?: FacilitatorHeaders;
}

/** Non-2xx reply from the facilitator that did not carry an x402 verify/settle body. */
export class FacilitatorError extends Error {
  constructor(
    readonly path: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`facilitator ${path} returned ${status}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
    this.name = "FacilitatorError";
  }
}

export interface FacilitatorClient {
  readonly url: string;
  /** `GET /supported`: schemes, networks, signer addresses and (for Curvy) the deployment addresses. */
  supported(): Promise<X402SupportedResponse>;
  /** `POST /verify` for one payment against the requirements the merchant issued. */
  verify(payload: X402PaymentPayload, requirements: X402PaymentRequirements): Promise<X402VerifyResponse>;
  /** `POST /settle`: move the payer's funds to `payTo`. */
  settle(payload: X402PaymentPayload, requirements: X402PaymentRequirements): Promise<X402SettleResponse>;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Client for any x402 v2 facilitator (`/supported`, `/verify`, `/settle`) on plain `fetch`. Works in Node and browsers. */
export function createFacilitatorClient(options: FacilitatorClientOptions): FacilitatorClient {
  const url = options.url.replace(/\/+$/, "");
  if (!/^https?:\/\//.test(url)) throw new Error("facilitator url must be http(s)");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("a fetch implementation is required");
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("timeoutMs must be a positive integer");

  async function headers(): Promise<Record<string, string>> {
    const extra = typeof options.headers === "function" ? await options.headers() : options.headers;
    return { accept: "application/json", ...extra };
  }

  async function request(
    path: string,
    init: { method: "GET" | "POST"; body?: unknown },
  ): Promise<{ status: number; body: unknown }> {
    const response = await fetchImpl(`${url}${path}`, {
      method: init.method,
      headers: {
        ...(await headers()),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return { status: response.status, body: await readJson(response) };
  }

  async function post(path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    const reply = await request(path, { method: "POST", body });
    if (reply.status < 200 || reply.status >= 300) {
      // x402 facilitators answer a rejected verify/settle with 400 and the regular response body.
      if (isRecord(reply.body) && ("isValid" in reply.body || "success" in reply.body)) return reply;
      throw new FacilitatorError(path, reply.status, reply.body);
    }
    return reply;
  }

  return {
    url,
    async supported() {
      const reply = await request("/supported", { method: "GET" });
      if (reply.status < 200 || reply.status >= 300) throw new FacilitatorError("/supported", reply.status, reply.body);
      return parseSupportedResponse(reply.body);
    },
    async verify(payload, requirements) {
      return parseVerifyResponse(
        (
          await post("/verify", {
            x402Version: X402_VERSION,
            paymentPayload: payload,
            paymentRequirements: requirements,
          })
        ).body,
      );
    },
    async settle(payload, requirements) {
      return parseSettleResponse(
        (
          await post("/settle", {
            x402Version: X402_VERSION,
            paymentPayload: payload,
            paymentRequirements: requirements,
          })
        ).body,
      );
    },
  };
}
