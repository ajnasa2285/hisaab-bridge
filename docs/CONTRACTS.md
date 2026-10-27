# Interfaces (fixed)

Written by Claude before any code. Every builder codes against these shapes. A change goes through `docs/STATUS.md` and is made here by Claude first.

Units everywhere: **hours in tenths** (`61` = 6.1 h), **quantities in hundredths** (`5000` = 50.00 bags), **money in paise** (`732000` = ₹7,320.00), **days** as `YYYY-MM-DD` in IST, **times** as ISO 8601 UTC strings. Integers only.

## 1. Layout and owners

| Path | Owner | What |
|---|---|---|
| `src/meta/client.js` | Astra (Claude reviews) | The only door to Meta's models (section 2) |
| `src/readers/` | Astra | `meter.js`, `upi.js`, `challan.js` (section 3) |
| `eval/` | Astra | answer-key tool, evaluation runs, results (section 3.4) |
| `src/protocol/` | Claude | messages, canonical JSON, signing, verification (section 4) |
| `src/ledger/` | Claude | append-only stores, order states (section 5) |
| `src/agents/` | Claude | JCB agent, contractor agent, supplier agent: wiring, decisions |
| `src/orchestrator/` | Claude | Muse Spark tool calling: message → step (section 6) |
| `src/wa/` | Claude | WhatsApp Cloud API client, webhook, routing (section 7) |
| `src/contractor/` | Fable | request list, site account (section 8) |
| `src/i18n/` | Fable (texts), Claude (mechanism) | every user-facing text (section 9) |
| `web/` | Fable | judge page (section 10) |
| `test/` | each builder for their part | `node:test` |

## 2. Meta client (`src/meta/client.js`)

```js
/** @typedef {{mime: 'image/jpeg'|'image/png'|'image/webp', bytes: Uint8Array}} ImageInput */
/** @typedef {{input_tokens: number, output_tokens: number}} Usage */

/**
 * One Muse Spark call. Returns parsed JSON when `schema` is given.
 * @param {{system?: string, text: string, images?: ImageInput[], schema?: object,
 *          tools?: object[], timeoutMs?: number}} req
 * @returns {Promise<{ok: true, json: any, text: string, toolCalls: {name: string, args: any}[],
 *          usage: Usage, model: string, latencyMs: number}
 *        | {ok: false, transient: boolean, reason: string, latencyMs: number}>}
 */
export async function museSpark(req) {}

/**
 * Hindi speech to text (Muse Voice Transcribe).
 * @param {{audio: Uint8Array, mime: string, language?: 'hi'}} req
 * @returns {Promise<{ok: true, text: string, model: string, latencyMs: number}
 *        | {ok: false, transient: boolean, reason: string, latencyMs: number}>}
 */
export async function transcribe(req) {}
```

- Configuration from the environment only: `META_API_KEY`, `META_API_BASE`, `MUSE_SPARK_MODEL`, `MUSE_TRANSCRIBE_MODEL`. No defaults for the key or the model IDs.
- Never logs the key, image bytes, audio or full prompts. Logs: model, latency, tokens, ok/reason.
- `transient: true` for timeouts, 429, 5xx; `false` for 4xx other than 429 and schema failures. At most 2 retries for transient errors, with backoff; then return the failure.
- Records every call's usage to `eval/` cost accounting when `META_COST_LOG` is set.

## 3. Readers (`src/readers/`)

Readers only read. They return what is visible, with `null` for anything unclear. They never compute hours, totals or balances, never decide, never call anything but `src/meta/client.js`.

### 3.1 Meter

```js
/**
 * @param {ImageInput} image
 * @returns {Promise<{ok: true, kind: 'hour_meter', raw: string, valueTenths: number|null,
 *   clear: boolean, dashClock: string|null, model: string, latencyMs: number}
 * | {ok: true, kind: 'not_meter', model: string, latencyMs: number}
 * | {ok: false, transient: boolean, reason: string}>}
 */
export async function readMeter(image) {}
```

