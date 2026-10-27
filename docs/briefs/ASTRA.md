# Brief: Astra — the readers and their measurement

Read `AGENTS.md` and `docs/CONTRACTS.md` first. Start no earlier than **27 October 2026, 09:30 IST**.

## Why your part matters

Judges score "whether it holds up in production". The readers are where Meta's model touches the real world: the JCB hour meter, the UPI payment screenshot, the delivery challan. Your numbers (how often each reader is right, unsure, or wrong-but-confident) are the evidence in the README and the video.

## What you build (your folders: `src/meta/`, `src/readers/`, `eval/`, `test/readers/`, `test/meta/`)

1. **`src/meta/client.js`** exactly as in CONTRACTS section 2. First job: confirm with the owner the API base URL, the model IDs for Muse Spark and Muse Voice Transcribe, and the request format, from Meta's current documentation. Write what you verified (and from where) in `docs/meta-api-notes.md`. The key is set on the machine as `META_API_KEY`; never print it, never write it to a file in the repo.
2. **`src/readers/meter.js`** (CONTRACTS 3.1), first priority. The meter is a printed digit display: ask for the digits exactly as shown, the position of the decimal point, any digit in doubt, and any clock on the dashboard. Code converts `raw` to `valueTenths`. A blurred, cut-off or glared display is `clear: false`, never a guess.
3. **`eval/`**:
   - a small local **answer-key tool** (a page or a CLI) where the owner sees each photo and types or confirms the correct value; it writes `answers.json` in the data folder (outside the repo);
   - `split.json`: development vs held-out, frozen before the first held-out run (photos taken at the same moment stay on one side);
   - `npm run eval -- meter [--heldout]`: runs the reader, compares with the key, writes aggregate results to `eval/results/meter-<date>.json`: exact accuracy, unclear rate, **wrong-but-confident count** (the number that matters most), latency, tokens, cost.
4. **`src/readers/upi.js`** (CONTRACTS 3.2) and **`src/readers/challan.js`** (3.3), the same way, with their own answer keys and results.
5. **`transcribe`** in the client, and a small check on the owner's Hindi voice samples (how many words and numbers are right), if the samples arrive.

## Data

The owner puts real photos into `D:\MUNSHI\CLAUDE\HACKATHON\hisaab-data\{meters,upi,challans,voice}\`. Expect about 20 meter photos by 28 October, 60 in total; 15–20 UPI screenshots and 10–15 challans by 30–31 October. **Nothing from that folder goes into the repo**: no images, no file names, no values. Tests in the repo use invented fixtures (e.g. a generated image of digits, or a recorded fake model response).

## Rules that apply to you especially

- Prompts and schemas are yours to tune **on development files only**. Never tune after looking at held-out results; if you must change the reader after a held-out run, say so in the results file and run held-out again only at the next checkpoint.
- The reader returns `null` rather than guess. A higher unclear rate with zero wrong-but-confident is better than the reverse.
- Only `src/meta/client.js` calls the network.

## Schedule

| Day | Outcome |
|---|---|
| 27 Oct | Meta API verified, `client.js` + tests, meter reader v1, answer-key tool, first development numbers |
| 28 Oct | split frozen; meter reader improved on development; **first held-out meter run** (checkpoint) |
| 29–30 Oct | UPI reader + key + results; challan reader + key + results |
| 31 Oct | voice check if samples exist; final held-out runs; results summary for the README |

Write progress and questions in `docs/STATUS.md` under "Astra" at the end of each session. Work on branches `astra/<topic>`; Claude merges after the tests pass on AWS.
