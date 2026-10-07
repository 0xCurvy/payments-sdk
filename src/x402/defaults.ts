import { CURVY_API_URL } from "../chain/deployment";

/**
 * Curvy's production portal broadcaster: the production API gateway, `CURVY_API_URL`. Serves
 * `GET /portal/networks/:chainId` for every chain it shields on.
 */
export const CURVY_BROADCASTER_URL = CURVY_API_URL;

/** The x402 facilitator route the portal broadcaster serves, relative to its base URL. */
export const CURVY_FACILITATOR_PATH = "/portal/x402";

/** Curvy's production x402 v2 facilitator for the `exact` scheme, served by the portal broadcaster. */
export const CURVY_FACILITATOR_URL = `${CURVY_BROADCASTER_URL}${CURVY_FACILITATOR_PATH}`;

/** The facilitator that ships with a given portal broadcaster: `<broadcaster>/portal/x402`. */
export function facilitatorUrlFor(broadcasterUrl: string): string {
  return `${broadcasterUrl.replace(/\/+$/, "")}${CURVY_FACILITATOR_PATH}`;
}
