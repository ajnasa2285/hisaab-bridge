# Usual figures handoff (29 Oct 2026)

Branch: `astra/usual-figures`, from `claude/wa` at `a173e1e`. Worktree: `hb-astra-usual`.
No merge, deployment, server change, or Meta/WhatsApp setting change.

## Changed files

- `src/ledger/usual.js`: pure shared calculation, accepted corrections, pre-GST rates, separate
  counterparties/units, last 10 acceptances, integer medians and fixed thresholds.
- `src/agents/usual.js`, `contractor.js`, `jcb.js`, `supplier.js`: one appended line on unusual bills
  and seller yes receipts/read-backs. Current order excluded; existing decision metadata retained.
- `src/agents/common.js`, `office.js`: optional display-only usual context on held approvals and
  the contractor's supervisor-order receipt. Approval decisions still use the existing limit only.
- `src/agents/ask.js`, `explain-facts.js`, `explain.js`: guarded `usual` lookup and disputed-bill
  historical facts. Explanation baseline stops before the bill; JCB hours are per job.
- `src/trace/usual.js`, `hooks.js`: normal and unusual comparisons, in ledger sequence even when
  histories arrive grouped by order; observation never changes append behavior.
- `src/app.js`: two narrow static allowlist additions for the shared pure calculator and view.
- `web/usual-view.js`, `judge.js`, `judge.css`, `texts.js`, `trace-view.js`: bilingual counterparty
  cards on each ledger side, with neutral unusual flags rather than a failed-check verdict.
- `web/sample/make-sample.js`, `export.json`: invented accepted cement history and exactly one
  unusual bill, P-7 at ₹500 versus median ₹380 (32%). All sample signatures/chains verify.
- `src/i18n/hi.js`, `docs/text-keys.md`, `docs/BUILD2.md`, `docs/STATUS.md`: additive keys and docs.
  `conversation.js` and photo/correction paths were not edited.

## Local checks

`npm ci` completed. Final focused run: **61/61 passed**, including `test/rules/meta-only.test.js`.
`git diff --check` passed. Full suite and typecheck were deliberately left for the lead on AWS.

35 new cases across:

| Test file | Cases |
|---|---:|
| `test/ledger/usual.test.js` | 12 |
| `test/agents/ask-usual.test.js` | 5 |
| `test/agents/explain-usual.test.js` | 3 |
| `test/agents/usual-estimate.test.js` | 4 |
| `test/agents/usual-notices.test.js` | 3 |
| `test/trace/usual.test.js` | 5 |
| `test/web/usual-view.test.js` | 3 |

The final run also includes the updated `ask.test.js`, `i18n/hi.test.js`, `web/sample.test.js`,
`web/static.test.js`, and the required Meta-only rules. Invented fixtures live in
`test/agents/usual-fixture.js` and `test/trace/usual-fixture.js`. Localhost HTTP tests required
sandbox escalation. Neither test data nor the sample contains real phones, keys or transactions.

## Live Meta check

Four questions, invented in-memory history, through the existing client with command-only
`META_API_BASE=https://api.meta.ai/v1` and `MUSE_SPARK_MODEL=muse-spark-1.3`.

| Question | Result | Latency |
|---|---|---:|
| Usual cement rate | Checked ₹380/बोरी | 5.184 s |
| Usual cement quantity | Checked 50 बोरी | 3.629 s |
| Usual JCB hours | Checked 7 hours per job, no daily-hours claim | 4.323 s |
| Usual cement rate in tonnes, insufficient history | Code fallback says records are insufficient | 9.504 s |

All selected `usual` then `answer`; 3 model answers passed the guard, 1 used safe fallback.
Reported usage: 27,095 total tokens. The key was never printed; the throwaway script was outside
the repository and removed itself. Initial automatic review rejection was resolved by showing the
brief's exact authorization and the invented in-memory payload; the subsequent call was approved.

## Review notes

- GST percentages stay in code-written figures; the existing prose guard rejects percent signs,
  so a GST-percent question falls back safely. That guard was not weakened.
- Approval comparisons use a derived estimate (median quantity times median pre-tax rate per
  item), explicitly labelled. It is not a median of historical bill totals. Combined changes can
  be unusual even when each component individually falls within 25%.
- The base branch sent the order receipt only to the requester. For an unusually large supervisor
  order, this change also sends that same receipt plus context to the contractor. No new question,
  hold or supervisor message is introduced; an approved held request returns only one contractor
  receipt.
- Rendered browser QA could not be completed: the parent had no browser provider (only MCP Apps),
  and the native browser attempt could not determine its URL confidently. Static module routes,
  display data, formatting, signatures and chains passed automated checks. Preview server stopped.
- Lead: run the full suite/typecheck on AWS and review/merge the branch. No dependency, protocol,
  ledger schema or payment-decision changes.
