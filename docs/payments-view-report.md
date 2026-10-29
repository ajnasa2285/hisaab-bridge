# Astra: payments read-side handoff (29 October 2026, IST)

Branch: `astra/payments-view`, based on `claude/wa` at `0c32d2c`; own worktree
`D:\MUNSHI\CLAUDE\HACKATHON\hb-astra-payview`. Implementation and focused checks are complete.
The recording branch, protocol, ledger states and shared payment function signatures are untouched.

## Changes

- `src/agents/ask.js`, `explain-facts.js`, `explain.js`: all payments and balances from
  `paymentSummary`, cash/status/date/ref/group filters, checked display figures and plain explanation
  facts. Groups count once. The exact idiom "एक साथ" no longer fails the numeral guard; other
  spelled-out/invented figures still fail.
- `src/agents/payment-view.js`, `office.js`, `jcb.js`, `supplier.js`: status and pending balances;
  one waiting item per claim/group; advances work before a bill. `src/app.js` rebuilds a missed
  group from either member reference once. The sellers' payment tools and first-send notices were
  not changed.
- `src/readers/cash-receipt.js`: strict one-call reader, raw fields plus code-parsed amount/date,
  uncertainty and receiver's mark. `conversation.js` and `app.js` expose an explicit cash-receipt
  option and read-only preview, without creating a payment or saving the photo. The classifier is
  unchanged, so its existing evaluation results are unaffected.
- `web/payments-view.js`, `order-state.js`, `judge.js`, `judge.css`, `texts.js`, `trace-view.js`:
  payments in each ledger column, cross-order group links, balances and payment-aware display
  replay. `app.js` serves the view modules and only the exact pure payment-summary source URL.
- `src/trace/payments.js`, `hooks.js`: observational balance, shares-total/allocation and prior-UTR
  checks. Cash traces keep safe figures, excluding raw receipt text, names, references and bytes.
- `web/sample/make-sample.js`, `export.json`: signed invented cash advance/partial/clubbed/denied/
  credit example, with valid signatures and hash chains. `web/README.md`, `src/i18n/hi.js`,
  `docs/text-keys.md`, `BUILD2.md`, `CONTRACTS.md` (3.7) and `STATUS.md` document the changes.

## Local checks

Final focused run: **100 tests passed, 0 failed**, with concurrency 2. New test files:
`test/agents/{ask-payments,payment-view,cash-photo}.test.js`,
`test/readers/cash-receipt.test.js`, `test/trace/payments.test.js`,
`test/web/{payments-view,order-state}.test.js`; invented contract-event fixture in
`test/agents/ask-payments-fixture.js`. Existing tests updated/run:
`test/agents/{ask,explain-facts,keys,payment-time}.test.js`, `test/i18n/hi.test.js`,
`test/web/{sample,static,trace-view}.test.js`, plus required `test/rules/meta-only.test.js`.
The existing photo-route regression also passed, 6/6. `git diff --check` is clean.
Localhost integration checks needed execution outside the sandbox, which blocks loopback access.
No full suite or typecheck was run on the laptop; both remain the lead's AWS checks.

## Live Muse Spark checks

Command-only `META_API_BASE=https://api.meta.ai/v1` and `MUSE_SPARK_MODEL=muse-spark-1.3`;
existing environment key never printed. Scripts and invented receipt images stayed outside the
repository. No private photos or records were used.

Six invented-ledger questions obtained accepted answers with code number/wording checks passing:

| Question | Accepted answer | Time |
|---|---|---|
| P-2 का कितना बाक़ी है? | P-2 का बिल ₹8,000 है। बाकी ₹8,000 है। ₹4,000 पुष्टि बाकी है। | 5.691 s |
| इस महीने कितना नकद दिया? | इस महीने 4 बार नकद में ₹4,800 दर्ज है। इसमें से ₹3,200 की पुष्टि हुई है। ₹600 की पुष्टि बाक़ी है और ₹1,000 मिलने से इनकार है। | 5.397 s |
| कौन सा पेमेंट अभी पक्का नहीं हुआ? | पुष्टि बाक़ी 2 पेमेंट दिख रहे हैं। P-1, P-2 के लिए ₹9,000 का पेमेंट पुष्टि बाक़ी है। P-4 के लिए ₹600 नकद अग्रिम पुष्टि बाक़ी है। | 6.241 s |
| P-1 और P-2 का एक साथ कितना दिया था? | P-1 और P-2 के लिए 1 भुगतान दिख रहा है। समूह कुल ₹9,000 है। यह पुष्टि बाक़ी है। | 5.068 s |
| P-3 पर बिल से कितना ज़्यादा जमा है? | P-3 का बिल ₹1,000 है। पुष्टि जमा ₹1,200 है। क्रेडिट ₹200 दिख रहा है। | 3.171 s |
| P-4 पर अग्रिम का क्या हिसाब है? | P-4 पर ₹600 अग्रिम नकद बताया गया है, 25 अक्टूबर 2026 का। स्थिति पुष्टि बाक़ी दिख रही है। पुष्ट ₹0 और प्रतीक्षा ₹600 दर्ज है। | 4.342 s |

Ten question runs total: six initial, two diagnostic, two final rechecks. The original waiting
and clubbed questions safely fell back to code figures. Diagnosis found the "एक साथ" numeral
issue and a model counting three order-share rows as three payments. The exact idiom exception,
removal of share-count numeric authority and explicit group-count prompt fixed the two rechecks.
These are small synthetic checks, not an accuracy estimate on real messages.

| Invented receipt | Reading | Clear | Time |
|---|---|---|---|
| Printed | ₹1,234.50 = 123450 paise; 2026-10-27; Kalpit One; C-099; receiver mark visible | true | 3.817 s |
| Handwriting-style rendering | ₹2,750 = 275000 paise; 2026-10-28; Kalpit Two; H-021; receiver mark visible | true | 8.315 s |
| Unreadable amount `2?50` | amount null; readable date/name/reference retained | false | 7.879 s |
| Digits 500, words Six hundred | conflicting amount null; readable date/name/reference retained | false | 4.692 s |

All four matched the expected reading/abstention. These are rendered examples, not real
handwritten phone-photo accuracy or a photo-kind evaluation.

## Recording-branch integration

1. Call `readCashReceipt({mime, bytes})` through the existing app/trace injection. The current
   explicit `नकद पर्ची` route only previews; replace its handoff with the recording flow.
2. Retain receipt bytes in private media storage and use their hash as optional `screenshot`.
   Never copy raw image data, receiver names or private details into trace/sample/test artifacts.
3. For `clear=false`, missing amount/date or another document, ask for the missing figures or a
   new photo. Do not infer receiver identity or treat a mark as proof of receipt.
4. Bind the exact order/group, amount and date to the person's confirmation. Draft `method:'cash'`
   without UTR; use `allocate` for a group and show its split. A photograph never confirms money;
   only the seller's ACK or seller-recorded receipt does.
5. Reuse `paymentWaiting`/`payview.waiting` for seller notices, or add the recording branch's new
   cash/group notice keys to `missedWaiting`. It currently accepts the legacy
   `jcb/supplier.payment_claimed(_at)` aliases and `payview.waiting`.

Remaining limits: the new-event read-side tests use contract histories and a view adapter because
this branch deliberately leaves the old state machine untouched. Run combined-branch integration,
the full suite and typecheck on AWS before merging. The existing explanation payment-word guard
still rejects forbidden prose and supplies the complete code-figure fallback. Fable should polish
the newly marked Hindi keys. No merge, deployment, server access or Meta/WhatsApp setting change.
