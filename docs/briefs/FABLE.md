# Brief: Fable — the contractor's features, the Hindi texts and the judge page

Read `AGENTS.md` and `docs/CONTRACTS.md` first. Start no earlier than **27 October 2026, 09:30 IST**.

## Why your part matters

The contractor agent must look and feel like a real contractor's assistant, not a prop that only accepts JCB bills. Your features (the supervisor's request list, the site account) and your Hindi texts are what the contractor and supervisor see every day. The judge page is what the judges see.

## What you build (your folders: `src/contractor/`, `src/i18n/hi.js`, `web/`, `test/contractor/`, `test/web/`)

1. **Hindi texts first (27–28 Oct)**, in `src/i18n/hi.js` as keys with parameters (CONTRACTS section 9). Short, plain, polite Hindi a supervisor reads on a phone at a site; numbers as digits; no English words where a common Hindi one exists, except "JCB", "UPI", "OK". Cover: booking questions and answers, meter readings received, retake requests, bill with evidence, accept/dispute prompts, explanation wrapper, payment received/confirm, settled, refusals, help, the request list and the site account. Claude adds keys as the flows grow; you write the text.
2. **Request list (`src/contractor/requests.js`)** as in CONTRACTS section 8: add, list, decide; above the approval limit the contractor decides; the supervisor never approves his own request; every change is a new event (append-only), nothing deleted.
3. **Site account (`src/contractor/account.js`)**: `siteAccount(db, {site})` from the contractor's ledger: JCB hours, materials received, billed, paid, pending, open disputes, each line with its state and evidence count. Pure reading of the ledger; no writes.
4. **Supplier replies (from 31 Oct)**: the texts and small helpers for the sand/cement supplier's side (accept an order with a date, delivery, bill), once Claude's order flow is merged.
5. **Judge page (`web/`, from 30 Oct)**: a single static page (plain HTML/CSS/JS, no framework) that loads a JSON export of both ledgers and shows one order from request to settled for both sides: each message, "signature verified ✅", evidence fingerprints, receipts, a dispute and its correction, the payment and the settlement; plus the results from `eval/results/`. Develop it on invented data in `web/sample/`.

## Until Claude's core exists (27–28 Oct)

The ledger and messages are being built on `main`. Code your functions against the shapes in CONTRACTS with a small in-memory or temporary SQLite store of your own in tests; Claude will connect them to the real ledger when merging. Do not create tables outside `src/contractor/`.

## Rules that apply to you especially

- No model calls in your code; if a feature seems to need one, write it in `STATUS.md` (the orchestrator is Claude's).
- No invented figures: the site account shows exactly what the ledger holds; a missing value shows as `—`.
- No reminders to pay, no chasing language anywhere in the texts.
- Invented names and numbers only in `web/sample/` and tests.

## Schedule

| Day | Outcome |
|---|---|
| 27–28 Oct | Hindi texts (first set); request list + tests |
| 29 Oct | site account + tests |
| 30 Oct | judge page on sample data |
| 31 Oct – 1 Nov | supplier texts and helpers; judge page on the real export; polish |

Write progress and questions in `docs/STATUS.md` under "Fable" at the end of each session. Work on branches `fable/<topic>`; Claude merges after the tests pass on AWS.
