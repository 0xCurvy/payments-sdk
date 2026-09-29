# `@0xcurvy/payments-sdk`

Payment primitives for Curvy merchant and checkout integrations. Like the main Curvy SDK, functionality is grouped behind focused feature entry points; the root is a browser-safe convenience barrel.

| Entry point | Runtime | Responsibility |
| --- | --- | --- |
| `@0xcurvy/payments-sdk` | Browser and Node | Convenience export of every browser-safe feature. |
| `@0xcurvy/payments-sdk/intent` | Browser and Node | Parse, type, sign, and verify payment requests. |
| `@0xcurvy/payments-sdk/transport` | Browser and Node | Encode request fragments and build checkout URLs. |
| `@0xcurvy/payments-sdk/chain` | Browser and Node | Portal prediction, receipts, and payment verification. |
| `@0xcurvy/payments-sdk/contracts` | Browser and Node | Payment contract ABIs. |
| `@0xcurvy/payments-sdk/merchant/keys` | Browser and Node | Build and parse merchant signer key sets. |
| `@0xcurvy/payments-sdk/merchant` | Merchant backend | Bind SDK config and create payment requests with rs-core Domain A primitives. Node-only. |
| `@0xcurvy/payments-sdk/economics` | Browser and Node | Fee reads, quotes and minimum amounts. |
| `@0xcurvy/payments-sdk/x402` | Browser and Node | x402 wire types, broadcaster and facilitator clients, payer helper, EIP-712 types, parsers and header codec. |
| `@0xcurvy/payments-sdk/x402/merchant` | Merchant backend | `createX402Merchant`: charge agents per request over x402 (`exact` and `curvy-transfer`). Node-only. |

The merchant signing key must stay on the backend. A merchant frontend should ask its backend to create and sign a request, then open the returned checkout URL. It does not need the merchant entry point or Rust WASM.

## Public browser-safe API

- Request lifecycle from `/intent`: `parsePaymentIntent`, `parseSignedPaymentIntent`, `signPaymentIntent`, and `verifyPaymentIntent`.
- Transport from `/transport`: `encodePaymentIntentFragment`, `decodePaymentIntentFragment`, `buildCheckoutUrl`, and `buildCheckoutCompleteUrl`.
- Merchant signer discovery from `/merchant/keys`: `buildMerchantKeySet` and `parseMerchantKeySet`.
- Chain helpers from `/chain`: `predictPortalAddress`, `verifyPayment`, and `findNoteInReceipt`.
- Typed data: `buildPaymentIntentTypedData` and `paymentIntentTypes`.
- Contract ABIs: `aggregatorAbi`, `portalFactoryAbi`, `vaultAbi`, and `pendingNotesAbi`, also available from `@0xcurvy/payments-sdk/contracts`.
- Constants: `DEFAULT_CHECKOUT_COMPLETE_PATH` (`/checkout/complete`) and `DEFAULT_PAYMENT_REQUEST_TTL_SECONDS` (`600`).

## Merchant backend payment request creation

Install the Rust core alongside the payments SDK in the backend package. It is an optional peer so browser-only consumers do not pull the WASM package unnecessarily.

```sh
pnpm add @0xcurvy/payments-sdk @0xcurvy/rs-core-wasm@0.1.0-rc.4
```

Bind SDK settings once, then create payment requests with only amount and token:

```ts
import { signPaymentIntent } from "@0xcurvy/payments-sdk/intent";
import { initialize } from "@0xcurvy/payments-sdk/merchant";
import { buildCheckoutUrl } from "@0xcurvy/payments-sdk/transport";

const sdk = initialize({
  recipient,
  chainId,
  merchantOrigin,
  confirmations: 12,
  ttlSeconds: 600,
  // optional: checkoutCompletePath: "/orders/paid",
});

const request = await sdk.createPaymentRequest({ amount, token });
const payment = await signPaymentIntent(request, (typedData) => merchantSigner.signTypedData(typedData));
const checkoutUrl = buildCheckoutUrl(checkoutOrigin, payment);
```

`createPaymentRequest` initializes `@0xcurvy/rs-core-wasm/core` lazily and calls the Domain A `send` and `ownerHash` primitives directly. It does not depend on or bundle `@0xcurvy/curvy-sdk`. Omitted `checkoutCompletePath` defaults to `/checkout/complete` and is always included in the EIP-712 typed data.

Standalone `createPaymentRequest({ recipient, amount, token, chainId, merchantOrigin, ... })` remains available for advanced use.

## Charging agents per request (x402)

```ts
import { createX402Merchant, toResponse } from "@0xcurvy/payments-sdk/x402/merchant";

const x402 = await createX402Merchant({
  broadcaster: CURVY_BROADCASTER_URL, // Curvy's portal broadcaster: shields every paid portal into your note
  facilitator: X402_FACILITATOR_URL,  // optional: any x402 v2 facilitator that settles `exact`
  rpcUrl,
  token: USDC,
  recipient,
});

// in a request handler
const result = await x402.charge(request, { price: 10_000n });
if (result.status === "payment-required") return toResponse(result.response); // 402 + PAYMENT-REQUIRED
return Response.json(data, { headers: result.headers });                       // payTo holds the amount on chain
```

`charge()` issues the 402 with a fresh one-time `payTo` and offers two schemes on it: `exact`, where the payer signs an EIP-3009 authorization that the facilitator submits, and `curvy-transfer`, where the payer sends a plain ERC-20 transfer itself and presents the transaction hash. Without a facilitator only `curvy-transfer` is offered. It resolves `paid` only once the portal actually holds the amount, then registers the portal with the broadcaster, which screens, deploys and shields it, and confirms your payment reference on chain in the background. Every `payTo` is derived with `recovery = NO_RECOVERY_ADDRESS` unless you set `recovery`, so funds in a portal the broadcaster never shields are lost for good. Agents pay with any x402 client (`exact`), or with `createX402Payer` from `@0xcurvy/payments-sdk/x402` (both schemes). See the docs page "x402 and the Payments SDK".
