# Evidence on request — lead handoff

29 October 2026 (IST), branch `astra/evidence`, based on `claude/wa` at `ddfe157`.

## Changes

- `src/media/store.js`: separate private agent stores under `HB_DATA_DIR`, outside Git checkouts;
  SHA-256 filenames, MIME, 5 MiB limit, checked reads. Conversation photos are retained only when
  the person confirms their record, before any signed record leaves.
- `src/protocol/{messages,exchange,evidence}.js`, `src/ledger/{store,states}.js`, `src/agents/link.js`,
  `src/transport/a2a.js`: signed request/evidence/refusal, order/party/record checks, strict base64
  and hash checks, replay protection, response correlation, private receiver persistence.
  A separately signed metadata projection keeps ledger exports verifiable without image bytes.
- `src/agents/{evidence,evidence-readings}.js`, contractor/JCB/office/conversation hooks, app/main
  wiring: automatic requests on differences/disputes; `सबूत P-1` / `saboot J-1`; no operator access;
  one automatic request per record across restart. Meter BILL and site-count DISPUTE commitments
  name local record IDs so the peer knows the expected hash before receiving bytes.
- `src/wa/{cloud,wa}.js`: upload and image message with provenance caption; checks the 24-hour
  window before upload and again before sending; failure falls back to text. JPEG/PNG image
  messages are supported; stored WebP evidence uses text fallback.
- `src/agents/{explain,explain-facts}.js`: matching reader results become attributed observation
  notes; both sides' figures enter the existing number/wording guards. No record or decision is
  changed by a photo read. New Hindi keys and CONTRACTS/BUILD2/text-key documentation included.

## Local tests

Targeted checks: **43 tests passed, 0 failed** (42 in the combined run, followed by the additional
strict-envelope regression in the protocol file's 9/9 passing run). Files:
`test/agents/evidence.test.js`, `test/agents/evidence-explain.test.js`,
`test/protocol/evidence.test.js`, `test/media/store.test.js`,
`test/wa/evidence-image.test.js`, `test/app-evidence.test.js`,
`test/transport/a2a.test.js`, `test/i18n/hi.test.js`, `test/rules/meta-only.test.js`.

Covers private storage/integrity, signed in-memory exchange, tampering/no display, cross-order and
third-party requests/replays, stale replies, missing/corrupt media, automatic requests in either
arrival order and restart deduplication, both meter photos, exact commands/roles, checked
explanation numbers, image/text fallback, window expiry during upload, and real SDK A2A transport
with a 300 KiB image. A whole-app HTTP test verifies upload and byte-free ledger export.
Additional focused existing conversation/material/office and explanation/protocol tests passed
during integration. **No full suite or typecheck run on the laptop**; those remain Claude's AWS checks.

## Live check

Three invented disputes, six invented PNG challans generated in an OS temporary directory.
`META_API_BASE=https://api.meta.ai/v1`, `MUSE_SPARK_MODEL=muse-spark-1.3` were set for the command
only. Six reader calls and three explanation calls; no WhatsApp calls, private photos, or setting
changes. Script and fixtures were not committed.

| Supplier/site bags | Reader quantities (hundredths) | Evidence hashes / chains / no ledger bytes | Explanation number check | Duration |
|---|---|---|---|---|
| 50 / 48 | 5000 / 4800, clear | pass | pass, guard `null` | 17.732 s |
| 60 / 58 | 6000 / 5800, clear | pass | pass, guard `null` | 18.587 s |
| 75 / 70 | 7500 / 7000, clear | pass | pass, guard `null` | 15.488 s |

All three explanations returned `explain.wrapper`. Total case time 51.807 s. Actual explanations:

1. “आपके बिल में Cement 50 bag दर्ज है, कुल ₹17,500, जिसके पीछे चालान 701 की हस्ताक्षरित डिलीवरी है। दूसरे पक्ष ने चालान 701 पर Cement 48 bag दर्ज किया है, जिसके पीछे साइट की गिनती और फ़ोटो है। आपत्ति में लिखा कारण: “साइट की गिनती”।”
2. “विक्रेता पक्ष में 60 bag और कुल ₹21,000 दर्ज है, आधार हस्ताक्षरित डिलीवरी चालान 701 है। दूसरे पक्ष की आपत्ति में 58 bag दर्ज है, आधार साइट की गिनती और मिली फ़ोटो है। आपत्ति में लिखा कारण: “साइट की गिनती”।”
3. “विक्रेता की ओर 75 bag दर्ज है, आधार हस्ताक्षरित डिलीवरी चालान 701 है। दूसरे पक्ष की ओर 70 bag दर्ज है, आधार हस्ताक्षरित आपत्ति और फोटो का पढ़ना है। आपत्ति में लिखा कारण: “साइट की गिनती” है।”

These are synthetic smoke checks, not a claim about accuracy on real or handwritten photos.

## Lead follow-up / limits

- `web/judge.js` is outside this brief's assigned paths. Its `stateOf` replay needs the two new
  state-neutral message cases (`EVIDENCE_REQUEST` and remote `EVIDENCE`), matching
  `src/ledger/states.js`; otherwise evidence histories show a replay mismatch in the judge UI.
  Exported signatures and chains already verify; no bytes are exported. Requested here per
  AGENTS rule 10, rather than editing another builder's folder.
- Historical photos that were never retained return signed `not_kept`; a hash cannot recreate bytes.
- The number guard checks factual support, not whether a reader's transcription is true. Clear
  observations remain distinct from human-confirmed figures; unclear observations add no numbers.
- New Hindi text is **Astra drafted, Fable to polish**. No merge, deployment, server access, or
  Meta/WhatsApp settings changed.
