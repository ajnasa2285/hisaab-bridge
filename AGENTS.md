# Rules for every builder (Claude, Astra, Fable, Codex)

Read this file first, then `docs/CONTRACTS.md`, then your brief in `docs/briefs/`. These rules override convenience. Breaking rules 1–4 can get the whole entry disqualified from the Meta Global AI Developer Hackathon.

## Hackathon rules (hard)

1. **New code only.** Everything in this repository is written during the event, from **27 October 2026, 09:30 IST**. Do not copy, port, translate or regenerate code from anywhere else on this computer.
2. **Never open the owner's private projects**, not even to "look how it was done": open nothing on this computer outside this repository, except the private data folder named in rule 4. Design knowledge is in `docs/`; that is all you need. Open-source libraries from npm are fine.
3. **Only Meta models at runtime.** Every model the product calls is a Meta model through the Meta Model API (Muse Spark, Muse Voice Transcribe). No Gemini, OpenAI, Anthropic or any other model endpoint in `src/`, not even for comparison. All model calls go through `src/meta/client.js`. A test fails the build if another model endpoint appears.
4. **The repository is public.** No keys, tokens, passwords, real phone numbers, real names, real photos, real UPI screenshots or real amounts in the repo, in tests, in commit messages, or in logs that get committed. Tests use invented data and phone numbers `9190000000xx`. Real data lives only in `D:\MUNSHI\CLAUDE\HACKATHON\hisaab-data\` (outside the repo) and on the server.

## Engineering rules

5. **The model reads and explains; code calculates and decides.** A reader returns what is printed or said (or `null` when unclear). Code computes hours, quantities, money, differences and states, on integers only: hours in tenths, quantities in hundredths, money in paise. No floating point is stored or compared.
6. **People decide.** Nothing is booked, sent, accepted, disputed, corrected or settled without the explicit WhatsApp reply of the person allowed to decide it, bound to the exact item asked about.
7. **Nothing is erased.** Ledgers are append-only. A correction is a new version that names the one it replaces. A screenshot or a claim never settles anything by itself; only the receiver's confirmation does.
8. **Never guess.** An unclear reading asks for a retake or marks the item for a person. A figure an explanation cites must exist in the ledger, or the explanation is dropped.
9. **No payment reminders or chasing** (WhatsApp policy on debt collection). Show status; never nag.

## How we work together

10. **Your folder, your branch.** Claude works on `main`; Astra on branches `astra/<topic>`; Fable on `fable/<topic>`. Only touch the folders your brief gives you. Need a change elsewhere: write it in `docs/STATUS.md` and Claude does it or agrees.
11. **The interfaces in `docs/CONTRACTS.md` are fixed.** If one is wrong or missing, write the proposal in `docs/STATUS.md`; do not change it on your own.
12. **Stack:** Node 24, ES modules, plain JavaScript with JSDoc types checked by `tsc` (`npm run typecheck`), `node:test`, `node:sqlite`. Add a dependency only with Claude's agreement in `STATUS.md`.
13. **Tests with every change.** Unit tests run locally (`npm test`). Claude runs the full suite on AWS before merging. Do not merge into `main` yourself.
14. **Status:** at the end of each work session, add to `docs/STATUS.md` under your name: done, next, blocked, questions. Short, dated (IST).
15. **Commits:** small, with a clear message. The author identity is the owner's (already configured); add `Co-Authored-By:` for the tool you are (e.g. `Co-Authored-By: Astra <noreply>`), so the README's disclosure of tools stays true.
16. **Language:** user-facing texts in Hindi (Devanagari), short and plain; numbers as digits. Code, comments and docs in English.
