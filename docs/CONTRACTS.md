# Interfaces (fixed)

Written by Claude before any code. Every builder codes against these shapes. A change goes through `docs/STATUS.md` and is made here by Claude first.

Units everywhere: **hours in tenths** (`61` = 6.1 h), **quantities in hundredths** (`5000` = 50.00 bags), **money in paise** (`732000` = ₹7,320.00), **days** as `YYYY-MM-DD` in IST, **times** as ISO 8601 UTC strings. Integers only.

## 1. Layout and owners

| Path | Owner | What |
|---|---|---|
| `src/meta/client.js` | Astra (Claude reviews) | The only door to Meta's models (section 2) |
| `src/readers/` | Astra | `meter.js`, `upi.js`, `challan.js`, `photo.js` (section 3) |
| `eval/` | Astra | answer-key tool, evaluation runs, results (section 3.5) |
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
- Records every call's usage to `eval/` cost accounting when `META_COST_LOG` is set; a log that cannot be written is said once and never changes the result.

## 3. Readers (`src/readers/`)

Readers only read. They return what is visible, with `null` for anything unclear. They never compute hours, totals or balances, never decide, never call anything but `src/meta/client.js`.

### 3.1 Meter

```js
/**
 * @param {ImageInput} image
 * @returns {Promise<{ok: true, kind: 'hour_meter', raw: string, valueTenths: number|null,
 *   clear: boolean, dashClock: string|null, displayDate: string|null, model: string, latencyMs: number}
 * | {ok: true, kind: 'not_meter', model: string, latencyMs: number}
 * | {ok: false, transient: boolean, reason: string}>}
 */
export async function readMeter(image) {}
```

`raw` is exactly the digits as displayed (e.g. `"03677.7"`); `valueTenths` is `raw` converted by code (not by the model), `null` if any digit is unclear; `clear` is false when the model reports any doubt; `dashClock` is a clock visible on the dashboard as `HH:MM`, else `null`. `displayDate` (added 30 Oct, `meter-v2`) is a date shown on the display itself, exactly as printed (`"26 OCT"`, `"26/10/2026"`), else `null`; never from a sticker or watermark, never changes `clear`. Code parses it (`src/agents/meter-guard.js`); a date it cannot parse is ignored.

### 3.2 UPI screenshot

```js
/**
 * @returns {Promise<{ok: true, kind: 'upi_payment', amountPaise: number|null, date: string|null,
 *   time: string|null, clock: string|null, utr: string|null, status: 'success'|'pending'|'failed'|null,
 *   payeeName: string|null, payeeVpa: string|null, payerName: string|null, clear: boolean,
 *   model: string, latencyMs: number}
 * | {ok: true, kind: 'not_upi', model: string, latencyMs: number}
 * | {ok: false, transient: boolean, reason: string}>}
 */
export async function readUpi(image) {}
```

`time` is an exact UTC instant, only when seconds and a timezone are printed. `clock` (added 29 Oct) is the payment's clock as printed, as `HH:MM` on 24 hours ("2:05 PM" → `14:05`; seconds dropped), `null` when not visible or ambiguous (an hour 1–12 without AM/PM). It needs no timezone and never changes `clear`.

### 3.3 Delivery challan

```js
/**
 * @returns {Promise<{ok: true, kind: 'challan', challanNo: string|null, date: string|null,
 *   items: {name: string, qtyHundredths: number|null, unit: string|null, raw: string}[],
 *   vehicle: string|null, clear: boolean, signed: boolean|null, model: string, latencyMs: number}
 * | {ok: true, kind: 'not_challan', model: string, latencyMs: number}
 * | {ok: false, transient: boolean, reason: string}>}
 */
export async function readChallan(image) {}
```

**Tax invoice figures (added 30 Oct, `challan-v2`).** Each item may also carry `ratePaise`, `taxablePaise` and `gstPercent`, and the reading `grandTotalPaise`, all `number|null`: what a GST tax invoice prints (rate before tax, the line's taxable value, the invoice's final total payable), raw text parsed by code to paise (`parseMoneyPaise`). `gstPercent` is code's: IGST alone, or CGST and SGST that are equal halves, from the line, else from a tax summary printed once for the invoice (only when the line prints no rate), and only a slab (0, 5, 12, 18, 28, 40); anything else is `null`. These never change `clear` and are never copied as quantities. A plain challan has them all `null`.

