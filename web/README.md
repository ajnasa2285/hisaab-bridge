# Judge page (`web/`)

A single static page, plain HTML/CSS/JS, no framework, no build step. It loads a JSON export of
both ledgers and shows one JCB order from request to settled, side by side: the JCB owner's ledger
on the left, the contractor's on the right. Every signed message is verified **in the browser**
(WebCrypto Ed25519 over RFC 8785 canonical JSON, the same bytes `src/protocol/canonical.js`
produces) and each ledger's hash chain is recomputed there too.

## Run it

```
node web/sample/make-sample.js    # makes web/sample/export.json with the real agents, invented data
node web/serve.js                 # http://127.0.0.1:8787/web/
```

`web/serve.js` only serves the repository root; it lists `eval/results/` as JSON for the results
panel. Any static server works for the page itself; the "open another export" button loads a
JSON file from disk, so no server endpoint is needed to look at a real export.

Labels are in Hindi; the button at the top switches to English for judges. Texts live in
`web/texts.js` (the product's own texts are in `src/i18n/hi.js`).

## What the page shows

- each event with its sequence number, type, sent/received/local, time (IST) and
  "signature verified ✅" (or ❌ when the signature does not match the sender's public key,
  ⚠️ when the browser has no Ed25519 in WebCrypto);
- the evidence fingerprints (sha256, shortened) with the meter readings, on the local
  `EVIDENCE` rows and inside the bill;
- every `RECEIPT` with `receipt_for`, `entry_hash`, `chain_head`;
- the dispute and its correction: the first bill stays in the list, struck through, with
  "replaced by a correction — kept in history"; the correction names what it replaces;
- the payment claim (amount, UTR, day, screenshot fingerprint) and the settlement;
- the chain check of each ledger and the state replayed from its events;
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
    "chain": { "ok": true, "events": 14 }
  },
  "contractor": { "...same shape..." }
}
```

- `events` are the rows of `src/ledger/store.js` (`LedgerEvent`), every order's events in `seq`
  order. For a sent or received message `body` is the whole signed message (its own `body`
  inside); for a local event (`EVIDENCE`, `NOTE`) `body` is the event's own body.
- `chain` is the ledger's `verifyChain()` at export time; the page recomputes it anyway.
- Signatures are checked with the `publicKey` of the side whose `agentId` equals the message's
  `from`. An export therefore carries both public keys and no private material.
- The server's `GET /export/<agent>` (CONTRACTS section 10) is expected to return one side in
  this shape; the page takes the two sides together as above.

## Sample data

`web/sample/make-sample.js` runs the same flow as `test/agents/job.test.js` with the real agents
over real A2A HTTP between two in-memory ledgers: request → yes at ₹1,200/h → start and end meter
→ bill 6.1 h → dispute 5.5 h → correction → accept → payment claim → settled. Names, phones
(`9190000000xx`), fingerprints and UTR are invented. Keys are generated fresh on each run, so the
file differs run to run; `test/web/sample.test.js` checks that the committed export's signatures
verify and both chains recompute.
