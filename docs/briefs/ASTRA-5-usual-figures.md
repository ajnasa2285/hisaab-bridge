# Brief: Astra, Build 6: each agent remembers the usual figures and flags the unusual

Read `AGENTS.md`, `docs/CONTRACTS.md`, `docs/BUILD2.md` (Ask anything, Explanations, Inside the agent, GST on material, Payments on every screen) and `docs/text-keys.md` first. The lead (Claude) reviews, runs the full suite and the typecheck on AWS, merges and deploys. You build on a branch and stop there. Feature freeze is 1 Nov: finish by 31 Oct evening.

## Worktree and branch
Work only in your own worktree; never switch branches in `hb-claude` (the lead's checkout) or `hb-learn` (another session running now):
`git -C D:\MUNSHI\CLAUDE\HACKATHON\hb-claude worktree add ..\hb-astra-usual -b astra/usual-figures claude/wa`
Run `npm ci` in the new worktree first. Commit with the repo's configured identity. Push only the branch: `git push origin astra/usual-figures`. Never push to main.

Another session (`claude/learn-corrections`) changes the photo readers and the correction paths in `src/agents/conversation.js`. Keep your changes to `conversation.js`, `src/i18n/hi.js` and `docs/text-keys.md` small and additive (new functions, new keys) so the merge stays easy.

## Why
A real munshi knows each party's usual figures: this supplier's cement is usually ₹380 a bag, this JCB usually works 6–8 hours a day at ₹1,200, this site usually takes 50 bags. When a figure is far from usual, he says so before anyone pays. Our agents have every signed figure in their own ledger already; they should remember them the same way and say "unusual" at the moment a person decides. Memory from the agent's own records, flags only: it never blocks, never changes a record, never decides.

## What to build
1. **Usual figures** (`src/ledger/usual.js`, pure, like `payments.js`): from one agent's ledger events, per counterparty (the other agent) and per item+unit:
   - rate (paise per unit, before GST) from agreed rates (BOOKING_REPLY yes) and bills;
   - quantity per order (from DELIVERY / site counts);
   - JCB hours per job (from meter readings / bills) and rate per hour;
   - GST percent per item.
   Use only settled or accepted orders (a disputed-and-corrected figure counts as corrected). Keep the last 10 per key. `usualFigures(events) → Map/key → {n, median, min, max, last}` (integers only, median by code). Fewer than 3 past values = no "usual" yet (say nothing).
2. **Unusual check** (`unusual(value, usual)`): code decides, with fixed thresholds in one place: more than 25% above or below the median, or outside 0.5×min…1.5×max. Returns `{unusual: boolean, usualPaise/usualValue, n, pct}`.
3. **Where it speaks** (one extra line appended to the existing message; never a new question, never a new step):
   - contractor gets a bill (JCB or material): `सामान्य से 30% ज़्यादा: पिछले 5 ऑर्डर में सीमेंट ₹380/बोरी` style line, for the rate, the quantity or the hours that is unusual;
   - supplier / JCB owner says yes with a rate: their own read-back/receipt notes if the rate is far from what they usually charge this site (catches a typo like 3800 for 380);
   - contractor's approval message for a supervisor's held order (`office.approval_needed`): the estimate vs usual;
   - a supervisor's order above the usual quantity is NOT held for that reason (the ₹25,000 limit decides holding); only noted to the contractor in the existing "ordered" message.
4. **Ask anything** (`src/agents/ask.js`): a `usual` lookup so "सीमेंट का रेट आमतौर पर कितना रहता है?" / "JCB रोज़ कितने घंटे चलती है?" are answered from these figures; every number checked by code as today.
5. **Explanations** (`explain-facts.js`): when a bill is disputed and its figure was unusual, the facts include the usual figure.
6. **Inside the agent** (`src/trace/`, `web/`): a trace `check` line "rate vs usual: ₹420 vs median ₹380 over 5 orders → 11% (usual)" / "→ 32% (unusual, flagged)"; the judge page shows the usual-figures card per counterparty. Update `web/sample/make-sample.js` with an invented history that has one unusual bill.
7. **Texts and docs**: new keys in `src/i18n/hi.js` + `docs/text-keys.md` (plain Hindi, as in the polished texts: सप्लायर, डिलीवरी, कुछ दर्ज नहीं हुआ; no "—"); a short "Usual figures" section in `docs/BUILD2.md`.

## Rules
No reminders, no verdicts ("this is wrong"), no blocking. Only the agent's own ledger; never another agent's records. No model call is needed for the check (Muse may still word explanations as today).

## Tests (node:test, invented data, phones `9190000000xx`)
`usualFigures` / `unusual` edge cases (fewer than 3, corrected figures, GST excluded from rate, units kept apart, per counterparty); the extra line on a bill, a yes, an approval; nothing said when usual; ask-anything `usual` lookup (stand-in spark, numbers checked); trace check line; `test/rules/meta-only.test.js` still passes.

## Live check (cheap, allowed)
`META_API_KEY` is in the environment; set `META_API_BASE=https://api.meta.ai/v1` and `MUSE_SPARK_MODEL=muse-spark-1.3` for the command only. With a throwaway script outside the repo: 3–4 ask-anything "usual" questions over an invented ledger. Never print the key; do not commit the script.

## Machine limits
On the owner's laptop: do not run `npm run typecheck` or the whole `npm test`; run only the test files you touch.

## Done means
Branch pushed; a short report for the lead: files changed, tests added and their local result, live-check results, anything unsure. Do not merge, deploy, or touch the server or any Meta/WhatsApp setting.
