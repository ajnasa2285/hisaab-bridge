# Brief: Claude session, fixes from the independent audit (before the 1 Nov freeze)

Read `AGENTS.md`, `docs/CONTRACTS.md`, `docs/BUILD2.md` and `docs/text-keys.md` first, then the audit:
`D:\MUNSHI\CLAUDE\HACKATHON\RED HAT TEAM REVIEW\AUDIT_REPORT.md` (it audited commit 14ef389 = current main;
its line numbers match). The lead (Claude, main session) reviews, runs the full suite and typecheck on AWS,
merges and deploys. You build on a branch and stop there. Finish by 31 Oct.

## Worktree and branch
Never switch branches in `hb-claude` (the lead's checkout):
`git -C D:\MUNSHI\CLAUDE\HACKATHON\hb-claude worktree add ..\hb-audit -b claude/audit-fixes claude/wa`
Run `npm ci` there first. Push only the branch: `git push origin claude/audit-fixes`. Never push to main.
Files LF. New Hindi texts: plain words like the polished keys in `src/i18n/hi.js` (no "—"), listed in `docs/text-keys.md`.

## What to fix (only these; keep each change small)
1. **MED-01 evidence through the proxy.** `deploy/aws/Caddyfile`: `/agents/*/a2a` gets an 8 MB body cap,
   everything else keeps 1 MB (see the audit's patch; check Caddy syntax: a `request_body` inside each `handle`).
   Check how `setup.sh` installs the Caddyfile so the change actually reaches the server on deploy. Keep A2A over
   HTTP (no in-process shortcut). Add a static test that the a2a path's cap is at least `MAX_BODY_BYTES` of
   `src/transport/a2a.js` and the webhook path stays at 1 MB.
2. **MED-03 never silent.** In `src/wa/wa.js` `dispatch`, when `onMessage` throws, send the person one reply with a
   text key (e.g. `common.try_again`: "कुछ गड़बड़ हुई, यह संदेश दोबारा भेजें।") and log as now. A media file too large
   for `fetchMedia` gets its own clear reply. Do not build the inbox/replay table (after the hackathon).
   Test: a throwing `onMessage` gives exactly one reply.
3. **MED-05 + LOW-03 undeliverable messages.** In `src/agents/link.js`, when a peer refuses `EXPIRED`, or a pending
   message is past `expires_at` and still unreachable: append a local `NOTE {kind:'undelivered', msg_id, type}`,
   stop retrying it, and tell the person(s) who asked (new key naming the ref and saying to send it again).
   Guard the 60 s retry interval in `src/app.js` against overlapping runs. Tests for both.
4. **LOW-01 forwarded payment screenshots.** In `src/agents/conversation.js`, a forwarded UPI screenshot or cash
   receipt is refused like a forwarded meter photo (new key: send it from your own UPI app / your own photo).
   Challans stay exempt (CONTRACTS §7). Test.
5. **LOW-02 dead payment limit.** Remove `HB_LIMIT_PAYMENT_RUPEES` (main.js, env example, docs, README) and the
   `hold` on `claim_payment`/`claim_group`; payments are contractor-only by design. Add the audit's test idea:
   every tool that declares `hold` has at least one gated role that can call it.
6. **LOW-10 logging never stops the product.** `src/meta/client.js`: a `recordCost` failure is logged once and the
   model result is returned unchanged (no `cost_log_failed`). Keep `test/rules/meta-only.test.js` passing.
7. **MED-04 (part) safe names.** Site names, item names and units allow only letters (incl. Devanagari and its
   marks), digits, space and `- . / ( ) , &` — at intake (`siteOf`, `validItems`, the orchestrator's item parsing)
   and on incoming `BOOKING_REQUEST` (`src/protocol/messages.js`). A name that fails is asked again at intake,
   refused at the protocol. Do NOT move prompt content between system and user turns (after the hackathon).
   Live names that must keep working: शिवपुरी, पिठला, भट्टे, कलकल भट्ठे, cement/सीमेंट, बोरी, gitti, balu, brass, cft.
   Stored ledger events are never re-validated by this rule; check that export/replay does not re-run it.
   Test: the audit's injection site name is refused; the live names pass.
8. **Flaky test + README.** `test/agents/payments-part.test.js:152`: wait for the `pay.seller.settled_at_accept`
   notice before asserting (audit section 4). README: test count from the suite (do not guess; the lead will
   confirm on AWS), and a short "Known limits (next steps)" section listing honestly: no request-rate limits on the
   public endpoints, one shared viewer key for the judge page, messages handled at most once (a crash mid-message
   loses it; the person is now told on errors), ledger text from the other party still sits in the model's
   instructions (guarded by the tool list, code checks and read-back), all three agents in one process on one host.

## Not in scope
Rate limiting, per-viewer tokens, UTR masking, inbox/replay table, ORDER_OPENED chain event, strict body key lists,
per-party glossary, cross-seller UTR check, deploy pins. Do not touch the server, people.json or any Meta setting.

## Machine limits
On the owner's laptop: do not run `npm run typecheck` or the whole `npm test`; run only the test files you touch
(at most a few at a time). No live Meta calls needed.

## Done means
Branch pushed; a short report for the lead: what changed per item, files, tests added and local results, anything unsure.