`raw` is exactly the digits as displayed (e.g. `"03677.7"`); `valueTenths` is `raw` converted by code (not by the model), `null` if any digit is unclear; `clear` is false when the model reports any doubt; `dashClock` is a clock visible on the dashboard as `HH:MM`, else `null`.

### 3.2 UPI screenshot

```js
/**
 * @returns {Promise<{ok: true, kind: 'upi_payment', amountPaise: number|null, date: string|null,
 *   time: string|null, utr: string|null, status: 'success'|'pending'|'failed'|null,
 *   payeeName: string|null, payeeVpa: string|null, payerName: string|null, clear: boolean,
 *   model: string, latencyMs: number}
 * | {ok: true, kind: 'not_upi', model: string, latencyMs: number}
 * | {ok: false, transient: boolean, reason: string}>}
 */
export async function readUpi(image) {}
```

### 3.3 Delivery challan

```js
/**
 * @returns {Promise<{ok: true, kind: 'challan', challanNo: string|null, date: string|null,
 *   items: {name: string, qtyHundredths: number|null, unit: string|null, raw: string}[],
 *   vehicle: string|null, clear: boolean, model: string, latencyMs: number}
 * | {ok: true, kind: 'not_challan', model: string, latencyMs: number}
 * | {ok: false, transient: boolean, reason: string}>}
 */
export async function readChallan(image) {}
```

### 3.4 Evaluation (`eval/`)

- Real images and answer keys live outside the repo: `D:\MUNSHI\CLAUDE\HACKATHON\hisaab-data\{meters,upi,challans}\` with `answers.json` per folder: `{ "<file>": { ...expected fields } }`.
- `split.json` (also outside the repo) fixes development vs held-out files **before** any held-out run; held-out results are only computed with `npm run eval -- --heldout` and are never used to tune prompts.
- The repo holds the code and `eval/results/*.json` with **aggregate numbers only** (counts, accuracy, wrong-but-confident, unclear rate, latency, tokens, cost), never file names of real images or their contents.

## 4. Messages (`src/protocol/`)

Every message between agents:

```json
{
  "v": "hb/0.1",
  "msg_id": "uuid",
  "type": "BOOKING_REQUEST",
  "from": "agent:contractor-1",
  "to": "agent:jcb-1",
  "order_id": "uuid",
  "rev": 1,
  "created_at": "2026-10-28T03:30:00Z",
  "expires_at": "2026-10-29T03:30:00Z",
  "body": {},
  "sig": "ed25519:<base64>"
}
```

Signature: Ed25519 over the RFC 8785 canonical JSON of the message without `sig`. Receiver checks, in this order: version → known sender → signature → addressed to me → not expired → not a repeat (`msg_id`) → type allowed for this pair → order state allows it → apply → signed `RECEIPT`. A refusal returns a signed `REFUSE` with a code only: `UNSUPPORTED`, `NOT_CONNECTED`, `BAD_SIGNATURE`, `NOT_FOR_ME`, `EXPIRED`, `WRONG_STATE`, `BAD_BODY`.

| Type | From → to | Body |
|---|---|---|
| `BOOKING_REQUEST` | buyer → seller | `kind: 'jcb_hours'|'material'`, `site`, `day`, `time?`, `hoursTenths?` (JCB), `items?: {name, qtyHundredths, unit}[]` (material), `note?` |
| `BOOKING_REPLY` | seller → buyer | `answer: 'yes'|'no'|'other_time'`, `day?`, `time?`, `ratePaise?` (per hour or per unit), `note?` |
| `DELIVERY` | seller → buyer | material only: `items`, `challan: {sha256, readValues}`, `deliveredAt` |
| `BILL` | seller → buyer | `lines: {what, qtyHundredths?, hoursTenths?, ratePaise, amountPaise}[]`, `totalPaise`, `evidence: {sha256, kind: 'meter'|'challan', readValue, takenAt, sentAt}[]`, `replaces?: msg_id` |
| `RECEIPT` | receiver → sender | `receipt_for: msg_id`, `entry_hash`, `chain_head` |
| `ACCEPT` | buyer → seller | `bill: msg_id` |
| `DISPUTE` | buyer → seller | `bill: msg_id`, `theirFigure: {hoursTenths?|qtyHundredths?|totalPaise}`, `reason` |
| `CORRECTION` | seller → buyer | a new `BILL` body with `replaces` set (type kept separate for clarity) |
| `PAYMENT_CLAIM` | buyer → seller | `bill: msg_id`, `amountPaise`, `utr`, `paidOn`, `screenshot: {sha256}` |
| `SETTLED` | seller → buyer | `bill: msg_id`, `payment: msg_id`, `amountPaise` |
| `REFUSE` | either | `refers_to: msg_id`, `code` |

Transport: the official A2A JavaScript SDK, `message/send` with the message above as a `data` part (`mediaType: application/json`); Agent Card at `/.well-known/agent-card.json` per agent. If the SDK proves unusable, plain JSON-RPC in the same shape; the README then says so and claims no A2A compatibility.

## 5. Ledger and order states (`src/ledger/`)

One SQLite file per agent. Tables are append-only (triggers refuse UPDATE/DELETE on history):

- `events(seq INTEGER PRIMARY KEY, order_id, type, msg_id, body_json, at, prev_hash, hash)` — every message sent or received and every local decision; `hash = sha256(prev_hash + canonical(row))`.
- `orders(order_id, kind, counterparty, site, created_at)` — identity only; the state is derived from events.

Order states (derived): `requested → booked | declined → working (jcb) | delivered (material) → billed → accepted | disputed → billed (rev n+1) → payment_claimed → settled`. A message that does not fit the current state is refused with `WRONG_STATE`.

## 6. Orchestrator (`src/orchestrator/`)

Muse Spark with tool calling turns a person's text (or transcript) into **one** proposed step: `{tool: string, args: object}`. Tools are plain functions in code; code validates every argument and the person's permission before anything happens, then reads the step back for confirmation when it commits anything. The model never chooses who may do what, never computes, never sends.

## 7. WhatsApp (`src/wa/`)

Two test numbers. Inbound: verify the `X-Hub-Signature-256` with that number's app secret; route by the receiving `phone_number_id` and the sender's phone to `{agent, role}`; unknown sender → one polite reply, nothing stored. Roles: `jcb_owner`, `operator`, `contractor`, `supervisor`, `supplier`. Outbound: text only (plus reply buttons later if needed); outside the 24-hour window nothing is sent.

## 8. Contractor features (`src/contractor/`)

```js
/** A supervisor's request: JCB, material or anything else (a note). */
/** @typedef {{id: number, site: string, what: string, kind: 'jcb'|'material'|'note',
 *   qtyHundredths: number|null, unit: string|null, neededOn: string|null,
 *   status: 'requested'|'approved'|'declined'|'sent'|'done', approvedBy: string|null,
 *   orderId: string|null}} Request */

