# Brief: Claude session, one message with two requests + asking about an unknown site name

Read `AGENTS.md`, `docs/CONTRACTS.md`, `docs/BUILD2.md` and `docs/text-keys.md` first. The lead (Claude, main session) reviews, runs the full
suite and typecheck on AWS, replays the live ledgers, merges and deploys. You build on a branch and stop there. Finish by 31 Oct: the feature freeze is 1 Nov.

## Worktree and branch
Never switch branches in `hb-claude` (the lead's checkout):
`git -C D:\MUNSHI\CLAUDE\HACKATHON\hb-claude worktree add ..\hb-multi -b claude/multi-request claude/wa`
Run `npm ci` there first. Push only the branch: `git push origin claude/multi-request`. Never push to main. Files LF. New Hindi texts in plain words (no "—"), in
`src/i18n/hi.js` and `docs/text-keys.md`.

## Why
Live test on the current code (30 Oct): "50 bags cement, 40 tons sand and jcb for 2 hours is required tomorrow at NDUAT site tomorrow morning 10 Am" and its Hindi form, 8 runs:
5 silently dropped the JCB (the read-back showed only the material), 3 got `common.unknown_step` because Muse correctly returned two calls and `proposeStep` refuses anything but one.
The silent drop is the serious part: a person says हाँ and the JCB is never ordered, and nobody is told.
Also: "NDUAT" would become a new site, though it may be a short name for a site already on the books. The owner's rule: the agent asks about a name it does not know; it never guesses.

## 1. One message, two requests
- Only this combination: one `request_material` and one `request_jcb`, for the role(s) that may call them. Tell the model in the prompt that it may call both for such a message. Any other
  several-call answer stays `common.unknown_step`, as now. Payments, bills and yes/no stay one step at a time.
- Each request goes through its own existing `partial`/`complete` checks. If one lacks a value, ask for it as the fill path does now, then continue; nothing is sent until the person has confirmed both.
- **One read-back, one हाँ**, naming both, e.g. "दो माँग: (1) सीमेंट 50 बोरी, बालू 40 टन (2) JCB 2 घंटे, NDUAT, कल सुबह 10 बजे। हाँ / नहीं". नहीं cancels both.
- After हाँ each runs as its own order with its own ref and its own signed message: P-n and J-n, each through `office.commit`.
- **The limit is checked per order.** One may be held for the contractor while the other goes. The reply names what happened to each. If one fails to send, the other's result still stands and the person is told both.
- Keep exact replies and single requests unchanged. A person sending one request sees no change.
- Check how this fits the one-open-question queue (`whatsapp1` fix in `src/agents/conversation.js`).

## 2. Ask about an unknown site name (the owner's request)
- When a request names a site that is not in the agent's known sites (`ctx.sites`) or its saved short names, and at least one known site exists: ask once, before the read-back:
  "NDUAT कौन सी साइट है? 1. शिवपुरी 2. ... 3. नई साइट". Code decides, from an exact match only; Muse does not guess that two names are the same.
- A number picks that site: the short name is saved for this agent, and the order is recorded under the full site name. "नई साइट" (or the last number) saves the name as a new site. Either way it is never asked again, for anyone on this agent.
- Saved per agent, in the agent's own data dir (not in the ledger; events stay as they are). Compare trimmed and case-folded. Show at most 6 recent sites, then "नई साइट".
- A wrong short name can be dropped with the existing `भूल जाओ` style command if that is small; otherwise list it as a known limit.
- Only site names in this build. Do not try to detect jargon in item names: the read-back shows them and the supplier sees them. Tell the lead if you think otherwise.
- With no known sites at all, do not ask. A person's default site from `people.json` works as now.
- A supervisor's short name stays usable by the contractor on the same agent.

## Tests (node:test, invented data, phones `9190000000xx`)
Both requests read back together; हाँ makes two orders with two refs; नहीं makes none; one held and one sent; one missing a value; a failure on one; other several-call answers refused; single request unchanged.
Unknown site asked once, number picks a known site, new site saved, not asked twice, another person on the agent not asked, no known sites no question, exact match only. `test/rules/meta-only.test.js` still passes.
The site question must also work inside the two-request flow, with only one question.

## Live check (cheap, allowed)
`META_API_KEY` is in the environment; set `META_API_BASE=https://api.meta.ai/v1` and `MUSE_SPARK_MODEL=muse-spark-1.3` for the command only. With a throwaway script outside the repo, using `proposeStep` and the real reasoning effort:
at least 10 wordings in Hindi, Hinglish and English × 3 runs, including the two above, plus single requests that must stay single (for example material only, JCB only, "सीमेंट और बालू"). Report for each: did both requests come back, was any dropped, did a single turn into two. Never print the key. Do not commit the script.
A wording that still drops the JCB must be reported plainly: if it is common, add a guard or say so.

## Machine limits and rules
On the owner's laptop: do not run `npm run typecheck` or the whole `npm test`; only the test files you touch, a few at a time. Do not touch the server, people.json or any Meta setting.
Hackathon rules: new code only, only Meta models at runtime, no real data or secrets in the repo. Old ledgers must still replay.

## Done means
Branch pushed; a short report for the lead: what changed, files, tests and local results, the live-check table, anything unsure.
