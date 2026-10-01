# `@0xcurvy/payments-sdk`

Payment primitives for Curvy merchant and checkout integrations. As in the main Curvy SDK, functionality is grouped behind focused entry points, and the root is a browser-safe convenience barrel.

| Entry point | Runtime | Responsibility |
| --- | --- | --- |
| `@0xcurvy/payments-sdk` | Browser and Node | Convenience export of every browser-safe feature. |
| `@0xcurvy/payments-sdk/intent` | Browser and Node | Parse, type, sign, and verify payment requests. |
| `@0xcurvy/payments-sdk/transport` | Browser and Node | Encode request fragments and build checkout URLs. |
| `@0xcurvy/payments-sdk/chain` | Browser and Node | Receipt discovery hints (not payment proof); portal prediction (internal and unstable). |
| `@0xcurvy/payments-sdk/contracts` | Browser and Node | Payment contract ABIs. |
| `@0xcurvy/payments-sdk/merchant/keys` | Browser and Node | Build and parse merchant signer key sets; encode and parse the receiving-keys value. |
| `@0xcurvy/payments-sdk/merchant` | Merchant backend | Bind SDK config, create payment requests and verify payments (derives the one-time payment reference with Curvy's Rust core). Node-only. |
| `@0xcurvy/payments-sdk/economics` | Browser and Node | Fee reads, quotes and minimum amounts. |
| `@0xcurvy/payments-sdk/x402` | Browser and Node | x402 wire types, broadcaster and facilitator clients, payer helper, EIP-712 types, parsers and header codec. |
| `@0xcurvy/payments-sdk/x402/merchant` | Merchant backend | `createX402Merchant`: charge agents per request over x402 (`exact` and `curvy-transfer`). Node-only. |

The merchant signing key must stay on the backend. A merchant frontend asks its backend to create and sign a request, then opens the returned checkout URL. The frontend does not need the merchant entry point or Rust WASM.

## Public browser-safe API

- Request lifecycle from `/intent`: `parsePaymentIntent`, `parseSignedPaymentIntent`, `signPaymentIntent`, and `verifyPaymentIntent`.
- Transport from `/transport`: `encodePaymentIntentFragment`, `decodePaymentIntentFragment`, `buildCheckoutUrl`, `buildCheckoutCompleteUrl`, and `buildCheckoutRetryUrl` (returns the buyer to the completion page as `#retry=<ephemeralKeyX>` so the merchant can issue a fresh attempt).
- Merchant signer discovery from `/merchant/keys`: `buildMerchantKeySet` and `parseMerchantKeySet`.
- Receiving keys from `/merchant/keys` (and the root): `encodeReceivingKeys(recipient)` and `parseReceivingKeys(value)`, plus `RECEIVING_KEYS_VERSION` (`"01"`). See [Receiving keys](#receiving-keys).
- Chain helpers from `/chain`: `findNoteInReceipt`, which returns `{ noteId, netAmount, token }` (`token` is the vault token id) or `null`, and `predictPortalAddress` (**internal and unstable**: for Curvy's checkout; its inputs change when Curvy migrates portal factories, so merchants do not call it). `findNoteInReceipt` matches only the payment reference `R`, so it is a discovery hint. It does **not** prove a payment.
- Typed data: `buildPaymentIntentTypedData` and `paymentIntentTypes`. The domain is `{ name: "Curvy Payments", version: "1", chainId }`.
- Fees from `/economics` (and the root): `readChainFees`, `feeBreakdown`, `quotePayment` and `minimumPaymentAmount`.
- Contract ABIs: `aggregatorAbi`, `portalFactoryAbi`, `vaultAbi`, and `pendingNotesAbi`, also available from `@0xcurvy/payments-sdk/contracts`.
- Constants: `DEFAULT_CHECKOUT_COMPLETE_PATH` (`/checkout/complete`), `DEFAULT_PAYMENT_REQUEST_TTL_SECONDS` (`600`) and `MAX_PAYMENT_REQUEST_TTL_SECONDS` (`86400`).

## Checkout signing key

Checkout requests are signed by a key used for nothing else: it holds no funds, pays no gas and is independent of any wallet or Curvy key. Create one on the backend:

```sh
npx @0xcurvy/payments-sdk@0.2.0-rc.1 create-signer [--out <file>]
```

It prints the public address and writes the private key to an owner-only file (default `curvy-checkout-signer.secret.json`), refusing to replace an existing one. Move the key into your secret store and publish the address with `buildMerchantKeySet`. In code, `generateCheckoutSigningKey()` from `/merchant/keys` returns `{ privateKey, address }`. A KMS or HSM can hold the key instead: pass your own signer function to `signPaymentIntent`.

## Merchant backend

Install the Rust core next to the payments SDK in the backend package. It is an optional peer, so browser-only consumers do not pull the WASM package. Pin it: the npm `latest` tag of `@0xcurvy/rs-core-wasm` does not match the peer version.

```sh
pnpm add @0xcurvy/payments-sdk@0.2.0-rc.1 @0xcurvy/rs-core-wasm@0.1.0-rc.4
```

Bind the SDK settings once. Then, for every checkout, create a request, store it, sign it and redirect:

```ts
import { signPaymentIntent } from "@0xcurvy/payments-sdk/intent";
import { initialize, serializePaymentRecord } from "@0xcurvy/payments-sdk/merchant";
import { buildCheckoutUrl } from "@0xcurvy/payments-sdk/transport";

const sdk = initialize({
  receivingKeys: process.env.CURVY_PAYMENTS_PUBLIC_KEY!, // the "01…" value from the web app's Payments setup
  chainId,
  merchantOrigin, // e.g. "https://shop.example"
  confirmations: 12,
  paidWhen: "shielded", // default; "committed" also waits until the note is spendable
  ttlSeconds: 600, // also the buyer's funding window; at most 86400 (24 h)
  // optional: checkoutCompletePath: "/orders/paid",
});

const fromBlock = await publicClient.getBlockNumber();
const request = await sdk.createPaymentRequest({ amount, token, description: "Order #1048 · Blue hour print" });
const payment = await signPaymentIntent(request, (typedData) => merchantSigner.signTypedData(typedData));
// One opaque value per attempt, in your database; never only a cookie.
await saveAttempt({ orderId, record: serializePaymentRecord({ payment, fromBlock, verification: null }) });
const checkoutUrl = buildCheckoutUrl(process.env.CHECKOUT_URL!, payment); // e.g. https://app.curvy.dev/checkout
```

### Receiving keys

`receivingKeys` is your public key for payments: your three public receiving keys (`S`, `V` and the BabyJubjub public key) as one value. Copy it from the Curvy web app's **Payments** setup (the `CURVY_PAYMENTS_PUBLIC_KEY` line of step 3). It is public: packing is not encryption, and it holds no secret, no derivation index and no reference to a parent account, so a business account exports only its own public keys.

- The first two characters are the format version, two lowercase hex digits. `01` is today's three keys; `02` is reserved for a later protocol version; `00` is never valid. An SDK that does not know the version refuses the value and says to upgrade `@0xcurvy/payments-sdk`.
- The rest is base64url without padding of `CRK`, the six 32-byte big-endian coordinates and a 4-byte checksum (the first 4 bytes of SHA-256 over the version digits, `CRK` and the keys). The checksum refuses typos and cut-off copies, and covers the version digits.
- `parseReceivingKeys` also checks that each key is a point on its curve, and returns `{ S, V, babyJubjubPublicKey }` as decimal `x.y` strings. `initialize`, `createPaymentRequest`, `buildPaymentRequest` and `createX402Merchant` take exactly one of `receivingKeys` (preferred) or that `recipient` object.

Publish your signer addresses with `buildMerchantKeySet` at `{merchantOrigin}/.well-known/curvy-payments.json`; `buildMerchantKeySet(signers, { name: "Overprint", icon: "/curvy-icon.png" })` also gives the name checkout shows for your shop, next to your domain (at most 60 characters of plain text), and the square PNG or WebP icon beside it (an absolute path on the same origin). The hosted checkout fetches that file from the buyer's browser, uncached, and verifies the signed request against it before it shows anything; serve it over `https:` from a publicly reachable host, without redirects. After adding a new signer, wait until every cached copy of the file lists it before signing with it. A KMS, HSM or MPC secp256k1 key works through a small adapter passed to `signPaymentIntent` (tested recipe in the docs, "Signing with a KMS or HSM").

The SDK does not ship route handlers yet: the merchant writes the key-file route, the completion page and the settlement route. Keep each a thin handler over these calls and keep them up while payments are in progress, so a later release can supply them and add a route the checkout calls during payment.

Confirm the payment on the backend with the stored request. Use the return-URL hash when you have one. A background job should also scan from `fromBlock` without a hash:

```ts
const record = parsePaymentRecord(storedValue); // from /merchant
const { status, payment: verified } = await sdk.verifyPayment({
  publicClient,
  aggregatorAddress,
  request: record.payment.intent, // the stored request
  txHash, // optional hint; omit it and pass record.fromBlock to scan
});
// "not_found" | "confirming" | "paid" | "underpaid" | "wrong_token"
```

`verifyPayment` accepts a note only when all of these hold:

- its `noteId` recomputes from the stored `ownerHash`, amount and token;
- it carries the request's `R` and `viewTag`;
- it was emitted by `aggregatorAddress`;
- it is in the requested token;
- its net amount reaches what `request.amount` yields after the vault fees at the shield block.

It throws `PaymentVerificationError` (`code`: `WRONG_CHAIN`, `TX_NOT_FOUND`, `REVERTED`, `NOT_A_SHIELD`, `UNRELATED`, `MISSING_FROM_BLOCK`, `INVALID_INPUT`) when it cannot decide.

Of the notes that pass the first three checks, it reports the first that is `paid`, else the first that is `confirming`, and falls back to the earliest match (`underpaid` or `wrong_token`) only when none pays.

`paidWhen` (bound at `initialize`, default `"shielded"`) decides what `paid` means. A payment is first **shielded**: the money is in the Curvy vault under your keys, safe from the buyer and everyone else, but not spendable yet. Later Curvy's batch prover **commits** the note (a `CommittedNotes` batch), and from then on your wallet can spend it.

- `"shielded"`: `paid` once the note has `confirmations` blocks. Enough to ship goods; the fastest answer.
- `"committed"`: `paid` only once the note is also committed, in a `CommittedNotes` batch whose block also has `confirmations` blocks; until then `confirming`. Pick it when you spend or forward the money right after the sale. The local demo runs no batch prover, so there it stays `confirming`.

`underpaid`, `wrong_token` and `not_found` do not depend on it, and `payment.committed` is reported either way. A later protocol version (v4) will likely require `"committed"`. The type is exported as `PaidWhen`; any other value throws.

Two operational notes:

- **RPC:** fee and token reads are pinned to the shield block, so the RPC must serve contract state at that block (an archive node for old payments; with a pruned node, every retry of an old payment fails). The scan is one `eth_getLogs` from `fromBlock` to the latest block, so keep `fromBlock` recent and stop polling once an attempt is `paid`.
- **One spendable note per request:** every note under one `ownerHash` has the same nullifier, so only one can ever be spent. Spend the verified `payment.noteId`. `payment.siblingNoteIds` lists other notes the check saw under the same `ownerHash`; escalate if it is not empty.

`createPaymentRequest` and `verifyPayment` initialize `@0xcurvy/rs-core-wasm/core` lazily. They call the Domain A `send`/`ownerHash` and `noteId` primitives directly, and they do not depend on or bundle `@0xcurvy/curvy-sdk`. An omitted `checkoutCompletePath` defaults to `/checkout/complete` and is always included in the EIP-712 typed data.

The standalone functions `createPaymentRequest({ receivingKeys, amount, token, chainId, merchantOrigin, ... })` and `verifyPayment({ ..., confirmations, paidWhen })` are also exported from `/merchant`.

Store each attempt as one value: `serializePaymentRecord({ payment, fromBlock, verification })` returns a versioned JSON string holding the signed package, the scan start and the latest `verifyPayment` result (bigints as decimal strings). Read it back with `parsePaymentRecord`, which refuses unknown versions and fields. Keep the value whole rather than splitting it into columns: later SDK versions add fields under a new version.

## Charging agents per request (x402)

```ts
import { createX402Merchant, toResponse } from "@0xcurvy/payments-sdk/x402/merchant";

const x402 = await createX402Merchant({
  rpcUrl, // JSON-RPC endpoint of the payment chain (Arbitrum One in production)
  token: USDC, // 0xaf88d065e77c8cC2239327C5EDb3A432268e5831 on Arbitrum One
  receivingKeys: process.env.CURVY_PAYMENTS_PUBLIC_KEY, // the "01…" value from the web app's Payments setup
  // Defaults: broadcaster "https://api.curvy.box" (Curvy's portal broadcaster, shields every paid portal into
  // your note) and facilitator "https://api.curvy.box/portal/x402" (Curvy's x402 facilitator, settles `exact`).
  // Override either with a URL or client; `facilitator: false` offers `curvy-transfer` only.
});

// in a request handler
const result = await x402.charge(request, { price: 10_000n });
if (result.status === "payment-required") return toResponse(result.response); // 402 + PAYMENT-REQUIRED
return Response.json(data, { headers: result.headers });                       // payTo holds the amount on chain
```

`charge()` issues the 402 with a fresh one-time `payTo` and offers two schemes on it: `exact`, where the payer signs an EIP-3009 authorization that the facilitator submits, and `curvy-transfer`, where the payer sends a plain ERC-20 transfer itself and presents the transaction hash. With `facilitator: false` only `curvy-transfer` is offered. It resolves `paid` only once the portal actually holds the amount, then registers the portal with the broadcaster, which screens, deploys and shields it, and confirms your payment reference on chain in the background. Every `payTo` is derived with `recovery = NO_RECOVERY_ADDRESS` unless you set `recovery`, so funds in a portal the broadcaster never shields are lost for good. Agents pay with any x402 client (`exact`), or with `createX402Payer` from `@0xcurvy/payments-sdk/x402` (both schemes). Docs: [x402 and the Payments SDK](https://docs.curvy.box/sdk/payments/x402), [Payments SDK](https://docs.curvy.box/sdk/payments/).

## Payment descriptions

`createPaymentRequest` takes an optional `description` (at most 120 characters of plain text: no control or text-direction characters, no leading or trailing spaces). Checkout shows it under your shop's name and prints it on the buyer's receipt. It is signed with the payment as a `DescribedPaymentIntent`, a separate EIP-712 type, so it can't be changed, added or removed on the way. Intents without one are signed exactly as before. The description travels in the checkout link's fragment and is not part of what checkout registers with Curvy's payment service.

## Breaking changes since 0.1.2

- `verifyPayment` and `VerifyPaymentParameters` were removed from `/chain` and from the root entry. They are now in `/merchant`, together with `PaymentVerifyClient`.
- `verifyPayment` takes the stored `request` instead of `ephemeralKey`, returns `{ status, payment }` instead of a boolean, and requires `fromBlock` when `txHash` is omitted.
- `parsePaymentIntent` range-checks numeric fields and rejects non-canonical decimals.
- `initialize`, `createPaymentRequest` and `buildPaymentRequest` refuse `ttlSeconds` above `86400` (24 h, `MAX_PAYMENT_REQUEST_TTL_SECONDS`).
- `signPaymentIntent` refuses an intent whose `expiry` is more than 86400 seconds (24 h) away, however the intent was built.
- `verifyPaymentIntent` refuses an intent whose `expiry` is more than 24 h plus 5 minutes (clock skew) after `nowSeconds`.
- `predictPortalAddress` is internal and unstable. x402 merchants use `createX402Merchant` from `/x402/merchant` instead.
