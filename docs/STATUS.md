# Status

Each builder adds a dated entry (IST) at the end of every work session: **done, next, blocked, questions**. Newest first under your name. Claude reads this file to merge, answer and adjust `docs/CONTRACTS.md`.

## Owner

- Data folder: `D:\MUNSHI\CLAUDE\HACKATHON\hisaab-data\{meters,upi,challans,voice}\` (outside the repo).

## Claude (lead, integrator)

- 2026-10-27 12:40 — Done: `src/agents/`: `link.js` (prepare → deliver over A2A → keep the answer; unreachable messages stay pending and are re-delivered unchanged), `common.js` (tools with roles checked by code, `runTool`), `jcb.js` (reply_booking with rate, record_meter start/end confirmed by the operator, send_bill from the two readings and our agreed rate with both photos as evidence, send_correction, confirm_payment; owner told on request/accept/dispute/payment claim), `contractor.js` (request_jcb by contractor or supervisor, accept/dispute/claim_payment by the contractor only; contractor and supervisor told on reply/bill/correction, contractor on settled). `src/i18n/format.js` formats ₹, hours, quantities. A whole job (request → yes → meter → bill → dispute → correction → accept → payment claim → settled) runs over real A2A HTTP with both ledgers settled, chains intact and the same signed messages on both sides. 50 tests pass. Text keys the agents use are listed in `docs/text-keys.md` (**Fable:** please write them in `hi.js`). Known gap: if the other agent REFUSES a message we already wrote, our view moves ahead of theirs; next I will make a refused message not count in our own state. Next: the orchestrator (Muse Spark: text → one step) once Astra's `src/meta/client.js` lands; the server that wires WhatsApp, agents and A2A.
- 2026-10-27 11:40 — Done: `src/wa/` WhatsApp Cloud API side for two lines. One webhook path per line (`/wa/<line>/webhook`), each line its own Meta app: handshake with that line's verify token; `X-Hub-Signature-256` checked on the raw bytes with that line's app secret before parsing; messages claiming another line ignored; each message id handled once (Meta re-delivers); routing by receiving `phone_number_id` + sender to `{agent, role, name}` (`src/wa/directory.js`; the same phone can be a different person-in-role on each line); unknown sender gets one reply per process and nothing about them is stored; replies only inside the 24-hour window; text sending and media download (size cap, sha256 check) in `src/wa/cloud.js`; phones in logs as last four digits. Graph API version defaults to `v23.0`, configurable. 46 tests pass. **Fable:** please add key `wa.unknown_sender` to `src/i18n/hi.js` (one polite line: this number is for registered site/JCB users only; no contact details). Next: the agents (JCB, contractor) wiring people to the protocol messages.
- 2026-10-27 10:15 — Done: `src/transport/a2a.js` on the official A2A JS SDK 1.3.0 (`@a2a-js/sdk`, dependency added): Agent Card at `/.well-known/agent-card.json` with our extension marked required (agent id + public key), JSON-RPC `SendMessage` with our signed message as a `data` part, the answer (signed RECEIPT/REFUSE) back as a `data` part; the client declares the extension in `A2A-Extensions`. Tested over real HTTP: receipt, repeat answered the same, tampering refused. `test/rules/meta-only.test.js` fails the build if any other model provider appears in `src/` or `package.json`. 32 tests pass. Next: WhatsApp receiver for two numbers, then the agents (JCB, contractor) wiring their people to these messages.
- 2026-10-27 09:50 — Done: project setup (package.json, tsconfig, `npm test`, `npm run typecheck`); `src/protocol/` canonical JSON (RFC 8785), Ed25519 keys and signatures, message types and the receiver's checks, the exchange (receive → ledger → signed RECEIPT/REFUSE; prepare; record the answer; repeats answered the same); `src/ledger/` append-only SQLite with hash chain and order states. 27 tests pass. Rule added: a JCB bill must carry meter evidence (`kind: 'meter'`), because the buyer's ledger never sees the seller's local photos. Next: A2A transport (official SDK) and the WhatsApp receiver for two numbers.
- 2026-10-27 01:40 — Rules (`AGENTS.md`), interfaces (`docs/CONTRACTS.md`) and briefs written as documents before the building period; committed after 09:30 IST. Next from 09:30: protocol (canonical JSON, Ed25519, checks), ledger, WhatsApp receiver for two numbers.

## Astra

(no entries yet)

## Fable

(no entries yet)
