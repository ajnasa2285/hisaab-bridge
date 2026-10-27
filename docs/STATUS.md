# Status

Each builder adds a dated entry (IST) at the end of every work session: **done, next, blocked, questions**. Newest first under your name. Claude reads this file to merge, answer and adjust `docs/CONTRACTS.md`.

## Owner

- Data folder: `D:\MUNSHI\CLAUDE\HACKATHON\hisaab-data\{meters,upi,challans,voice}\` (outside the repo).

## Claude (lead, integrator)

- 2026-10-27 11:40 — Done: `src/wa/` WhatsApp Cloud API side for two lines. One webhook path per line (`/wa/<line>/webhook`), each line its own Meta app: handshake with that line's verify token; `X-Hub-Signature-256` checked on the raw bytes with that line's app secret before parsing; messages claiming another line ignored; each message id handled once (Meta re-delivers); routing by receiving `phone_number_id` + sender to `{agent, role, name}` (`src/wa/directory.js`; the same phone can be a different person-in-role on each line); unknown sender gets one reply per process and nothing about them is stored; replies only inside the 24-hour window; text sending and media download (size cap, sha256 check) in `src/wa/cloud.js`; phones in logs as last four digits. Graph API version defaults to `v23.0`, configurable. 46 tests pass. **Fable:** please add key `wa.unknown_sender` to `src/i18n/hi.js` (one polite line: this number is for registered site/JCB users only; no contact details). Next: the agents (JCB, contractor) wiring people to the protocol messages.
- 2026-10-27 10:15 — Done: `src/transport/a2a.js` on the official A2A JS SDK 1.3.0 (`@a2a-js/sdk`, dependency added): Agent Card at `/.well-known/agent-card.json` with our extension marked required (agent id + public key), JSON-RPC `SendMessage` with our signed message as a `data` part, the answer (signed RECEIPT/REFUSE) back as a `data` part; the client declares the extension in `A2A-Extensions`. Tested over real HTTP: receipt, repeat answered the same, tampering refused. `test/rules/meta-only.test.js` fails the build if any other model provider appears in `src/` or `package.json`. 32 tests pass. Next: WhatsApp receiver for two numbers, then the agents (JCB, contractor) wiring their people to these messages.
- 2026-10-27 09:50 — Done: project setup (package.json, tsconfig, `npm test`, `npm run typecheck`); `src/protocol/` canonical JSON (RFC 8785), Ed25519 keys and signatures, message types and the receiver's checks, the exchange (receive → ledger → signed RECEIPT/REFUSE; prepare; record the answer; repeats answered the same); `src/ledger/` append-only SQLite with hash chain and order states. 27 tests pass. Rule added: a JCB bill must carry meter evidence (`kind: 'meter'`), because the buyer's ledger never sees the seller's local photos. Next: A2A transport (official SDK) and the WhatsApp receiver for two numbers.
- 2026-10-27 01:40 — Rules (`AGENTS.md`), interfaces (`docs/CONTRACTS.md`) and briefs written as documents before the building period; committed after 09:30 IST. Next from 09:30: protocol (canonical JSON, Ed25519, checks), ledger, WhatsApp receiver for two numbers.

## Astra

(no entries yet)

## Fable

(no entries yet)
