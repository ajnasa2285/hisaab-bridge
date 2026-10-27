# Reader labeling and evaluation

Run with Node 24. No additional dependencies. `meter` uses private `hisaab-data/meters`; `upi` uses private `hisaab-data/upi`; `challan` uses private `hisaab-data/challans`. Evidence, answer keys, split membership, hashes, detailed predictions and cost logs stay in those folders. Only aggregate reports go in `eval/results/`. Evaluation never prints private filenames or readings; the interactive answer tool displays human-entered answers locally.

## Configure the confirmed Meta endpoint

The existing environment must supply `META_API_KEY`; do not paste it into a command, document or file.

```powershell
$env:META_API_BASE = 'https://api.meta.ai/v1'
$env:MUSE_SPARK_MODEL = 'muse-spark-1.3'
$env:MUSE_TRANSCRIBE_MODEL = 'muse-voice-transcribe-1.0'
```

See [API verification](../docs/meta-api-notes.md). Only `src/meta/client.js` contacts the network. Standard model IDs are allowlisted; redirects are refused. Schema validation rejects unsupported keywords (including `$ref` and `format`); supported keywords are listed in `src/meta/schema.js`. No endpoint/model fallback is attempted.

## Label the photos

From the repository root, in an interactive Windows terminal:

```powershell
npm run answer-key -- meter
```

Each photo opens in its associated Windows viewer. Type exactly the digits and decimal shown, `?` for unclear, or `नहीं` if it is not a meter. A separate prompt asks for a visible dashboard clock. Confirm with `हाँ` after checking the photo. `छोड़ें` skips and `बंद` exits. Each confirmed answer is immediately saved to private `answers.json`; previous versions are backed up privately. Nothing is populated from model predictions. Leading zeros matter for exact-display accuracy.

Use `--review` to review existing answers, or `--heldout` to label the held-out partition without making model calls. Labeling is a human task; no human answer key is fabricated when the owner is away.

For UPI screenshots, use `npm run answer-key -- upi`. The tool opens each screenshot and asks for amount in rupees, full date, UTC timestamp (only when explicitly supported), UTR, printed payment status, recipient name/VPA, sender name, and whether the fields are clear. Empty input means not visible; `?` means unclear and disables overall confidence. It reads the answers back before saving human confirmation. Only a visibly labelled UTR/UPI reference/RRN belongs in the UTR field. Status is what the screenshot says; it never proves payment was received or settled. Known readable formats can be labeled even when reader v1 conservatively abstains on them, avoiding selection bias.

Amounts become integer paise in code. Ambiguous date order, missing year, unsupported grouping/currency, masked names/IDs, uncertain roles and unsupported status wording abstain. Time follows the contract's UTC convention: reader v1 requires a full date, seconds, an unambiguous clock and a visible numeric offset/UTC/GMT. No unprinted IST, AM/PM or seconds are invented. Dates retain the visible calendar day; the foreign-timezone date convention is flagged for Claude in STATUS. A null time is expected for common screenshots without timezone/seconds. Valid independently legible fields can still be returned when `clear` is false.

## Run and score

From the repository root:

```powershell
npm run eval -- meter
npm run eval -- upi
```

Root aliases are now merged. `npm --prefix eval run eval -- meter` remains supported. `npm run eval -- meter --check` and `npm run eval -- upi --check` show aggregate dataset/label readiness without model calls or report files. An empty UPI folder reports `awaiting_photos`; unit fixtures are never presented as real-photo accuracy.

After labeling, score the last development predictions without another API call:

```powershell
npm run eval -- meter --score-latest
npm run eval -- upi --score-latest
```

Rescoring requires unchanged reader/client sources, development membership/grouping and photo bytes. Adding unseen held-out photos does not invalidate the existing development cache (including the original meter v1 cache). Cached model/timing/cost metadata is validated before public output. Each run produces a new aggregate report rather than overwriting an earlier result. Errors stop the run (except per-image schema failures), with unrun photos counted and status `incomplete`. Network errors are safe reason codes; raw exceptions and API bodies are never logged. Unknown usage/cost is explicitly unknown, not free.

## Development and held-out groups

The initial batch is assigned entirely to one development group before inference. This conservatively keeps photos from the same capture together and makes no held-out claim. To initialize a new dataset only once:

```powershell
node eval/split.js meter --initial-development
```

New arrivals are unassigned and block evaluation until grouped. Create private `groups.json` for **new files only**, mapping each filename to `{ "group": "capture-group", "side": "development" }` or `"heldout"`. Use one group for all shots from the same moment. The tool refuses reassignment of existing files, groups spanning both sides, and identical photo bytes spanning both sides. Humans must group related but byte-different photos; this tool does not infer capture moments.

