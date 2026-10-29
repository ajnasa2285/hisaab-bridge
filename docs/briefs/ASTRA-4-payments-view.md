# Brief: Astra, Build 5: everyone sees the payments and the balance

Read `AGENTS.md`, `docs/CONTRACTS.md` — above all **section 4.1 Payments (agreed before building)** — `docs/BUILD2.md` (Ask anything, Explanations, Inside the agent, GST on material) and `docs/text-keys.md` first. The lead (Claude) reviews, runs the full suite and the typecheck on AWS, merges and deploys. You build on a branch and stop there.

## Worktree and branch
Work only in your own worktree; never switch branches in `hb-claude` (the lead's checkout) or `hb-pay` (another session running now):
`git -C D:\MUNSHI\CLAUDE\HACKATHON\hb-claude worktree add ..\hb-astra-payview -b astra/payments-view claude/wa`
Commit with the repo's configured identity. Push only the branch: `git push origin astra/payments-view`. Never push to main.

## Why
Real payments are partial, in cash, in advance, or one payment for several orders (P-1 and P-2 together). Another session (`claude/payments`) builds the recording side: the messages (PAYMENT_CLAIM extended, PAYMENT_ACK, PAYMENT_RECEIVED, SETTLED new form), the states (`part_paid`), the agents' tools and the WhatsApp phrases. You build the read side, so every person and the judges see the same payments and the same balance. Both of you read payments only through `paymentSummary` and `allocate` in `src/ledger/payments.js` (already on `claude/wa`, tested). Do not change their signatures; if you need a field, add it and say so. Do not edit `src/protocol/`, `src/ledger/states.js`, or the agents' payment tools: that is the other session's.

Build against the contract and the summary function, with ledgers in your tests built from the event shapes in CONTRACTS 4.1 (you can append those events directly in a test ledger; you do not need the other branch).

## What to build
1. **Ask anything** (`src/agents/ask.js`): the `payments` and `totals` lookups and `order_detail` use `paymentSummary`: each payment with method (UPI/नकद), advance or not, group (clubbed with which refs), status (waiting/confirmed/denied), and per order billed, confirmed, waiting, due, credit. New questions must work: "P-2 का कितना बाक़ी है?", "इस महीने कितना नकद दिया?", "कौन सा पेमेंट अभी पक्का नहीं हुआ?", "P-1 और P-2 का एक साथ कितना दिया था?". Every number still checked by code.
2. **Explanations** (`src/agents/explain-facts.js`): when a difference involves payments (a denied claim, more paid than billed), the facts include the payments and the balance as plain figures.
3. **Status and बाक़ी** (`src/agents/office.js` status/pending text only): an order's line shows paid / due / credit and waiting claims; the seller's बाक़ी lists claims waiting for his हाँ (a clubbed group as one line).
4. **24-hour window list** (`waiting(role)` in the agents, read-only part): a claim or group waiting for the seller's हाँ is rebuilt like the other waiting items.
5. **Judge page and trace** (`web/`, `src/trace/`): per order a payments panel (each payment, method, group, status, the balance line) and the clubbed group shown across its orders; trace `check` lines for "shares add up to the total", "balance", "UTR not used before". Update `web/sample/make-sample.js` with an invented part/cash/advance/clubbed example.
6. **Cash receipt photo (parchi)**: a handwritten or printed cash receipt. Muse Spark reads it with a strict schema (`src/readers/cash-receipt.js`: amount as written, date, receiver's name or mark, a reference/serial if any, clear) — one call, image text is data, unsure → clear=false. Add the kind `cash_receipt` to the photo-kind reader only if the photo-kind eval and tests stay as good; otherwise the conversation asks "यह फ़ोटो क्या है?" with a new option. Expose a function the other session can call: `readCashReceipt({mime, bytes})` (CONTRACTS section 3, new 3.7). Do not wire it into the payment tools yourself; describe in your report how it should be wired.
7. **Texts and docs**: new keys in `src/i18n/hi.js` and `docs/text-keys.md` ("Astra drafted, Fable to polish"), no "—" for absent values; a short "Payments on every screen" section in `docs/BUILD2.md`; CONTRACTS 3.7.

## Tests (node:test, invented data, phones `9190000000xx`)
Ask-anything answers with part/cash/advance/clubbed ledgers (stand-in spark; numbers checked); explanation facts with payments; status/बाक़ी lines; waiting list; judge page rendering functions; cash receipt reader schema/unsure/errors; `test/rules/meta-only.test.js` still passes.

## Live check (cheap, allowed)
`META_API_KEY` is in the environment; set `META_API_BASE=https://api.meta.ai/v1` and `MUSE_SPARK_MODEL=muse-spark-1.3` for the command only. With a throwaway script outside the repo: 4–6 ask-anything payment questions over an invented ledger, and the cash-receipt reader on 3–4 invented receipts you render yourself (never the owner's private photos). Report answers, number checks, readings. Never print the key; do not commit the script.

## Machine limits
On the owner's laptop: do not run `npm run typecheck` or the whole `npm test`; run only the test files you touch.

## Done means
Branch pushed; a short report for the lead: files changed, live-check results, tests added and their local result, how to wire the cash receipt reader, anything unsure. Do not merge, deploy, or touch the server or any Meta/WhatsApp setting.
