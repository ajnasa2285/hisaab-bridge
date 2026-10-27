# Meter labeling and evaluation

Run with Node 24. No additional dependencies. All evidence, answer keys, split membership, hashes, detailed predictions, and cost logs stay in the private sibling `hisaab-data/meters` directory. Only aggregate reports go in `eval/results/`. The tools never print private filenames or model readings during evaluation; the interactive answer tool displays human-entered answers locally.

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
node eval/answer-key.js
```

Each photo opens in its associated Windows viewer. Type exactly the digits and decimal shown, `?` for unclear, or `नहीं` if it is not a meter. A separate prompt asks for a visible dashboard clock. Confirm with `हाँ` after checking the photo. `छोड़ें` skips and `बंद` exits. Each confirmed answer is immediately saved to private `answers.json`; previous versions are backed up privately. Nothing is populated from model predictions. Leading zeros matter for exact-display accuracy.

Use `--review` to review existing answers, or `--heldout` to label the held-out partition without making model calls. Labeling is a human task; no human answer key is fabricated when the owner is away.

## Run and score

From the repository root:

```powershell
npm --prefix eval run eval -- meter
```

Equivalently, inside `eval/`, run `npm run eval -- meter`. Root `package.json` belongs to Claude; the requested root-level alias is proposed in `docs/STATUS.md`.

After labeling, score the last development predictions without another API call:

```powershell
npm --prefix eval run eval -- meter --score-latest
```

Rescoring requires unchanged reader/client sources, split and photo bytes. Each run produces a new aggregate report rather than overwriting an earlier result. Errors stop the run (except per-image schema failures), with unrun photos counted explicitly. Network errors are returned as safe reason codes; raw exceptions and API bodies are never logged. Unknown usage/cost is explicitly unknown, not free.

## Development and held-out groups

The initial batch is assigned entirely to one development group before inference. This conservatively keeps photos from the same capture together and makes no held-out claim. To initialize a new dataset only once:

```powershell
node eval/split.js --initial-development
```

New arrivals are unassigned and block evaluation until grouped. Create private `groups.json` for **new files only**, mapping each filename to `{ "group": "capture-group", "side": "development" }` or `"heldout"`. Use one group for all shots from the same moment. The tool refuses reassignment of existing files, groups spanning both sides, and identical photo bytes spanning both sides. Humans must group related but byte-different photos; this tool does not infer capture moments.

```powershell
node eval/split.js --add-groups
node eval/split.js --freeze
npm --prefix eval run eval -- meter --heldout
```

Freeze requires a nonempty held-out partition. Held-out runs require a frozen split, human answers for every selected photo, and explicit `npm run eval` execution. The first run locks the split digest privately. There is at most one held-out checkpoint per IST day, recorded **before** the first request so an interrupted run cannot silently repeat. No held-out run happened during initial development. Add all planned capture groups before freezing; later dataset changes need a new agreed checkpoint/dataset policy from Claude. Do not tune from held-out outcomes. If a reader changes after a checkpoint, reports mark `promptsChangedSinceHeldout`; only a later checkpoint can run again.

## What the numbers mean

- `exactAccuracy`: exact raw display **and** numeric tenths, divided by human-readable meter answers among evaluated photos. Abstentions, wrong classifications and API failures remain in that denominator.
- `valueAccuracy`: same denominator, comparing numeric tenths only (leading zeros do not change the value).
- `wrongButConfidentCount`: a returned clear numeric value differs from the human value, or was returned on a human-marked unclear/non-meter photo. It is `null` with no human answers. `unassessedConfident` is shown separately; zero assessed errors is not proof that unassessed readings are correct.
- `unclearRate`: successful meter responses with no reliable reading, divided by all evaluated photos. API failures are separate; `notMeter` is also separate.
- Classification and dashboard-clock accuracy have their own explicit denominators. A clock never supplies the meter reading.
- Rates use integer basis points (`10000` = 100%) and keep numerator/denominator. Empty denominators give `null`.
- Latency includes retries/backoff; token totals include all attempts with reported usage. Costs use integer nano-USD and verified standard pricing; unknown failed-attempt charges are not guessed.

All automated tests use invented values and mocked responses. Passing those tests does not establish real-photo accuracy or guarantee that model confidence is calibrated.