Use `upi` instead of `meter` for the same split workflow in its own folder. Initialize only after images arrive; an empty dataset cannot be initialized. All screenshots of the same transaction belong in one group. No dataset paths or real example filenames are needed in repository fixtures.

```powershell
node eval/split.js meter --add-groups
node eval/split.js meter --freeze
npm run eval -- meter --heldout
```

Freeze requires nonempty development and held-out partitions and valid human-confirmed answers for **every photo on both sides**. It also rechecks image hashes. Held-out runs require the same answers, a frozen split, and explicit `npm run eval` execution. Private `checkpoint-plan.json`, when present, supplies `notBeforeIST`; an early run is refused. The first run locks the split digest privately. There is at most one held-out checkpoint per IST day, recorded **before** the first request so an interrupted run cannot silently repeat. Add all planned capture groups before freezing; later dataset changes need an agreed checkpoint/dataset policy from Claude. Do not tune from held-out outcomes. If a reader changes after a checkpoint, reports mark `promptsChangedSinceHeldout`; only a later checkpoint can run again.

## Meter checkpoint prepared for 28 October

The private split currently has 11 original development photos and 10 newly reserved held-out photos. The new photos form seven groups: the owner's related four-photo batch stays together, and the other six are single-photo groups. Original development assignments remain unchanged. The split is **not frozen**, no held-out inference has run, and no labels have been invented.

Owner sequence:

```powershell
npm run answer-key -- meter
npm run answer-key -- meter --heldout
npm run eval -- meter --check
node eval/split.js meter --freeze
# On or after 28 October IST, after the explicit freeze succeeds:
npm run eval -- meter --heldout
```

Readiness is read-only and never freezes. Neither labeling nor adding capture groups triggers model evaluation.

## What the numbers mean

- `exactAccuracy`: exact raw display **and** numeric tenths, divided by human-readable meter answers among evaluated photos. Abstentions, wrong classifications and API failures remain in that denominator.
- `valueAccuracy`: same denominator, comparing numeric tenths only (leading zeros do not change the value).
- `wrongButConfidentCount`: a returned clear numeric value differs from the human value, or was returned on a human-marked unclear/non-meter photo. It is `null` with no human answers. `unassessedConfident` is shown separately; zero assessed errors is not proof that unassessed readings are correct.
- `unclearRate`: successful meter responses with no reliable reading, divided by all evaluated photos. API failures are separate; `notMeter` is also separate.
- Classification and dashboard-clock accuracy have their own explicit denominators. A clock never supplies the meter reading.
- Rates use integer basis points (`10000` = 100%) and keep numerator/denominator. Empty denominators give `null`.
- Latency includes retries/backoff; token totals include all attempts with reported usage. Costs use integer nano-USD and verified standard pricing; unknown failed-attempt charges are not guessed.

All automated tests use invented values and mocked responses. Passing those tests does not establish real-photo accuracy or guarantee that model confidence is calibrated.

## UPI accuracy

UPI reports keep the same top-level counts, rates, latency and cost structure. `exactAccuracy` compares all expected fields on human-marked clear UPI receipts; failure, wrong classification or abstention stays in the denominator. `fieldAccuracy` uses only non-null human truth for each field, so absent/unclear fields cannot inflate accuracy with null/null matches. Equivalent UTC timestamp spellings compare by instant.

Every returned non-null field is also assessed separately, even when overall `clear:false`: incorrect known values, unsupported claims against human-null/negative evidence, and unassessed claims are separate counts. `wrongButConfidentCount` conservatively includes either an incorrect or unsupported claim on a clear result; separate `incorrectButConfidentCount` and `unsupportedButConfidentCount` distinguish them. Unsupported means not established by the human answer, not necessarily proven false. Without labels, error counts remain unknown (`null`) and unassessed counts remain visible. No receipt status is a ledger settlement.

## Challan

Dataset kind `challan` works like `upi` (`npm run answer-key -- challan`, `npm run eval -- challan [--check|--heldout|--score-latest]`, split commands with `challan`). The answer tool asks challan yes/no (`y`/`n` accepted), number, date, vehicle, then one line per material as `name | quantity | unit` exactly as printed; `?` marks a doubtful value and disables overall confidence. Quantities become integer hundredths and units are normalised by the reader's own code. `exactAccuracy` needs every field and the whole ordered item list to match on human-marked clear challans; `itemListAccuracy` scores the item list alone; any wrong or unsupported claim on a confident reading counts as wrong-but-confident. Reports hold aggregate numbers only.
