# Explanation live check — 28 October 2026

Six invented disputes only; no private photos, labels, names or transactions. The throwaway
scripts/results stayed outside the repository. Calls used the existing `src/meta/client.js`,
the environment key (never printed or saved), and command-scoped `META_API_BASE=https://api.meta.ai/v1`
and `MUSE_SPARK_MODEL=muse-spark-1.3`. No service configuration was changed.

| Invented case | Model explanation | Number check | Displayed result | Client latency |
|---|---|---|---|---|
| JCB seller: meter 1240.6 → 1246.7, bill 6.1 hours, disputed 5.5 | None: timeout | Not evaluated | Plain figures (`explain.unavailable`) | 36,830 ms |
| JCB seller: correction to 5.5 hours, disputed 5.0 | None: timeout | Not evaluated | Plain figures (`explain.unavailable`) | 36,770 ms |
| Material buyer: signed delivery 50 bags, site challan photo 48 | None: timeout | Not evaluated | Plain figures (`explain.unavailable`) | 36,789 ms |
| Material buyer: signed delivery 50 bags, typed site count 48 | None: timeout | Not evaluated | Plain figures (`explain.unavailable`) | 36,810 ms |
| Material seller: signed delivery 50 bags, disputed 48; no access to site photo | None: timeout | Not evaluated | Plain figures (`explain.unavailable`) | 36,784 ms |
| JCB seller diagnostic: meter 200.0 → 204.0, bill 4.0 hours, disputed 3.5 | Quoted below | **Passed** | Plain figures: language guard rejected causal wording | 21,745 ms |

The sixth response was:

> संदर्भ J-2 के लेजर में 4.0 घंटे दर्ज है, जिसका आधार 200.0 घंटे और 204.0 घंटे के दर्ज पाठ्यांक हैं। प्राप्त आपत्ति में 3.5 घंटे दर्ज है, जिसमें कारण के रूप में कहा गया है कि “साइट की दर्ज अवधि अलग है।”

The first five cases used the initial 12-second attempt timeout (the client retries up to three
times), with facts assembled from invented in-memory ledgers. The sixth used a smaller invented
fact set and a 60-second diagnostic attempt timeout with the same captured schema/prompt; its
returned response was then passed through the explanation guard. Every cited number passed.
The conservative language gate rejected `कारण`; the response was not shown as an explanation.

After these results, the final code uses 30-second attempts and a 95-second total bound, and the
prompt explicitly avoids causal introductions when attributing a recorded reason. Existing
discrepancy notices go out before waiting for the additional explanation. These final timing and
prompt changes have focused test coverage but have **not** had another live run: the six-case
budget is exhausted. Zero live explanations were accepted; this is not a live-quality success
claim. Claude should repeat the small live check on AWS and review Hindi quality before the demo.

Local verification: 29 focused tests across the explanation helper, ledger facts, integration,
Hindi texts and Meta-only rule. The full suite and typecheck are reserved for Claude on AWS, as
required by `docs/briefs/ASTRA-2-explain.md`.
