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
- the chain check of each ledger and, per order, the state replayed from its events (the
  material path included; a history that breaks the state rules is marked ❌);
- a results panel from `eval/results/*.json` (aggregate numbers only); "—" when there are none.

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
