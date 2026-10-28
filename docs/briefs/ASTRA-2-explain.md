# Brief: Astra, session 1 of Build 3: Muse Spark explains every difference

Read `AGENTS.md`, `docs/CONTRACTS.md`, `docs/BUILD2.md` and `docs/text-keys.md` first. The lead (Claude) reviews, runs the full suite and the typecheck on AWS, merges and deploys. You build on a branch and stop there.

## Worktree and branch
Work only in your own worktree; never switch branches in `hb-claude` (the lead's checkout) or `hb-intake` (another session):
`git -C D:\MUNSHI\CLAUDE\HACKATHON\hb-claude worktree add ..\hb-astra-explain -b astra/explain claude/wa`
Commit with the repo's configured identity. Push only the branch: `git push origin astra/explain`. Never push to main.

## Why
Judges weigh how much of the product's working depends on Meta's models. The README and the demo promise: "Muse Spark explains every difference to both sides from the evidence; code checks every number it cites." The texts exist (`explain.wrapper`, `explain.unavailable` in `src/i18n/hi.js`) but nothing calls the model. Build it.

## What to build
1. **`src/agents/explain.js`**: `explainDifference({spark, facts, audience})`.
   - `facts` is built by code from one agent's own ledger only: order ref, site, kind (JCB hours or material), the bill lines in force (quantity, unit, rate, amount), the evidence (JCB: meter start/end readings, the photos' times and the hours code computed; material: the signed DELIVERY items, challan number, the site's own count and whether it came from the site's challan photo), the other side's figure and reason from the DISPUTE, any CORRECTION.
   - Muse Spark (through `src/meta/client.js` only, strict JSON schema) writes a short, neutral Hindi explanation (at most about 500 characters) of where the two figures differ and what evidence each rests on, for `audience` 'buyer' (contractor) or 'seller' (JCB owner / supplier). It never says who is right, never tells anyone to pay, never mentions due dates or reminders (WhatsApp debt-collection policy), never invents a reason.
   - **Code checks every number** in the explanation: each figure must equal (after normalising Hindi/Latin digits, commas, ₹, "h"/"घंटे") a value present in `facts`. One unknown number → the explanation is dropped and `explain.unavailable` with the plain figures is sent instead. Same on timeout or model error. The returned text is wrapped with `explain.wrapper` ({explanation}, {figures} = the ledger figures listed by code).
2. **Wire it** where a difference becomes known, each agent explaining from its own ledger:
   - seller side: when a DISPUTE arrives (`src/agents/jcb.js` and `src/agents/supplier.js`, case 'DISPUTE'), after the existing `*.bill_disputed` message;
   - buyer side: when the contractor's agent finds a bill that differs from the site's own count or note (`src/agents/contractor.js`, e.g. `site.material_bill_count_differs` and the JCB equivalent if there is one), after the existing message.
   The explanation is an extra message; existing messages, states and tools do not change. No step is proposed by the explanation.
3. **Tests** (node:test, a stand-in spark; invented data, phones `9190000000xx`): JCB hours dispute; material quantity dispute with a site challan; an explanation citing an unknown number is replaced by the fallback; model timeout → fallback; the explanation text never reaches a tool or a ledger; `test/rules/meta-only.test.js` still passes.
4. **Live check** (cheap, allowed): `META_API_KEY` is in the environment; set `META_API_BASE=https://api.meta.ai/v1` and `MUSE_SPARK_MODEL=muse-spark-1.3` for the command only. With a throwaway script outside the repo, run 4–6 invented disputes through the real model; report each explanation and whether the number check passed. Never print the key; do not commit the script.
5. **Texts and docs**: any new key in `src/i18n/hi.js` and `docs/text-keys.md` ("Astra drafted, Fable to polish"); a short section "Explanations" in `docs/BUILD2.md`; CONTRACTS only if an interface changes.

## Machine limits
If you run on the owner's laptop: it runs out of memory on the TypeScript checker and the full suite. Do not run `npm run typecheck` or the whole `npm test`; run only the test files you touch. The lead runs everything on AWS.

## Done means
Branch pushed; a short report for the lead: files changed, the live-check results, tests added and their local result, anything unsure. Do not merge, deploy, or touch the server or any Meta/WhatsApp setting.
