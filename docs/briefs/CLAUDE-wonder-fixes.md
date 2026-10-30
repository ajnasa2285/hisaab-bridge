# Brief: Claude session, fixes from the Muse Wonder red-team review (before the 1 Nov freeze)

Read `AGENTS.md`, `docs/CONTRACTS.md` and `docs/text-keys.md` first, then the findings:
`D:\MUNSHI\CLAUDE\HACKATHON\RED HAT TEAM REVIEW\muse-wonder\all-findings.txt` (reviewed commit 6d4fb6c = current main; ids like
`a2a1` below refer to that file). Its line numbers are approximate. The findings are a model's claims: treat them as leads.

The lead (Claude, main session) reviews, runs the full suite and typecheck on AWS, replays the live ledgers, merges and deploys.
You build on a branch and stop there. Finish by 31 Oct.

## Method: failing test first
For each item write a test that fails on the current code and shows the attack, then fix it. **If you cannot make the attack
happen, do not change the code: report it as "not reproduced" with what you tried.** Report honestly per item; the counts go into
the submission document.

Already reproduced by the lead on in-memory ledgers: a2a1, a2a2, a2a3. Confirmed by reading the code: money1, money5, whatsapp1.

## Worktree and branch
Never switch branches in `hb-claude` (the lead's checkout):
`git -C D:\MUNSHI\CLAUDE\HACKATHON\hb-claude worktree add ..\hb-wonder -b claude/wonder-fixes claude/wa`
Run `npm ci` there first. Push only the branch: `git push origin claude/wonder-fixes`. Never push to main. Files LF. New Hindi texts in
plain words (no "—"), in `src/i18n/hi.js` and `docs/text-keys.md`.

## A. Must fix (these change state or money)
1. **a2a1 + a2a3: a REFUSE can rewind or freeze an order.** A replayed or late REFUSE rewinds the sender's order, or makes `view()`
   throw for good; a bad signature even earns a signed REFUSE from the other agent, for anyone who knows the two UUIDs.
   - No signed REFUSE for a request that failed sender authentication (`UNSUPPORTED`, `NOT_CONNECTED`, `BAD_SIGNATURE`): an unsigned
     error instead, which the sender treats like an unusable answer (it stays pending).
   - `receive()` accepts no standalone REFUSE except the evidence decline (`declined_by_owner`) tied to our own `EVIDENCE_REQUEST`.
     Ordinary refusals are recorded only by `recordAnswer()` as the direct answer to a message just delivered.
   - `recordAnswer()` ignores a REFUSE for a message that already has a RECEIPT.
   - Check how the transport calls `recordAnswer`, so a REFUSE arriving as the HTTP answer still works and one POSTed in does not.
2. **a2a2: expiry can split the two ledgers.** Repeats come before expiry: a message already applied gets its original receipt whatever
   its `expires_at` (expiry gates the first application only; signature and exact-match checks stay). On the sender, "unreachable past
   expiry" must not count as never happened, since it may have been applied: tell the person once, keep retrying at a slower pace, and
   let only a signed answer decide (receipt = it counts; `EXPIRED` for a message the peer never saw = undelivered). This changes the
   `giveUp` path added in `src/agents/link.js`; update its tests.
3. **whatsapp1: a notice can steal a yes.** `expect()` overwrites an open read-back, so a bare हाँ meant for one question answers another
   (accepts a bill, confirms money). Keep the open question: later expectations wait in a per-person queue and are asked when the current
   one is answered or lapses. Set an expectation only if the notice was actually sent. Keep exact replies and fewer steps: a person with
   no open question sees no change.
4. **money1: acceptance not bound to the bill.** `accept_bill` args and its expectation carry the bill's message id. At run time, if the bill
   in force differs, nothing is accepted and the person is shown the new bill and asked again.
5. **money2: a correction above the delivery.** A CORRECTION with a quantity above the signed delivery (unless it equals the site's
   count) is told as a mismatch, with no one-word acceptance armed.
6. **money3: same UTR on two bills.** The seller's claim notice says when this UTR was already used on another of this seller's orders
   (shares of one group excepted), and which.
7. **money4: one receipt counted twice.** `record_received` with a waiting claim of the same amount on that order tells the seller to answer
   that claim instead (they can still record it if they say it is a separate payment).
8. **money5: denial does not re-check settlement.** After any `PAYMENT_ACK` that clears the pending list, including a denial, run `settleIfDue`.
9. **money6: a clubbed payment left half made.** A share that is recorded but still undelivered does not stop the rest; all shares are recorded
   under the group, and the seller's notice appears once they arrive.
10. **a2a4: balances ignore refused messages.** `paymentSummary` filters with `refusedIds` like `view()`.
11. **a2a5: padding.** Cap non-EVIDENCE messages at 64 KiB, and a RECEIPT must name a message we actually sent or received. Closed schemas
    (`only()`) on the rest only if the current tests and the replay stay green.

## B. Should fix (small)
12. **model2:** `readLearned`'s differs check also covers invoice rate, taxable value, GST, grand total and `signed`. Stop putting raw line text in
    the learning layout note.
13. **model1 (and audit LOW-07):** the voice glossary is per person; entries can be forgotten; show the replacement in the read-back.
14. **whatsapp2:** pass Meta's timestamp to the conversation; a yes/no older than the question is not an answer (ask again).
15. **whatsapp3:** `record_meter` rejects a `which` that no longer fits the ledger, and the photo path re-reads the order before it commits.
16. **whatsapp4:** approval separation compares agent + phone, not the line.
17. **model3:** the number-word and wording guards also know romanised Hindi (pachaas, hazaar, galat, bhej do...).
18. **model4:** when the UPI reader has a payee name, show it in the seller's claim notice.

## C. From today's live test (lead's list; not security)
19. **Unit from the order:** a challan reading whose only gap is a missing unit, with one item matching the order's item, takes the order's unit and counts as clear. If the
    quantity or item differs, ask as now. Real cash memos have no unit column.
20. **Estimate includes GST:** the ₹25,000 check adds the last GST percent for that party and item, when known.
21. **Supervisor's bill copy:** the supervisor's copy of a bill notice does not say "हाँ लिखें"; a supervisor's हाँ gets "बिल ठेकेदार मंज़ूर करेंगे" rather than the help list.
22. **Trace depth:** `clean()` in `src/trace/trace.js` shows request items instead of `[null]`.

## D. Not in scope (list under "Known limits" in the README, one line each)
whatsapp5 (a supervisor can split a need into several orders under the limit; the contractor is told of each). Nothing else new.

## Compatibility (important)
The live ledgers hold real test history with REFUSE, RECEIPT and undelivered-free events. Nothing here may stop an old ledger from replaying: rules apply to new incoming
messages, never to stored events, and `view()` must not start throwing on existing history. Do not change the meaning of messages already stored.

## Machine limits
On the owner's laptop: do not run `npm run typecheck` or the whole `npm test`; run only the test files you touch, a few at a time. No live Meta calls needed.
Do not touch the server, people.json or any Meta setting. Hackathon rules: new code only, only Meta models at runtime, no real data or secrets in the repo, test phones `9190000000xx`.

## Done means
Branch pushed; a short report for the lead: per item (reproduced? fixed? tests added, files), and anything not reproduced or unsure.
