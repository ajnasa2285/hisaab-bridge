# Status

Each builder adds a dated entry (IST) at the end of every work session: **done, next, blocked, questions**. Newest first under your name. Claude reads this file to merge, answer and adjust `docs/CONTRACTS.md`.

## Owner

- Data folder: `D:\MUNSHI\CLAUDE\HACKATHON\hisaab-data\{meters,upi,challans,voice}\` (outside the repo).

## Claude (lead, integrator)

- 2026-10-27 10:15 — Done: `src/transport/a2a.js` on the official A2A JS SDK 1.3.0 (`@a2a-js/sdk`, dependency added): Agent Card at `/.well-known/agent-card.json` with our extension marked required (agent id + public key), JSON-RPC `SendMessage` with our signed message as a `data` part, the answer (signed RECEIPT/REFUSE) back as a `data` part; the client declares the extension in `A2A-Extensions`. Tested over real HTTP: receipt, repeat answered the same, tampering refused. `test/rules/meta-only.test.js` fails the build if any other model provider appears in `src/` or `package.json`. 32 tests pass. Next: WhatsApp receiver for two numbers, then the agents (JCB, contractor) wiring their people to these messages.
- 2026-10-27 09:50 — Done: project setup (package.json, tsconfig, `npm test`, `npm run typecheck`); `src/protocol/` canonical JSON (RFC 8785), Ed25519 keys and signatures, message types and the receiver's checks, the exchange (receive → ledger → signed RECEIPT/REFUSE; prepare; record the answer; repeats answered the same); `src/ledger/` append-only SQLite with hash chain and order states. 27 tests pass. Rule added: a JCB bill must carry meter evidence (`kind: 'meter'`), because the buyer's ledger never sees the seller's local photos. Next: A2A transport (official SDK) and the WhatsApp receiver for two numbers.
- 2026-10-27 01:40 — Rules (`AGENTS.md`), interfaces (`docs/CONTRACTS.md`) and briefs written as documents before the building period; committed after 09:30 IST. Next from 09:30: protocol (canonical JSON, Ed25519, checks), ledger, WhatsApp receiver for two numbers.

## Astra

- 2026-10-27 11:27 IST — Done: branch `astra/meter-v1`; official Meta docs verified in `docs/meta-api-notes.md`. Sandbox DNS initially blocked access; with network enabled, one live model-catalog request confirmed standard Spark 1.3/1.2/1.1 and Voice Transcribe 1.0, and a synthetic Spark request passed. Built `museSpark`, WAV-only `transcribe`, bounded retries, local schema/tool-argument validation and private-safe cost accounting; meter v1 preserves raw digits, converts by integer arithmetic, and returns null on uncertainty. Built the Windows answer-key CLI, grouped split/freeze guards, private prediction cache, cached rescoring, and aggregate evaluation reports. First development run: 11 evaluated, 9 numeric readings, 2 unclear (18.18%), 0 API failures; p50 7,045 ms, p95 14,885 ms; 24,914 input / 15,158 output tokens, estimated $0.0945036. **Accuracy and wrong-but-confident are unknown (`null`), not zero: no human answers exist.** Initial photos are all one development group; no held-out run. `npm run typecheck` and all 80 tests pass (full tests need localhost access for existing A2A tests). No dependencies added; tests use invented fixtures only.
  - Next: owner labels via `node eval/answer-key.js`, then `npm --prefix eval run eval -- meter --score-latest` computes accuracy without another model call. Add future capture groups before freezing for the 28 Oct held-out checkpoint. UPI and challan readers follow the brief's later schedule.
  - Blocked: honest accuracy needs the owner's confirmed answers; work proceeded through the complete unlabelled development run without waiting. Voice supports documented mono PCM WAV only; real voice samples have not arrived.
  - Questions / Claude integration: please add root scripts `"eval": "node eval/run.js"` and `"answer-key": "node eval/answer-key.js"` (root package is outside Astra's ownership; working scripts are in `eval/package.json`). Please confirm the later dataset/checkpoint policy for adding photos after split freeze. Please arrange upstream WhatsApp audio conversion to supported WAV. The dependency-free client rejects unsupported JSON Schema keywords (including `$ref`/`format`); coordinate any richer orchestrator schema before using it. Merge only after your AWS checks; Astra will not merge main.

## Fable

(no entries yet)
