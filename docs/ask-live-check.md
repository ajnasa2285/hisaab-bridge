# Ask anything: live check (29 Oct 2026)

`muse-spark-1.3` through `src/meta/client.js`, `reasoning_effort: "low"` in the ask loop. A throwaway
script outside the repository built invented ledgers through the real agents in memory (the same
`test/agents/helpers.js` the tests use) and sent each question through the real conversation: the
router (`proposeStep`, which chose `ask_records` every time), then the ask loop (`src/agents/ask.js`).
All names, sites and amounts are invented.

**Ledgers.** Contractor agent: J-1 Shivpuri 20 Oct, 6.1 h × ₹1,200 = ₹7,320, accepted, paid 22 Oct,
settled; J-2 Rampur 27 Oct, 8.5 h × ₹1,100 = ₹9,350, disputed at 8 h; P-1 Shivpuri 21 Oct, cement
100 bags at ₹350, site counted 98, billed ₹35,000, paid 23 Oct, settled; P-2 Rampur 26 Oct, sand 3
trolleys at ₹4,000 and cement 40 bags at ₹360, billed ₹26,400, paid 28 Oct, not yet confirmed; P-3
Shivpuri 28 Oct, cement 50 bags delivered, not counted, not billed. The JCB and supplier agents hold
their own side of the same orders. "Today" is Thursday 29 Oct.

**Development.** Two development runs (15 questions in all) found two faults, both fixed before the
final run: the model writes the string `"null"` for an empty field, which made every date unreadable
and made strict enums fail the whole reply (now plain strings, emptied and checked by code, with an
error the model sees for a made-up value); and one answer was accepted although every lookup had
failed (an answer now needs at least one lookup that worked). One more change came from the data:
"received at site" counts the site's own count where it counted and the challan elsewhere, as
`stock` does.

## Final run (once, 10 questions)

| # | Who | Question | Lookups (code) | Answer sent | Number check | Latency | Correct |
|---|---|---|---|---|---|---|---|
| 1 | contractor | इस महीने शिवपुरी पर कितना सीमेंट आया? | stock(Shivpuri, सीमेंट), totals(Shivpuri, material, सीमेंट, this_month) | इस महीने शिवपुरी पर 148 बोरी सीमेंट प्राप्त हुआ दिख रहा है। चालान पर 150 बोरी दर्ज है। यह P-3, P-1 में दिख रहा है। | passed | 12.6 s | yes |
| 2 | contractor | JCB के कितने घंटे का बिल बाक़ी है? | totals(jcb) | रिकॉर्ड में JCB के 8.5 घंटे का बिल बाकी दिख रहा है। आदेश J-1, J-2 में कुल 14.6 घंटे बिल है। | passed | 6.8 s | yes |
| 3 | contractor | पिछले हफ़्ते किसको कितना भुगतान किया? | payments(last_week) | पिछले हफ़्ते 19 अक्टूबर 2026 से 25 अक्टूबर 2026 तक 2 भुगतान दिख रहे हैं। P-1 में सप्लायर को ₹35,000 दिया गया है। J-1 में JCB मालिक को ₹7,320 दिया गया है। | passed | 8.7 s | yes |
| 4 | contractor | rampur pe ret kitni aayi aur uska bill kitna hua | stock(Rampur, रेत), totals(Rampur, material, रेत) | रामपुर पर रेत 3 ट्रॉली आई है। P-2 में रेत की बिल मात्रा 3 ट्रॉली और बिल राशि ₹12,000 है। कुल बिल ₹26,400 दर्ज है। | passed | 8.9 s | yes |
| 5 | contractor | J-2 ka kya haal hai, bill kitne ka aaya? | order_detail(J-2) | J-2 Rampur का है, 27 अक्टूबर 2026 का है। मांग JCB 8 घंटे दर्ज है, दर ₹1,100 है। लागू बिल ₹9,350 है, बिल में 8.5 घंटे दर्ज हैं। | passed | 7.0 s | partly: figures right, the state (आपत्ति) was asked and not said |
| 6 | supervisor | abhi kaun kaun se kaam khule hain | list_orders(open) | अभी 3 काम खुले हैं। P-3 Shivpuri में सीमेंट 50 बोरी है, P-2 Rampur में रेत 3 ट्रॉली और सीमेंट 40 बोरी है, बिल ₹26,400 है। J-2 Rampur में JCB 8 घंटे है, बिल ₹9,350 है। | passed | 9.3 s | yes |
| 7 | contractor | is hafte suplayar ka kitna bil aaya | totals(material, this_week) | इस हफ्ते 26 अक्टूबर 2026 से 29 अक्टूबर 2026 तक 2 ऑर्डर हैं P-3, P-2। सप्लायर का बिल ₹26,400 आया है। स्वीकृत राशि ₹26,400 दिख रही है। | passed | 8.4 s | yes |
| 8 | JCB owner | इस महीने कुल कितने घंटे का बिल भेजा और कितना पैसा आया? | totals(jcb, this_month), payments(jcb, this_month) | इस महीने 14.6 घंटे का बिल भेजा है। कुल बिल ₹16,670 है। पैसा ₹7,320 आया है, J-1 में। | passed | 11.6 s | yes |
| 9 | supplier | thekedar ne kitna payment bataya aur maine kitna confirm kiya | totals(), payments() | ठेकेदार ने ₹61,400 बताया है। आपने ₹35,000 कन्फर्म किया है। P-1 में ₹35,000 कन्फर्म है। P-2 में ₹26,400 अभी नहीं है। | passed | 9.4 s | yes (last sentence is awkward: it means P-2's ₹26,400 is not confirmed yet) |
| 10 | supervisor | shivpuri me sement kitna aya total, stok me | stock(Shivpuri, सीमेंट) | शिवपुरी में सीमेंट स्टॉक में 148 बोरी दर्ज है। चालान पर 150 बोरी दिख रही है। | passed | 9.2 s | yes |

Each reply also carries the line "(बही से: …)" with the references the lookups returned, or "(बही के
आँकड़ों से)" when none did (stock).

**Result: 9 of 10 correct, 1 partly correct (no wrong figure); 10 of 10 answers passed the number and
wording checks, so no fallback was needed.** Every figure in every answer was produced by code
(sums such as 14.6 h, ₹16,670 and ₹61,400 are lookup results, not model arithmetic).

**Latency** (whole question: router plus ask loop): p50 8.9 s, p95 12.6 s, max 12.6 s. Router call
p50 3.3 s; each ask round p50 2.7 s, p95 4.4 s, max 4.8 s. Every question took 1 or 2 lookups (two
called in one round when they did not depend on each other), so 2 rounds after the router.
`ATTEMPT_TIMEOUT_MS` (15 s) is about three times the slowest round; `ASK_TIMEOUT_MS` (30 s) bounds
the loop.

**Spend.** About 73 Muse Spark calls in all (43 development, 30 final), none failed.

**Not measured here.** Voice notes themselves (questions 4, 7, 9 and 10 imitate transcripts); real
ledgers; `minimal` reasoning for the loop (`low` already gave 3–5 s rounds, so it was not tried).
The checks prove that every number exists in the lookups, not that it is attributed to the right
thing; the reference line lets the person check with `स्थिति <ref>`.