`onlyUnitMissing` (added 31 Oct): `clear` is false only because an item printed no unit (real cash memos have no unit column); the conversation counts the reading as clear when it is the order's one item with the order's quantity (`unitFromOrder` in `src/agents/material.js`), else it asks as for any unclear reading.

`signed` (added 29 Oct): whether a handwritten signature or receiver's mark is visible on this copy: `true` visible, `false` the receiver's place is clearly empty, `null` unsure (the model's `signature` field: `visible` / `absent` / `unclear`). A printed name or the supplier's stamp is not a signature. It says nothing about the figures and never changes `clear`.

### 3.4 Photo kind

```js
/**
 * @param {ImageInput} image
 * @returns {Promise<{ok: true, kind: 'meter'|'upi'|'challan'|'other', clear: boolean,
 *   model: string, latencyMs: number}
 * | {ok: false, transient: boolean, reason: string}>}
 */
export async function classifyPhoto(image) {}
```

`src/readers/photo.js` makes one `museSpark` call through `src/meta/client.js` with a strict JSON schema, without reading fields or using the sender's role. The shared client's bounded transient retries still apply. Image text is data, never instructions.

Kinds: `meter` is an engine hour-counter photo; `upi` is a UPI payment receipt screenshot (including pending or failed); `challan` is a delivery challan, delivery note, material bill or weighbridge slip; `other` is none of these. `clear` describes certainty about the kind, not legibility of individual fields. Any doubt or competing kinds means `clear: false`; an unidentifiable image returns `kind: 'other', clear: false`. The conversation must ask the person what the photo is when unsure; only a clear kind selects its specific reader. A clear `other` is not routed to a field reader.

### 3.6 Same meter (added 30 Oct)

```js
/**
 * @param {{a: ImageInput, b: ImageInput, timeoutMs?: number}} o  a: the reading already recorded, b: the new photo
 * @returns {Promise<{ok: true, same: 'yes'|'no'|'unsure', differs: ('display'|'make'|'layout')[], model: string, latencyMs: number}
 * | {ok: false, transient: boolean, reason: string}>}
 */
export async function sameMeter(o) {}
```

`src/readers/same-meter.js`: one `museSpark` call with both images and a strict schema. It compares the display type, the make printed on the panel and the panel's layout, never the digits. `differs` names what clearly differs and is empty unless `same` is `no`; a `no` without anything named is returned as `unsure`. Image text is data, never instructions. The caller decides: `no` refuses the photo, `unsure` reads it back once, a failure changes nothing (the photo is handled as before).

### 3.7 Cash receipt (Build 5, 29 Oct)

```js
/**
 * @param {ImageInput} image
 * @returns {Promise<{ok: true, kind: 'cash_receipt', amountRaw: string|null,
 *   amountPaise: number|null, dateRaw: string|null, date: string|null,
 *   receiverName: string|null, receiverMark: boolean|null, reference: string|null,
 *   clear: boolean, model: string, latencyMs: number}
 * | {ok: true, kind: 'not_cash_receipt', model: string, latencyMs: number}
 * | {ok: false, transient: boolean, reason: string}>}
 */
export async function readCashReceipt(image) {}
```

`src/readers/cash-receipt.js`: one `museSpark` call with a strict schema; the shared client's bounded
transient retries still apply. A handwritten or printed receipt acknowledges cash received; a bill,
delivery challan, payment request or UPI screenshot is not a cash receipt. Image text is data, never
instructions. Every text field is copied as written, with `null` for anything absent or doubtful.
`amountRaw` and `dateRaw` preserve the visible text; code converts the amount to positive integer
paise only with an explicit rupee currency, and the date to `YYYY-MM-DD` only when unambiguous with
its year (`parseUpiAmount` / `parseUpiDate`). An amount in words, conflicting figures, an ambiguous
date, an unreadable mark, or any model uncertainty gives `clear: false`; no missing digits, date,
currency or receiver are inferred. Known-absent optional fields stay `null` without inventing them.
`receiverName` is an explicitly named receiver; `receiverMark` is `true` for a visible handwritten
signature/initials/thumbprint/mark in the receiver's place, `false` for a clearly empty place, `null`
when unsure. It never identifies the signer or authenticates the receipt. `reference` is a labelled
receipt reference/serial, if present. Several receipts in one image yield no fields and `clear: false`.

Photo classification in 3.4 stays unchanged until its evaluation supports a new kind. The conversation
offers `नकद रसीद` as an explicit photo-kind answer. Payment-tool wiring belongs to the recording
branch: preserve the photo privately and its SHA-256, use a clear reading only as a draft cash claim
(`method: 'cash'`, no UTR), ask for missing/unclear figures, then bind the person's confirmation to
the exact order/group and amount. Only the seller's confirmation settles receipt of money. This
reader never writes a ledger event or calls a payment tool.

### 3.5 Evaluation (`eval/`)

- Real images and answer keys live outside the repo: `D:\MUNSHI\CLAUDE\HACKATHON\hisaab-data\{meters,upi,challans}\` with `answers.json` per folder: `{ "<file>": { ...expected fields } }`.
- `split.json` (also outside the repo) fixes development vs held-out files **before** any held-out run; held-out results are only computed with `npm run eval -- --heldout` and are never used to tune prompts.
- The repo holds the code and `eval/results/*.json` with **aggregate numbers only** (counts, accuracy, wrong-but-confident, unclear rate, latency, tokens, cost), never file names of real images or their contents.
- `npm run eval -- photo [--heldout]` evaluates photo kind using the existing `meters`, `upi` and `challans` folders as truth, preserving every photo's existing split side. It needs no field answer key. Reports include per-kind correct (`clear: true` and matching kind), unsure (`clear: false`), wrong-but-confident (`clear: true` and wrong kind), failures, latency and cost. Empty kinds remain explicitly unassessed. Photo held-out checkpoints are recorded separately from field-reader checkpoints; selected held-out photos still require a frozen split and are never used to tune the prompt.

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

Signature: Ed25519 over the RFC 8785 canonical JSON of the message without `sig`. Receiver checks, in this order: version → known sender → signature → addressed to me → a repeat (`msg_id`, exact match) gets its original answer whatever its expiry → not expired → at most 64 KiB (except `EVIDENCE`) → type allowed for this pair → order state allows it → apply → signed `RECEIPT` (a `RECEIPT` received must itself name a message of that order). A request failing sender authentication (`UNSUPPORTED`, `NOT_CONNECTED`, `BAD_SIGNATURE`) gets the unsigned `{type: 'ERROR', code}`, which the sender treats as no answer. A refusal counts only as the direct answer to a message just delivered, never for a message with a `RECEIPT` or with later events depending on it; on its own only an evidence refusal is accepted (`declined_by_owner`, `not_kept`, `no_such_record` for our `EVIDENCE_REQUEST`, any for our `EVIDENCE`). Refusals stored earlier keep their meaning. A refusal returns a signed `REFUSE` with a code only: `UNSUPPORTED`, `NOT_CONNECTED`, `BAD_SIGNATURE`, `NOT_FOR_ME`, `EXPIRED`, `WRONG_STATE`, `BAD_BODY`; for evidence also `no_such_record`, `not_party`, `not_kept` and `declined_by_owner` (below).

| Type | From → to | Body |
|---|---|---|
| `BOOKING_REQUEST` | buyer → seller | `kind: 'jcb_hours'|'material'`, `site`, `day`, `time?`, `hoursTenths?` (JCB), `items?: {name, qtyHundredths, unit}[]` (material), `note?` |
| `BOOKING_REPLY` | seller → buyer | `answer: 'yes'|'no'|'other_time'`, `day?`, `time?`, `ratePaise?` (JCB: per hour), `rates?: {name, unit, ratePaise, gstPercent?}[]` (material: 1–20, one per requested item and unit, never two for the same name+unit, only with `yes`; `gstPercent` (30 Oct) a whole-percent GST slab 0/5/12/18/28/40 when the supplier gave one), `note?` |
| `DELIVERY` | seller → buyer | material only: `items` (as delivered, each with an agreed rate; each may carry what a tax invoice printed for it (30 Oct): `gstPercent?` (a slab), `invoiceRatePaise?`, `taxablePaise?`), `challan: {sha256, number?}` (fingerprint of the challan photo, challan number as read and confirmed), `deliveredAt`, `grandTotalPaise?` (the tax invoice's grand total as read) |
| `BILL` | seller → buyer | `lines: {what, qtyHundredths?, hoursTenths?, ratePaise, amountPaise, taxablePaise?, gstPercent?, gstPaise?}[]`, `totalPaise`, `evidence: {sha256, kind: 'meter'|'challan', readValue, takenAt, sentAt}[]`; `totalPaise` must equal the sum of `amountPaise`; never has `replaces`. A material bill's lines are the DELIVERY's items in the same order, `amountPaise = round(qtyHundredths × ratePaise / 100)` to the nearest paisa, half a paisa up (integers only; `lineAmountPaise` in `src/agents/material.js`), evidence `{kind: 'challan', sha256, readValue: challan number or null, takenAt: null, sentAt: the DELIVERY's created_at}`; the buyer's code checks this before offering the bill for acceptance. **GST (30 Oct):** when the line's GST rate is known (the supplier's yes, else the DELIVERY item's invoice reading) the line carries `taxablePaise` (= the amount above), `gstPercent`, `gstPaise` = 2 × round(taxable × gst% / 200) (CGST and SGST halves, each to the nearest paisa, half up; `gstPaise` in `src/agents/material.js`) and `amountPaise` = taxable + GST, so `totalPaise` is what is to be paid; the three come together or not at all. A bill without them is valid as before |
| `RECEIPT` | receiver → sender | `receipt_for: msg_id`, `entry_hash`, `chain_head` |
| `ACCEPT` | buyer → seller | `bill: msg_id` |
| `DISPUTE` | buyer → seller | `bill: msg_id`, `theirFigure: {hoursTenths?|qtyHundredths?|totalPaise}` (exactly one: hours for a JCB bill, a quantity only for a single-line material bill, else the total), `reason` |
| `CORRECTION` | seller → buyer | a `BILL` body that always has `replaces: msg_id` (the bill or correction it replaces) |
| `PAYMENT_CLAIM` | buyer → seller | `bill: msg_id`, `amountPaise`, `utr`, `paidOn`, `paidAt?` (`HH:MM` on 24 hours as printed on the receipt, `null` or left out when not visible; a claim without it stays valid), `screenshot: {sha256}` |
| `SETTLED` | seller → buyer | `bill: msg_id`, `payment: msg_id`, `amountPaise` |
| `REFUSE` | either | `refers_to: msg_id`, `code` |
| `SITE_RECEIPT` | buyer → supplier | material only, after the DELIVERY: the site's signed copy of the challan. `delivery: msg_id` (the DELIVERY it answers; the order is the envelope's `order_id`), `challan: {sha256, number}` (the site's photo of its copy; number as read and confirmed, or `null`), `items` (what the site wrote it received, as counted; items at 0 left out), `signed: boolean|null` (the challan reader's receiver's mark). Never changes the state. Not `RECEIPT`: that name is the transport's signed acknowledgement of every message |
| `EVIDENCE_REQUEST` | either party → the other party | `order: order_id`, `refers_to: msg_id` of one photo record, `reason: 'bill_disputed'|'count_differs'|'asked'` |
| `EVIDENCE` | record owner → requesting party | `refers_to: request msg_id`, `items: [{record: msg_id, sha256, mime, bytes: base64}]`; one requested record per exchange; photo bytes at most 5 MiB; sent only after the owner's yes (below) |

Evidence on request (Build 4; brief `ASTRA-3-evidence.md`): the order and both parties must match
before any media is read. An unavailable record returns a signed `REFUSE` with `no_such_record`,
`not_party`, or `not_kept`; invalid evidence returns a signed refusal and is never displayed.

**Owner consent (30 Oct).** A valid request for a kept photo is recorded and answered with a signed
`RECEIPT`, not with the photo. The record owner's agent asks its owner (`jcb_owner`, `supplier`, or
`contractor` for the site's photos) once per order: "हाँ" sends the `EVIDENCE` as its own signed
message to the requester; "नहीं" sends a signed `REFUSE {refers_to: request msg_id, code:
'declined_by_owner'}`. No reason is asked, nothing is sent again. No answer within the question's
window (30 minutes) sends nothing. The decision is a local `NOTE {kind: 'evidence_consent', request:
msg_id, answer: 'yes'|'no', by: role}` written before anything leaves; `prepare` refuses an
`EVIDENCE` without a `yes` for that exact request. A repeat of a request gets the same answer as
before: the receipt while undecided, then the same `EVIDENCE` (bytes re-read and re-checked) or the
same `REFUSE`. A consented `EVIDENCE` that could not be delivered stays pending and is delivered
again with its bytes taken from the private store.
The requester must already have the expected hash in its own ledger. The received bytes must hash
to exactly that value, and the item must name the requested record of that order and sender.

The signed BILL/CORRECTION's meter evidence may include `record: msg_id` of the original local
meter reading. A DISPUTE that cites a photo-based site count includes
`siteCount: {record: msg_id, sha256, number: string|null, items, at}` copied from that local NOTE.
That signed commitment is recorded before the seller requests the photo; a response can never
introduce its own expected hash. Older records without a shared record reference remain unavailable.

EVIDENCE is signed twice: the normal signature covers the full wire message including bytes;
`body.metadata_sig` signs its exact hash-only projection. After wire validation the ledger retains
that projection with the metadata signature, so ledger exports remain independently verifiable
without storing or publishing image bytes. Evidence answers are returned directly to the request;
duplicate requests rebuild the answer from private storage without reapplying history.

Transport: the official A2A JavaScript SDK, `message/send` with the message above as a `data` part (`mediaType: application/json`); Agent Card at `/.well-known/agent-card.json` per agent. If the SDK proves unusable, plain JSON-RPC in the same shape; the README then says so and claims no A2A compatibility.

### 4.1 Payments: part, cash and advance (Build 5, 30 Oct; agreed before building)

Real payments are partial, in cash, or in advance. The single "one UPI claim settles the bill" path
becomes a list of payments per order with a balance worked out by code. Old messages stay valid.

| Type | From → to | Body |
|---|---|---|
| `PAYMENT_CLAIM` (extended) | buyer → seller | `bill: msg_id \| null` (the bill in force; `null` = an advance, before any bill), `method?: 'upi' \| 'cash'` (absent = `upi`), `amountPaise` (> 0; any amount: part, full or more), `paidOn`, `paidAt?`; `upi`: `utr` and `screenshot: {sha256}` as before; `cash`: no `utr`, `screenshot?: {sha256}` (photo of a handwritten cash receipt, optional); `payeeName?` (31 Oct, `upi`: the payee the reader saw, at most 80 characters; only shown to the seller, code decides nothing from it) |
| `PAYMENT_ACK` (new) | seller → buyer | `payment: msg_id` (one claim of this order not yet answered), `received: boolean`, `amountPaise` (the claim's amount) — only on the seller's own हाँ/नहीं |
| `PAYMENT_RECEIVED` (new) | seller → buyer | the seller records money he received himself: `method: 'cash' \| 'upi'`, `amountPaise`, `receivedOn`, `bill: msg_id \| null`, `note?`; counts as confirmed at once |
| `SETTLED` (extended) | seller → buyer | new form `{bill, amountPaise (all confirmed), payments: msg_id[] (every confirmed payment counted)}`; the old form `{bill, payment, amountPaise}` stays valid. Sent by the seller's agent itself (code) as soon as the bill is accepted and confirmed ≥ the bill total in force with no claim waiting |

**When.** A claim or `PAYMENT_RECEIVED` fits an order from `booked` on and before `settled` (never
`none`, `requested`, `offered`, `declined`). With a bill in force it must name that bill; before
any bill it is an advance (`bill: null`). Several per order. A `PAYMENT_ACK` answers one claim once.

**Balance** (pure, `paymentSummary` in `src/ledger/payments.js`, used by every agent and the judge
page): `billTotal` = `totalPaise` of the bill in force (null before a bill); `confirmed` = Σ claims
answered `received: true` + Σ `PAYMENT_RECEIVED` (+ the claim named by an old-form `SETTLED`);
`pending` = claims not answered; `due` = max(billTotal − confirmed, 0); `credit` = max(confirmed −
billTotal, 0). Advances count towards the bill when it comes; a correction changes `billTotal`, never
the payments. A credit is only shown, never refunded or carried by code.

**States.** New state `part_paid`. Payments never move the state before `ACCEPT`. From `accepted`:
a claim waiting → `payment_claimed`; none waiting and 0 < confirmed < billTotal → `part_paid`; none
waiting and confirmed = 0 → `accepted`; `SETTLED` → `settled`. When the bill is accepted with
advances already covering it, the seller's agent sends `SETTLED` at once. The view adds
`billTotalPaise`, `confirmedPaise`, `pending: msg_id[]`.

**One payment for several orders ("P-1 और P-2 एक साथ").** The ledger stays per order, so a clubbed
payment is one `PAYMENT_CLAIM` (or `PAYMENT_RECEIVED`) per order, each carrying `group: {id: uuid,
totalPaise, orders: string[] (the order_ids in the group, in allocation order)}`, the same `method`,
`utr`, `screenshot`, `paidOn`, `paidAt`; each message's `amountPaise` is that order's share and the
shares add up to `totalPaise` exactly. Shares are worked out by code, never by the model: the orders
the payer named (or, when only an amount is given, every order with that counterparty that has
something due, oldest bill first) each take min(due, what is left), in order; anything left over is
an advance on the last named order when it has no bill yet, else shown as credit on it. The payer
sees the split read back once before anything is sent. The seller answers the whole group with one
हाँ/नहीं (one `PAYMENT_ACK` per claim, same answer). A UTR already used by another group or claim of
this counterparty is never accepted silently: both are shown and the payer is asked.

**People.** Contractor: a UPI screenshot of any amount (partial is no longer a mismatch: "₹10,000
मिले, बाक़ी ₹10,650"); `P-2 ₹10,000 नकद दिए`; `P-3 अग्रिम ₹5,000` (advance, UPI screenshot or नकद); `P-1 P-2 ₹39,650` with a screenshot or नकद (clubbed).
Seller: हाँ/नहीं to each claim; `P-2 ₹10,000 नकद मिले` records cash he received. Every message shows
the balance. No reminders, no "please pay", no due dates.

**Clarifications found while building (30 Oct, `claude/payments`).** (1) A `group` has 2–20 distinct
orders, the share is at most `totalPaise`, and the envelope's `order_id` must be one of `orders`
(`BAD_BODY` otherwise). (2) Between the last confirmation and the seller's `SETTLED`, an accepted order
whose confirmed money covers the bill is `part_paid` (the table above left it open; the seller's agent
sends `SETTLED` in the same step). (3) The split of a clubbed payment uses what is *owed*: `due` minus
claims still waiting (`owedPaise` in `src/agents/pay.js`); with plain `due`, a claim waiting on P-1
would be paid again by the clubbed payment. (4) `PAYMENT_ACK` and `PAYMENT_RECEIVED` fit wherever a
claim does (from `booked` on), so an advance can be confirmed before any bill. (5) The old `SETTLED`
form still needs the latest claim (as before); its claim counts as confirmed. (6) The view also keeps
`paid: {msg_id: {amountPaise, status}}`, which an ACK's amount and the new `SETTLED`'s `payments` must
match exactly. (7) `PAYMENT_RECEIVED` has no `utr`; a UPI payment the seller records himself is
`method: 'upi'` without one.

## 5. Ledger and order states (`src/ledger/`)

One SQLite file per agent. Tables are append-only (triggers refuse UPDATE/DELETE on history):

- `events(seq INTEGER PRIMARY KEY, order_id, direction 'in'|'out'|'local', type, msg_id UNIQUE, body_json, at, prev_hash, hash)` — every message sent or received (the whole signed message) and every local decision or evidence (`EVIDENCE`, `NOTE`); `hash = sha256(prev_hash + canonical(row))`. API: `src/ledger/store.js` (`openLedger`, `ensureOrder`, `append`, `view`, `fits`, `events`, `verifyChain`). A sent message refused as `EXPIRED` (the peer never saw it) gets a local `NOTE {kind: 'undelivered', msg_id, type}`: it is not retried, it counts like a refused one, and the person is told (`common.undelivered`). A sent message past `expires_at` with no signed answer may have been applied: it keeps counting and stays pending, retried hourly; a local `NOTE {kind: 'delivery_unsure', msg_id, type}` records that the person was told once (`common.delivery_unsure`). Older `undelivered` notes keep their meaning.
- `orders(order_id, kind, counterparty, site, created_at)` — identity only; the state is derived from events.

Order states (derived): `requested → booked | declined → working (jcb) | delivered (material) → billed → accepted | disputed → billed (rev n+1) → payment_claimed ⇄ part_paid → settled` (payments: section 4.1). A message that does not fit the current state is refused with `WRONG_STATE`. A `yes` on a material order must carry `rates`, and a `yes` on a JCB order must not. The site's own count of a delivery is a local `NOTE {kind: 'site_count', items, challan?: {sha256, number}}` on the buyer's ledger only (`challan` when the count came from a photo of the site's copy of the challan; it may be recorded before the DELIVERY; `challan.signed` is kept when the reader reported it); it never changes the state. When such a count with a challan photo exists together with the DELIVERY, the contractor's agent sends it to the supplier as a `SITE_RECEIPT` (at the count if the DELIVERY is there, else when it arrives); the supplier's ledger keeps it as a received message. `SITE_RECEIPT` fits a material order from `delivered` on and never changes the state.

Evidence requests, signed evidence metadata and received-photo reader notes do not change order
state. They are append-only. An automatic request is made at most once per record, checked against
the request history across restarts; a person's `सबूत <ref>` / `saboot <ref>` may request it again.
Photo bytes and MIME live only in that agent's private media directory under `HB_DATA_DIR`, outside
the repository, addressed by SHA-256. Reads recheck the hash. Tests use temporary data directories.
Confirmed photo steps persist bytes before sending the signed record; unconfirmed photos stay in
the conversation's expiring memory. No image bytes enter order events or exports.

## 6. Orchestrator (`src/orchestrator/`)

Muse Spark with tool calling turns a person's text (or transcript) into **one** proposed step: `{tool: string, args: object}`. Tools are plain functions in code; code validates every argument and the person's permission before anything happens, then reads the step back for confirmation when it commits anything. The model never chooses who may do what, never computes, never sends.

## 7. WhatsApp (`src/wa/`)

Two test numbers. Inbound: verify the `X-Hub-Signature-256` with that number's app secret; a message WhatsApp marks as forwarded (`context.forwarded` or `context.frequently_forwarded`) carries `forwarded: true` to the conversation, and a forwarded meter photo, UPI screenshot or cash receipt is refused before it is read (challans are often forwarded by a supplier's staff and are not); route by the receiving `phone_number_id` and the sender's phone to `{agent, role}`; unknown sender → one polite reply, nothing stored. Roles: `jcb_owner`, `operator`, `contractor`, `supervisor`, `supplier`. Outbound: text and verified evidence photos (JPEG/PNG media upload followed by an image message with a code caption); outside the 24-hour window nothing is sent. The image send rechecks the window after uploading. Upload/send failure or unsupported WebP image transport falls back to the same caption through the window-checked text path.

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

Read-only, from a JSON export of the ledgers (invented data in the repo for development, the live ledgers on the server). Shows every order from request to settled with the contractor's ledger beside the counterparty's (JCB for a `J-n` order, supplier for a `P-n` order), every message with "signature verified ✅" (checked in the browser), chains recomputed, the state replayed, evidence fingerprints, receipts, disputes and corrections, material items with rates, challan number and fingerprint, the site's count against the challan, and the results from `eval/results/`.

Served by the app itself at `/judge/` (`GET /judge` redirects there): only an allow-list of the page's own files (`index.html`, `judge.css`, `judge.js`, `texts.js`, `sample/export.json`), never `web/serve.js` or `web/sample/make-sample.js`, no directory listing, no path traversal; every response carries `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cache-Control: no-cache`. `GET /judge/results/` lists the aggregate files of `eval/results/` by name (`*.json`); `GET /judge/results/<name>` serves one, by validated name only.

**Export shape `hb-export/0.1`** — `GET /agents/<name>/export` (`jcb`, `site`, `supplier`), only with `Authorization: Bearer <HB_EXPORT_TOKEN>`, 404 otherwise and always when no token is configured. One side per call:

```json
{
  "v": "hb-export/0.1",
  "exportedAt": "2026-10-30T05:20:00.000Z",
  "agentId": "agent:contractor-1",
  "publicKey": "ed25519:<base64 of the raw 32-byte key>",
  "orders": [{ "order_id": "uuid", "kind": "jcb_hours", "counterparty": "agent:jcb-1", "site": "Shivpuri", "created_at": "..." }],
  "events": [{ "seq": 1, "orderId": "uuid", "direction": "out", "type": "BOOKING_REQUEST", "msgId": "uuid", "body": { "...the whole signed message..." }, "at": "...", "prevHash": "<64 hex>", "hash": "<64 hex>" }],
  "chain": { "ok": true, "events": 26 },
  "refs": { "uuid": "J-1" }
}
```

`events` are the rows of `src/ledger/store.js` in `seq` order (a local event's `body` is its own body); `chain` is `verifyChain()` at export time. `refs` (optional, added in Build 2) maps `order_id` to this side's own reference (`openRefs(ledger).refOf`); a page that does not know the field ignores it. The page combines the sides as `{v, exportedAt, jcb?, contractor?, supplier?}` and shows a missing side as "not available". The viewer types the token into the page; it is kept in `sessionStorage` only, never in the address or `localStorage`.
