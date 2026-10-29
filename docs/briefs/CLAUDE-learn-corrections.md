# Brief: Claude session, learning from corrections (each agent's reading gets better with use)

Read `AGENTS.md`, `docs/CONTRACTS.md`, `docs/BUILD2.md` (sections on read-backs, any photo, GST, Inside the agent) and `docs/text-keys.md` first. The lead (Claude, main session) reviews, runs the full suite and typecheck on AWS, merges and deploys. You build on a branch and stop there. Feature freeze is 1 Nov: finish by 31 Oct evening.

## Worktree and branch
Never switch branches in `hb-claude` (the lead's checkout) or `hb-astra-usual` (Astra, running now):
`git -C D:\MUNSHI\CLAUDE\HACKATHON\hb-claude worktree add ..\hb-learn -b claude/learn-corrections claude/wa`
Run `npm ci` there first. Push only the branch: `git push origin claude/learn-corrections`. Never push to main.
Astra (`astra/usual-figures`) adds keys to `src/i18n/hi.js`, `docs/text-keys.md` and one-line additions to bill/yes/approval messages. Keep your changes there additive.

## Why
Every time a person corrects what Muse read (meter digits typed after a misread, the challan quantities typed in, a site count changed, a UPI amount that differed, a GST rate fixed with "सुधार", a voice note re-said), that correction is the best training signal the agent will ever get, and today it is thrown away. Each agent should remember its own corrections and use them the next time it reads the same kind of document from the same party, so the same mistake is not made twice and people are asked less over time. It must stay safe: memory only steers the reading; code still checks every figure, and a person still decides.

## What to build
1. **Correction memory per agent** (`src/learn/corrections.js`, sqlite in the agent's own data dir, append-only): one row per correction: `{kind: meter|challan|invoice|upi|site_challan|voice, party (counterparty agent or the sender's role), field, read (what Muse read), corrected (what the person gave), photo sha256 or null, layout note (short text Muse gave of the document, e.g. "two-column challan, qty right of rate"), at}`. Recorded only when a person's correction is committed (the existing paths that today take typed figures / सुधार / changed counts). No bytes, no phone numbers.
2. **Using it** (the readers in `src/readers/` and the voice/understand path):
   - when reading a document of the same kind from the same party, the prompt gets a short "past corrections for this sender" block (at most 5 most recent, as data: "you read 30, the person corrected to 50; field: qty; layout: ..."), clearly marked as data, never instructions;
   - for voice: known corrections of names/words (e.g. site name heard as "पिठला" corrected to "पिठला साइट"), a small per-agent glossary used by code to normalise the transcript before understanding (like `spokenRefs`), only exact word replacements that people confirmed at least twice;
   - every reading that used memory is still checked by code exactly as now, and when the result differs from what it would have been without memory on a figure, it is read back (never committed silently).
3. **Showing it improves** (this is what judges see):
   - trace `check`/`model` lines: "used 2 past corrections from this supplier" and whether the person had to correct again;
   - a small "learning" card on the judge page per agent: corrections recorded, re-corrections of the same field after memory (should fall), by kind;
   - ask anything: "कितनी बार ग़लत पढ़ा गया?" style question answered from the memory (count by kind), numbers by code.
4. **Controls**: memory is per agent and private (never sent to another agent); `HB_LEARN=0` turns its use off (recording continues); a person can say `भूल जाओ <ref>` to drop corrections that came from that order (owner/contractor only).
5. **Texts and docs**: new keys in `src/i18n/hi.js` + `docs/text-keys.md` (plain Hindi like the polished texts); a "Learning from corrections" section in `docs/BUILD2.md`; README roadmap line updated by the lead, not you.

## Eval (this is the proof)
Using invented documents you render yourself (never the owner's private photos), build a small before/after eval: 4–6 challans/invoices with a layout Muse misreads, one correction recorded, then the next similar document read with memory on vs off. Report the field accuracy both ways. Keep it in `eval/learn/` with invented images only.

## Machine limits
On the owner's laptop: do not run `npm run typecheck` or the whole `npm test`; run only the test files you touch. Live Meta calls allowed for the eval: set `META_API_BASE=https://api.meta.ai/v1` and `MUSE_SPARK_MODEL=muse-spark-1.3` for the command only; `META_API_KEY` is already in the environment; never print it; keep total calls under 150.

## Tests (node:test, invented data, phones `9190000000xx`)
Recording on each correction path; nothing recorded without a committed correction; prompt block built from at most 5, per party, marked as data; memory-changed figure is read back; voice glossary needs 2 confirmations; `भूल जाओ` role-limited; `HB_LEARN=0`; trace lines; `test/rules/meta-only.test.js` still passes.

## Done means
Branch pushed; a short report for the lead: files changed, the eval numbers (memory on vs off), tests added and local results, anything unsure. Do not merge, deploy, or touch the server or any Meta/WhatsApp setting.
