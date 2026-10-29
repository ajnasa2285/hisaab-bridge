# Brief: Astra, Build 4: evidence on request between agents

Read `AGENTS.md`, `docs/CONTRACTS.md` (sections 4 and 5), `docs/BUILD2.md` (Explanations, Site challan) and `docs/text-keys.md` first. The lead (Claude) reviews, runs the full suite and the typecheck on AWS, merges and deploys. You build on a branch and stop there.

## Worktree and branch
Work only in your own worktree; never switch branches in `hb-claude` (the lead's checkout) or `hb-streamline` (another session running now):
`git -C D:\MUNSHI\CLAUDE\HACKATHON\hb-claude worktree add ..\hb-astra-evidence -b astra/evidence claude/wa`
Commit with the repo's configured identity. Push only the branch: `git push origin astra/evidence`. Never push to main.

Another session (`claude/streamline`) is changing read-backs and texts in `src/agents/conversation.js`, `src/i18n/hi.js` and the agents' reply paths. Keep your changes to those files small and additive (new functions, new keys) so the merge stays easy.

## Why
The product's idea: every business has its own agent, and agents help each other instead of arguing. Today, when the two sides' figures differ (a disputed bill, a site count that differs from the challan), each agent explains from its own ledger, but neither can see the other side's evidence. In real practice the kiln or supplier and the customer exchange the challan copies at audit. The agents should do that themselves, and code should prove the evidence is the very record that was signed at the time.

## What exists
- Every photo-based record carries only `sha256` of the photo: DELIVERY challan, the site's count (`NOTE site_count` with `challan: {sha256, number}`), meter readings, `PAYMENT_CLAIM.screenshot.sha256`. The bytes are not kept anywhere.
- Signed messages (`src/protocol/`), A2A transport (`src/transport/a2a.js`), per-agent ledgers (`src/ledger/`), explanations (`src/agents/explain.js`, `explain-facts.js`), readers (`src/readers/`), WhatsApp client (`src/wa/cloud.js`, receive only for media).

## What to build
1. **Private media store per agent** (`src/media/store.js`): when an agent records a photo-based entry, it keeps the bytes in its own data directory (`HB_DATA_DIR`, never the repo), named by sha256, with a size cap (5 MB) and the MIME. Reading back checks the hash. Tests use a temp directory.
2. **Two new protocol messages** (CONTRACTS section 4, signed like the rest, either direction between the two parties of an order):
   - `EVIDENCE_REQUEST`: `order`, `refers_to` (the msg_id of the record whose evidence is asked: a DELIVERY, a site-count NOTE, a meter reading, a PAYMENT_CLAIM), `reason` (short code: `bill_disputed`, `count_differs`, `asked`).
   - `EVIDENCE`: `refers_to` (the request), `items: [{record: msg_id, sha256, mime, bytes (base64)}]`, or a signed `REFUSE` with a code (`no_such_record`, `not_party`, `not_kept`).
   The sender serves only records of that order between these two parties. The receiver accepts an item only if `sha256(bytes)` equals the hash already in its own ledger for that record; anything else is refused and nothing is shown. Ledger records the request/evidence metadata (hashes, not bytes); the received bytes go to the receiver's media store.
3. **When it happens**:
   - automatically when a difference becomes known: on DISPUTE (seller asks for the buyer's site-count evidence when the dispute cites the site's count; buyer asks for the meter photos or the challan the bill rests on) and when the contractor's agent finds the site count differs from the DELIVERY (asks the supplier's agent for its challan photo);
   - on a person's command: `सबूत P-1` / `saboot J-1` (parsed by code in `src/agents/office.js` like `स्थिति`), which asks the other side for the evidence of that order's latest records.
4. **What the person sees**: the evidence photo forwarded on WhatsApp (add `sendImage` to `src/wa/cloud.js`: media upload, then an image message, inside the 24-hour window), with a caption from code: whose record, when, and "फ़ोटो वही है जो दर्ज हुई थी" (hash matched). Then Muse Spark runs the matching reader on the received photo and the explanation (`explainDifference`) gets both sides' readings as facts, so it can say e.g. "सप्लायर के चालान पर 50 बोरी, साइट की गिनती 48"; code still checks every number. If sending the image fails, send the text only.
5. **Permissions and safety**: an agent never sends evidence of an order the asker is not a party to; never more than the records of that order; no reminders, no verdicts; operator role cannot trigger `सबूत`. Rate limit: one automatic request per record.
6. **Texts and docs**: new keys in `src/i18n/hi.js` and `docs/text-keys.md` ("Astra drafted, Fable to polish"); CONTRACTS sections 4 and 5; a short "Evidence on request" section in `docs/BUILD2.md`.

## Tests (node:test, invented data, phones `9190000000xx`)
Media store round trip and hash check; request/evidence between two in-memory agents over the real protocol; a tampered byte → refused, nothing shown; asking for a record of another order or another party → signed REFUSE; automatic request on DISPUTE and on count difference; `सबूत P-1` command; explanation uses both readings and its numbers are checked; `sendImage` failure falls back to text; `test/rules/meta-only.test.js` still passes.

## Live check (cheap, allowed)
`META_API_KEY` is in the environment; set `META_API_BASE=https://api.meta.ai/v1` and `MUSE_SPARK_MODEL=muse-spark-1.3` for the command only. With a throwaway script outside the repo, run 3–4 invented disputes where evidence is exchanged and the reader runs on an invented or public sample photo (never the owner's private photos); report the explanation and the number check. Never print the key; do not commit the script.

## Machine limits
On the owner's laptop: do not run `npm run typecheck` or the whole `npm test`; run only the test files you touch. The lead runs everything on AWS.

## Done means
Branch pushed; a short report for the lead: files changed, the live-check results, tests added and their local result, anything unsure. Do not merge, deploy, or touch the server or any Meta/WhatsApp setting.
