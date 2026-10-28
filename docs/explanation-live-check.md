# Explanation live check — 28 October 2026

Invented cases only: no private photos, labels, names or transactions. Each case is an invented
in-memory ledger, run through the real path (`differenceFacts` → `explainDifference` →
`src/meta/client.js` `museSpark`). The throwaway script and its results stayed outside the
repository. Calls used the environment key (never printed or saved) and command-scoped
`META_API_BASE=https://api.meta.ai/v1` and `MUSE_SPARK_MODEL=muse-spark-1.3`. No service
configuration was changed.

## Result

**Final measurement: 8 of 8 explanations accepted** (every number found in the facts, every
guard rule passed). Latency per explanation (wall time of `explainDifference`, including the
request): **p50 3.75 s, p95 5.6 s** (min 3.2 s, max 5.6 s). No timeouts or retries in the final run.

| # | Invented case | Explanation (model text, as shown) | Numbers | Guard | Latency |
|---|---|---|---|---|---|
| 1 | JCB seller: meter 1240.6 → 1246.7, bill 6.1 h, objection 5.5 h | आपके बिल में 6.1 घंटे दर्ज हैं, लागू बिल में JCB 6.1 घंटे × ₹1,200 = ₹7,320 और कुल ₹7,320 है। मीटर फ़ोटो में शुरू 1240.6 और अंत 1246.7 है, जबकि दूसरी ओर 5.5 घंटे कहा गया है, आपत्ति में लिखा कारण: “मशीन बीच में आधा घंटा बंद रही।” | pass | pass | 5,585 ms |
| 2 | JCB seller: correction to 5.5 h already sent, objection again at 5.0 h | लागू बिल में JCB 5.5 घंटे × ₹1,200 = ₹6,600 दर्ज है, कुल ₹6,600 है। मीटर फोटो में शुरू 1240.6 और अंत 1246.7 है, जिससे 6.1 घंटे गिना गया, जबकि दूसरे पक्ष की आपत्ति 5.0 घंटे है। आपत्ति में लिखा कारण: “साइट रजिस्टर में 5 घंटे लिखे हैं।” | pass | pass | 3,711 ms |
| 3 | Material buyer: signed delivery 50 bags, site challan photo 48 | विक्रेता के रिकॉर्ड में कुल ₹17,500 है, आधार हस्ताक्षरित चालान DEL-81 में सीमेंट 50 बोरी है। साइट की गिनती में कुल ₹16,800 है, आधार चालान SITE-75 की फ़ोटो में सीमेंट 48 बोरी है। तय दर सीमेंट ₹350/बोरी है। | pass | pass | 3,792 ms |
| 4 | Material buyer: signed delivery 50 bags, typed site count 48 | विक्रेता की ओर सीमेंट 50 बोरी है, हस्ताक्षरित चालान DEL-82 में दर्ज। साइट की लिखित गिनती में सीमेंट 48 बोरी है, तय दरों पर कुल ₹16,800। लागू बिल में कुल ₹17,500 है। | pass | pass | 3,537 ms |
| 5 | Material seller: signed delivery 50 bags, objection 48 | आपके बिल में सीमेंट 50 बोरी × ₹350 = ₹17,500 दर्ज है, जिसके पीछे चालान DEL-83 में सीमेंट 50 बोरी दर्ज है। दूसरे पक्ष ने 48 बोरी दर्ज की है। आपत्ति में लिखा कारण: “साइट पर 48 बोरी ही गिनी गईं।” | pass | pass | 4,701 ms |
| 6 | JCB seller: meter 200.0 → 204.0, bill 4.0 h, objection 3.5 h | विक्रेता के बिल में JCB 4.0 घंटे × ₹1,200 = ₹4,800 दर्ज है। मीटर फोटो में शुरू 200.0 और अंत 204.0 दर्ज है। दूसरे पक्ष की आपत्ति 3.5 घंटे है, आपत्ति में लिखा कारण: “साइट की दर्ज अवधि अलग है।” | pass | pass | 3,359 ms |
| 7 | Material buyer, count difference on one of two items: delivery cement 50 + steel 2 t, typed count steel 1.8 t | विक्रेता के रिकॉर्ड में कुल ₹1,37,500 है, आधार हस्ताक्षरित डिलीवरी, चालान DEL-84 है। खरीदार की साइट गिनती में तय दरों पर कुल ₹1,25,500 है। दर्ज मात्रा में अंतर सरिया 2 टन बनाम सरिया 1.8 टन है। | pass | pass | 3,213 ms |
| 8 | Material seller: correction 50 → 49 bags already sent, objection again at 48 | आपकी डिलीवरी DEL-85 में सीमेंट 50 बोरी दर्ज है, तय दर ₹350/बोरी पर कुल ₹17,500 है। दूसरे पक्ष की आपत्ति 48 बोरी है, आपत्ति में लिखा कारण: “गिनती अब भी 48 बोरी है।” लागू बिल में सीमेंट 49 बोरी × ₹350 = ₹17,150, कुल ₹17,150 दर्ज है। | pass | pass | 4,332 ms |

Every explanation is followed in the message by the figures code lists from the ledger
(`explain.wrapper`), so the reader never depends on the model's wording for a number.

## What changed since the first check (0 of 6 got through)

| Run | Change | Accepted | Latency |
|---|---|---|---|
| First check (Astra) | Whole order context as JSON, long system prompt, 12 s attempts | 0 / 6 (5 timeouts, 1 rejected for quoting "कारण") | 21.7–36.8 s |
| Dev 1 | A few Hindi lines of facts for this one difference; rule-based guard | 6 / 8 (1 timeout; 1 false reject: "1246.7 मीटर" read as a length unit) | 12.5–19.0 s, ~2,200–3,000 output tokens |
| Dev 2 | Shorter system prompt; "मीटर" no longer a quantity unit | 3 / 3 | 15.9–36.9 s (one attempt timed out and retried) |
| Dev 3 | `reasoning_effort: "low"` (documented Chat Completions field) | 3 / 3 | 7.5–13.6 s, ~1,000–1,900 tokens |
| Dev 4 | `reasoning_effort: "minimal"` | 3 / 3, but case 2 described the objection to the replaced bill | 3.1–4.9 s, ~400–650 tokens |
| Dev 5 | Only the objection to the bill in force is in the facts | 8 / 8 | 3.1–5.9 s |
| **Final** | Same code, timeouts set from the measurements (15 s attempt, 35 s total) | **8 / 8** | **p50 3.75 s, p95 5.6 s** |

Latency is almost all reasoning tokens, not prompt size. Total spend: about 35 requests (two
latency probes, 32 explanation runs and two client retries), each well under a cent.

## Limits, said plainly

- Eight invented cases is a small sample; 8/8 shows the path works, not a measured pass rate.
- Hindi quality is acceptable but uneven. It addresses the reader as "आप" in some answers and as
  "विक्रेता" in others; some phrasing is stiff ("विक्रेता की ओर सीमेंट 50 बोरी है"); case 2 puts the
  meter's 6.1 hours beside the corrected 5.5 hours without saying the bill was corrected (the
  correction is in the code figures below it). A Hindi speaker should read a few before the demo.
- The guard checks wording and numbers, not meaning. It cannot prove that a sentence pairs the
  right figure with the right side; the code-listed figures that follow are the authority.
- After the final run the guard reports its rules in a different order (format first; causes
  before the bare "कारण" check), and the facts lines tolerate a missing item list. Neither changes
  what these eight cases produce or whether they are accepted.
