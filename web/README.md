# Judge page (`web/`)

A single static page, plain HTML/CSS/JS, no framework, no build step. It loads a JSON export of
the three ledgers (JCB, contractor, supplier) and shows every order from request to settled, side
by side per order: the counterparty's ledger on the left (JCB for a `J-n` order, supplier for a
`P-n` order), the contractor's on the right. Every signed message is verified **in the browser**
(WebCrypto Ed25519 over RFC 8785 canonical JSON, the same bytes `src/protocol/canonical.js`
produces) and each ledger's hash chain is recomputed there too.

## Run it

On the server the app serves the page itself at `https://<address>/judge/` (`src/app.js`: an
allow-list of these files, the page's security headers, `/judge/results/` for the results panel).
For development:

```
node web/sample/make-sample.js    # makes web/sample/export.json with the real agents, invented data
node web/serve.js                 # http://127.0.0.1:8787/web/
```

`web/serve.js` serves the repository root and answers `web/results/` from `eval/results/` the way
the app does; it is never deployed. The "open another export" button loads a JSON file from disk.

## Sources

- **Sample** (default): `web/sample/export.json`, invented data.
- **File**: any export opened from disk (the combined shape below).
- **Live ledgers**: the viewer types the access key (`HB_EXPORT_TOKEN` of the server) into the
  field; the page sends it as `Authorization: Bearer` to `../agents/jcb/export`,
  `../agents/site/export` and `../agents/supplier/export`. The key is kept in `sessionStorage`
  only (this tab, until it closes), never in the address and never in `localStorage`. A side the
  server does not have is shown as "not available"; a key the server does not accept gives one
  plain message and the page keeps what it was showing.

Labels are in Hindi; the button at the top switches to English for judges. Texts live in
`web/texts.js` (the product's own texts are in `src/i18n/hi.js`).

## What the page shows

- each event with its sequence number, type, sent/received/local, time (IST) and
  "signature verified ✅" (or ❌ when the signature does not match the sender's public key,
  ⚠️ when the browser has no Ed25519 in WebCrypto);
- the evidence fingerprints (sha256, shortened) with the meter readings, on the local
  `EVIDENCE` rows and inside the bill;
- for a material order: the items requested, the supplier's rate per item, the `DELIVERY` with the
  items delivered, challan number and challan photo fingerprint, the site's own count (a local
  `NOTE` on the contractor's side) against the challan with "differs ⚠️" or "matches ✅", bill
  lines as quantity × rate, and the challan as the bill's evidence;
- each side's reference for the order (`J-1`, `P-1`) when the export carries `refs`;
- every `RECEIPT` with `receipt_for`, `entry_hash`, `chain_head`;
- the dispute and its correction: the first bill stays in the list, struck through, with
  "replaced by a correction — kept in history"; the correction names what it replaces;
- the payment claim (amount, UTR, day, screenshot fingerprint) and the settlement;
- a payment panel per side and order: method, advance, confirmed/waiting/denied status, billed,
  confirmed, waiting, due and credit, all from `src/ledger/payments.js`; clubbed payments link to
  their other orders with the same group total, and each order shows only its own share;
- the chain check of each ledger and, per order, the state replayed from its events (the
  material path included; a history that breaks the state rules is marked ❌);
- a results panel from `eval/results/*.json` (aggregate numbers only); "—" when there are none;
- **inside the agent** (below), under each side's column.

## Export shape (`hb-export/0.1`)

```json
{
  "v": "hb-export/0.1",
  "exportedAt": "2026-10-30T05:20:00.000Z",
  "jcb": {
    "agentId": "agent:jcb-1",
    "publicKey": "ed25519:<base64 of the raw 32-byte key>",
    "orders": [{ "order_id": "uuid", "kind": "jcb_hours", "counterparty": "agent:contractor-1", "site": "Shivpuri", "created_at": "..." }],
    "events": [
      {
        "seq": 1, "orderId": "uuid", "direction": "in", "type": "BOOKING_REQUEST", "msgId": "uuid",
        "body": { "...the whole signed message, with sig..." },
        "at": "2026-10-28T03:30:00.000Z", "prevHash": "<64 hex>", "hash": "<64 hex>"
      }
    ],
    "chain": { "ok": true, "events": 14 },
    "refs": { "uuid": "J-1" }
  },
  "contractor": { "...same shape..." },
  "supplier": { "...same shape..." }
}
```

- `events` are the rows of `src/ledger/store.js` (`LedgerEvent`), every order's events in `seq`
  order. For a sent or received message `body` is the whole signed message (its own `body`
  inside); for a local event (`EVIDENCE`, `NOTE`) `body` is the event's own body.
- `chain` is the ledger's `verifyChain()` at export time; the page recomputes it anyway.
- Signatures are checked with the `publicKey` of the side whose `agentId` equals the message's
  `from`. An export therefore carries both public keys and no private material.
- `refs` (optional) maps `order_id` to that side's own reference, `J-n` or `P-n`.
- `trace` (optional) is that agent's trace entries, oldest first, in the shape of `GET /agents/<name>/trace` (below).
- The server's `GET /agents/<name>/export` (CONTRACTS section 10) returns one side in this shape
  (the inner object, with `v` and `exportedAt` of its own); the page combines the sides as above.
  A side may be missing.

## Sample data

`web/sample/make-sample.js` runs two jobs with the real agents over real A2A HTTP between three
in-memory ledgers. The JCB job (`J-1`): request → yes at ₹1,200/h → start and end meter → bill
6.1 h → dispute 5.5 h → correction → accept → payment claim → settled. The material job (`P-1`,
with the supplier): 50 bags of cement → yes at ₹350/बोरी → delivery with challan 412 → the site
counts 48 → bill 50 × ₹350 → dispute 48 → correction → accept → payment claim → settled. Names,
phones (`9190000000xx`), fingerprints and UTRs are invented. Keys are generated fresh on each run,
so the file differs run to run; `test/web/sample.test.js` checks that the committed export's
signatures verify, all three chains recompute, and both stories are there.

The generator then adds `P-2` and `P-3` as signed invented events in the agreed CONTRACTS 4.1
shapes, independent of the parallel recording-tools branch. They show a cash advance, a partial
cash claim acknowledged by the seller, one UPI payment allocated across both orders, a waiting
claim, a denied claim and credit. Both exported sides contain the same signed payment messages.
These extra events are constructed for the export; they do not bypass runtime ledger checks.

The browser imports the exact pure balance module at `/src/ledger/payments.js`; the app serves
only this source path, alongside its explicit judge-file allow-list. No other source is exposed.

## Inside the agent

Under each side's ledger column, every order gets a timeline of what happened inside that agent for
it, from the agent's own trace (`src/trace/`, kept apart from the ledger):

- ✨ **Meta model** rows, marked `META`: the job (understood the message, what the photo is, read the
  hour meter / UPI receipt / challan, voice to text, explained the difference, question lookups and
  answer), the model id, reasoning effort, latency, and the structured output (tool and arguments,
  photo kind and clear, the reading's fields, the explanation's length);
- 🔎 **code checks** with ✓ / ✗ and the figures ("meter end above start ✓ 1240.6 > 1234.5", "hours =
  end − start … = ₹7,320", "bill = delivered × agreed rate ✓", "site count vs signed delivery ✗
  differs", "every number in the explanation is in the ledger ✓"), and ⏸ for a step held for approval
  ("approval needed: no limit set → held for the contractor");
- payment audit checks after ledger writes: balance, complete group shares versus their total
  (and whether they match `allocate`), and whether the UTR appeared in an earlier payment of the
  same counterparty; shares of one group may use the same UTR. These checks never make decisions;
- 🙋 **people's decisions**: who decided, for whom, and their exact short reply ("OK J-1", "हाँ 1200")
  when the server keeps words (`HB_TRACE_TEXT=1`);
- 📤 / 📥 **signed messages** out and in: type, to/from, signature verified, the A2A round trip,
  the receipt; 📒 **ledger rows** with sequence and hash prefixes. Both link to the ledger card above
  (`ledger row #n`);
- 📩 messages in (text, command, photo, voice) and 💬 replies (the text key, and the time since the
  message arrived).

The order's header sums both agents: Muse calls, total model time, checks passed, people's decisions.

**Live.** With the access key entered, the "live (every 3 s)" box fetches the three ledgers and the
three traces again every 3 seconds, redraws only when something changed, and scrolls each timeline
to its newest entry. Laid out to be read at 1280×720 for screen recording.

**Trace endpoint.** `GET /agents/<name>/trace?since=<iso>&order=<ref>` with the same
`Authorization: Bearer <HB_EXPORT_TOKEN>` as the export (404 without it, and always 404 when no token
is configured):

```json
{
  "v": "hb-trace/0.1", "exportedAt": "...", "agentId": "agent:jcb-1", "name": "jcb",
  "entries": [
    { "id": 17, "at": "2026-10-29T03:05:00.000Z", "agent": "jcb", "orderId": "uuid", "ref": "J-1",
      "convo": "c-1a2b3c4d5e", "kind": "model", "title": "meter reads 1234.5",
      "detail": { "job": "meter", "model": "muse-spark-1.2", "reasoningEffort": "default", "raw": "1234.5", "valueTenths": 12345, "clear": true },
      "ms": 2620 }
  ]
}
```

`kind` is one of `received`, `model`, `check`, `decision`, `signed_out`, `signed_in`, `ledger`,
`reply`. `convo` is a keyed hash of the person (never a phone). A trace never holds a key, image or
audio bytes, or a prompt; people's words only with `HB_TRACE_TEXT=1`, every run of 8+ digits masked
(a UTR only in its own field). The page's rendering is in `web/trace-view.js` (pure functions,
`test/web/trace-view.test.js`).

In the first two sample stories, the code checks, decisions, signed messages and ledger rows are the real agents' own
(recorded by the same hooks); the Muse steps are invented entries with invented latencies, since the
sample runs without a model, and the explanations go through the real explanation checks with a
stand-in's fixed words.