/** @returns {Request} */ export function addRequest(db, { site, what, kind, qtyHundredths, unit, neededOn, by }) {}
/** @returns {Request[]} */ export function listRequests(db, { site, by }) {}
/** @returns {Request} */ export function decideRequest(db, { id, approve, by }) {}
/** @returns {{site: string, jcbHoursTenths: number, materials: {name: string, qtyHundredths: number, unit: string}[],
 *   billedPaise: number, paidPaise: number, pendingPaise: number, openDisputes: number,
 *   lines: {orderId: string, what: string, amountPaise: number, state: string, evidenceCount: number}[]}} */
export function siteAccount(db, { site }) {}
```

Approval limit: requests above `CONTRACTOR_APPROVAL_LIMIT_PAISE` (estimated value) need the contractor's `हाँ`; the supervisor never approves his own.

## 9. Texts (`src/i18n/`)

`t(key, params)` returns Hindi (Devanagari). Every user-facing string is a key in `src/i18n/hi.js`; no string literals in agent code. Numbers formatted by code (`₹7,320`, `6.1 घंटे`, `50 बोरी`).

## 10. Judge page (`web/`)

Read-only, from a JSON export of both ledgers (`GET /export/<agent>` on the server, invented data in the repo for development). Shows one order from request to settled for both sides, every message with "signature verified ✅", evidence fingerprints, receipts, disputes, and the results from `eval/results/`.
