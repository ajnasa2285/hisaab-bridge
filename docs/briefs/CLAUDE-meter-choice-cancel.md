# Brief: Claude session, meter photo with two jobs, cancelling an order, trace label (31 Oct)

Branch `claude/meter-cancel`, worktree `hb-meter-cancel`, off `claude/wa` ac621ef. Not pushed, not deployed. The lead runs the full suite and strict type check on AWS, replays the live ledgers, updates the README test count, and deploys. Design in `docs/BUILD2.md` (last section) and `docs/CONTRACTS.md` (sections 4 and 5).

## 1. Meter photo with several jobs open

Before: `orchestrator.which_job` ("write the site or day"), nothing kept, no answer resolved it, so with J-2 and J-3 booked no meter photo could be recorded.

Now the photo waits unread as the one open question (`meter_job`), with the jobs listed by number, reference, site and day. A number or reference picks the job and `onMeterImage` carries on as for one job, reading included. A number or reference off the list, or a "हाँ", asks again. A no or cancel word drops it (`DROP_WORDS` in the conversation, not `NO_WORDS`: a bare `रद्द` to a seller must not decline an order at once). Another message lapses it and is read as new. One reference in the caption answers before asking; `src/app.js` now passes the webhook's caption. A caption naming a job that is not open asks, even with one job open, rather than recording on the wrong job.

A new photo while the question is open replaces the held one (as for any open question), so two quick photos ask once, about the second.

## 2. Cancelling

Signed `CANCEL` with an empty body, either party to the other; terminal state `cancelled` from `requested`, `offered` or `booked`. `src/agents/cancel.js` holds the tool and `cancelBlock`, the reasons. Command `रद्द J-2` (`J-2 रद्द करो`, `cancel J-2`) goes through `parseCommand`, then `askCancel` in the conversation, then one read-back and "हाँ". It has no orchestrator spec, so the model cannot propose it.

Rules beyond the brief's wording:

- A claim the seller denied does not block; a waiting or confirmed one does.
- A site count before the delivery blocks too: the goods came. The count is a local note the state machine does not see, so `receive` in `src/protocol/exchange.js` refuses a supplier's `CANCEL` with `WRONG_STATE`.
- A `CANCEL` on a cancelled order fits and changes nothing, so both sides cancelling at once ends cancelled on both, both receipted.
- `रद्द` on a step still held for approval says to decline it with `नहीं J-2 कारण`.

## 3. Trace label

Cause: `tagRef` on a held first request set the reference on the whole handling, so the second request's check and decision took it, and `attach` then also gave those lines the second order's id. A first request that ran gave them its own order. Reproduced first: the test failed with `approval not needed … → runs: P-1` where `J-2` belongs.

Fix: `tracePart` in `src/trace/trace.js`; `commitTwo` runs each request as its own part of the handling.

Behaviour change: in a two-request flow the shared lines (the first message, its understanding, the "हाँ") now carry no reference, so they appear in neither order's filtered timeline. Before, they went to the first order. Single requests are unchanged.

## Same dead end elsewhere

- **Fixed afterwards, same pattern:** `onChallanImage`, a supplier with two booked orders. The photo got `orchestrator.which_job` and was dropped. It is now held as `challan_job` through `orderForPhoto`, shared with the meter photo; each line also names the items, as two orders can share a site and day.
- **Not a dead end, misleading text:** the model path in `proposeStep` (`orchestrator.js`, `pickOrder` with no order, every spec with `states`). `orchestrator.which_job` says "site or day", but only a reference resolves it; sending the step again with a reference works.
- **Fine:** exact `बिल` with two jobs answers `reply.which_order`, and `J-2 बिल` works. `onSiteChallanImage` and payments already ask with references.

## Known limits

- A `CANCEL` that could not be delivered at first shows cancelled here and is retried. If the other side then refuses it (the operator's meter photo came in between), this side goes back to booked and nobody is told: `retryPending` has no notice for a refusal.
- A cancel notice missed because a person's 24-hour window was closed is not sent again: `waiting()` rebuilds open requests only, and a cancelled order is not one.
- `web/sample` has no cancelled order; the judge page's handling is covered by `test/ledger/cancel-states.test.js` only. The page was not opened.
- The Hindi is drafted, not polished.
