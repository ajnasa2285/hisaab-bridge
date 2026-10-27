# Status

Each builder adds a dated entry (IST) at the end of every work session: **done, next, blocked, questions**. Newest first under your name. Claude reads this file to merge, answer and adjust `docs/CONTRACTS.md`.

## Owner

- Data folder: `D:\MUNSHI\CLAUDE\HACKATHON\hisaab-data\{meters,upi,challans,voice}\` (outside the repo).

## Claude (lead, integrator)

- 2026-10-27 10:15 — Done: `src/transport/a2a.js` on the official A2A JS SDK 1.3.0 (`@a2a-js/sdk`, dependency added): Agent Card at `/.well-known/agent-card.json` with our extension marked required (agent id + public key), JSON-RPC `SendMessage` with our signed message as a `data` part, the answer (signed RECEIPT/REFUSE) back as a `data` part; the client declares the extension in `A2A-Extensions`. Tested over real HTTP: receipt, repeat answered the same, tampering refused. `test/rules/meta-only.test.js` fails the build if any other model provider appears in `src/` or `package.json`. 32 tests pass. Next: WhatsApp receiver for two numbers, then the agents (JCB, contractor) wiring their people to these messages.
- 2026-10-27 09:50 — Done: project setup (package.json, tsconfig, `npm test`, `npm run typecheck`); `src/protocol/` canonical JSON (RFC 8785), Ed25519 keys and signatures, message types and the receiver's checks, the exchange (receive → ledger → signed RECEIPT/REFUSE; prepare; record the answer; repeats answered the same); `src/ledger/` append-only SQLite with hash chain and order states. 27 tests pass. Rule added: a JCB bill must carry meter evidence (`kind: 'meter'`), because the buyer's ledger never sees the seller's local photos. Next: A2A transport (official SDK) and the WhatsApp receiver for two numbers.
- 2026-10-27 01:40 — Rules (`AGENTS.md`), interfaces (`docs/CONTRACTS.md`) and briefs written as documents before the building period; committed after 09:30 IST. Next from 09:30: protocol (canonical JSON, Ed25519, checks), ledger, WhatsApp receiver for two numbers.

## Astra

(no entries yet)

## Fable

- 2026-10-27 — Done (branch `fable/hindi-requests`, 57 tests pass, typecheck clean):
  - `src/i18n/hi.js`: all 40 keys from `docs/text-keys.md` (main 32d0893) written first, with a test that each exists and uses only the parameters the agents pass; `jcb.payment_claimed` says the contractor *says* they paid and asks the owner to check the account (test guards against "money arrived" wording). Then 113 keys of my own with `{parameters}` covering booking, meter readings/retakes, bill with evidence, accept/dispute, explanation wrapper, payment received/confirm, settled, refusals (the 7 REFUSE codes + our own), help per role, request list, site account, order-state names, and `wa.unknown_sender` as Claude asked. Tests: every key fills, no placeholder left, no Latin beyond JCB/UPI/UTR/OK, no chasing language.
  - `src/i18n/index.js`: a minimal strict `t(key, params)` (unknown key or missing parameter throws) plus `keys()` and `paramsOf()`. The mechanism is Claude's per CONTRACTS: replace freely, keep hi.js.
  - `src/i18n/format.js`: `rupees(paise)` with Indian grouping, `hours(tenths)`, `qty(hundredths, unit)`, `day(YYYY-MM-DD)` in Hindi, `orNone` for `—`. Integers only.
  - `src/contractor/requests.js`: `addRequest` / `listRequests` / `decideRequest` on one append-only table `request_events` (triggers refuse UPDATE/DELETE), status replayed from events. Also `advanceRequest` (approved → sent with orderId → done), `requestHistory`, `approvalLimitPaise(env)`, `RequestError` with codes BAD_INPUT / NOT_FOUND / OWN_REQUEST / WRONG_STATE.
  - `src/contractor/account.js`: `siteAccount(db, {site})` reads `orders`/`events` only; `accountText(account)` renders it in Hindi with `—` for anything the ledger does not hold.
- Where I read CONTRACTS literally or added to it (please confirm or correct):
  - `db` in section 8 is accepted as either a `DatabaseSync` or a ledger object carrying `.db`, so both call styles work when you wire it.
  - `Request` carries two extra fields beyond section 8: `by` (needed for "never approves his own" and for `listRequests({by})`) and `estimatePaise` (the "estimated value" the limit compares against; nothing in the signature supplied it). `addRequest` takes optional `estimatePaise`, `limitPaise` (default `CONTRACTOR_APPROVAL_LIMIT_PAISE`, unset = 0) and `at`. An unknown estimate is treated as above the limit (never guess). Within the limit the request is `approved` with `approvedBy: null`.
  - `decideRequest` refuses both approve and decline from the requester (OWN_REQUEST); it does not check the decider's role: that is the WhatsApp router's knowledge, so the caller must.
  - Section 8 has no way to move a request to `sent`/`done`; `advanceRequest` fills that. Drop it if the order flow does this differently.
  - `siteAccount` lines use `amountPaise: number|null` (null before a bill) instead of `number`, so no 0 is invented; `jcbBilled` flag added so hours show `—` rather than 0 when no JCB bill exists. Paid counts SETTLED only.
  - Hindi words kept as common loans: साइट, सुपरवाइज़र, फ़ोटो; UTR allowed in Latin next to UPI.
- Next: judge page on `web/sample/` (30 Oct), supplier texts/helpers once the order flow is merged; more keys as Claude's flows name them.
- Blocked: nothing.
