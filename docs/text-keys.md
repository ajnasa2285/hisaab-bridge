# Text keys used by the agents

Claude adds a key here when code starts using it; Fable writes the Hindi in `src/i18n/hi.js`. Parameters arrive already formatted by `src/i18n/format.js` (`₹7,320`, `6.1`, `50`); missing values arrive as `—`. `ref` is the order's short reference on that agent's side (`J-1` JCB, `P-1` material; `src/ledger/refs.js`).

## Common (both agents)

| Key | Params | When |
|---|---|---|
| `common.unknown_step` | — | the request did not match any step |
| `common.not_allowed` | — | this person's role may not take this step |
| `common.bad_args` | — | a value is missing or not understood |
| `common.no_such_order` | — | no such job/order |
| `common.wrong_state` | — | the step does not fit where the job is now |
| `common.pending` | — | saved on our side; the other side is not reachable, will be sent again automatically |
| `common.refused` | — | the other side's agent refused it |
| `common.busy` | — | an earlier message on this job is still waiting to reach the other side; try after it goes |
| `wa.unknown_sender` | — | someone not registered wrote to the number |

## JCB side (owner `jcb_owner`, operator)

| Key | Params | When |
|---|---|---|
| `jcb.booking_request` | ref, site, day, time, hours | to owner: a contractor asks for the JCB |
| `jcb.rate_needed` | — | to owner: "yes" needs the hourly rate |
| `jcb.day_needed` | — | to owner: "another time" needs a day |
| `jcb.reply_sent_yes` / `_no` / `_other_time` | — | to owner: the answer went to the contractor |
| `jcb.job_booked` | ref, site, day, time | to operator: a job is booked |
| `jcb.meter_start_saved` | reading | to operator: start reading saved |
| `jcb.meter_end_saved` | reading, hours | to operator: end reading saved, hours worked |
| `jcb.start_first` | — | to operator: send the start photo first |
| `jcb.end_not_after_start` | start | to operator: the end reading must be more than the start |
| `jcb.meter_done` | hours | to owner: the job's hours are in |
| `jcb.readings_missing` | — | to owner: no bill without both meter readings |
| `jcb.bill_sent` | hours, rate, total | to owner: bill sent with photos |
| `jcb.bill_accepted` | ref, site | to owner: the contractor accepted the bill |
| `jcb.bill_disputed` | ref, site, their, reason | to owner: the contractor disputes; their figure and reason |
| `jcb.correction_sent` | hours, total | to owner: corrected bill sent |
| `jcb.payment_claimed` | ref, site, amount, utr, day | to owner: the contractor says they paid; please check your account |
| `jcb.settled_sent` | amount | to owner: you confirmed receipt; the job is settled |

## Contractor side (contractor, supervisor)

| Key | Params | When |
|---|---|---|
| `site.jcb_requested` | ref, site, day, time | JCB request sent |
| `site.booking_yes` / `_no` / `_other_time` | ref, site, day, time, rate | the JCB owner's answer |
| `site.bill_received` | ref, site, hours, rate, total, photos | a bill arrived (with this many meter photos) |
| `site.correction_received` | ref, site, hours, rate, total, photos | a corrected bill arrived |
| `site.bill_accepted` | ref, site | you accepted the bill |
| `site.bill_disputed` | ref, site | your objection was sent |
| `site.reason_needed` | — | an objection needs a reason |
| `site.figure_needed` | — | an objection needs your figure (hours or amount) |
| `site.payment_claimed` | amount | the payment details were sent to the JCB owner |
| `site.settled` | ref, site, amount | the JCB owner confirmed the money arrived |

## Read-back and conversation (Claude drafted the Hindi; Fable to polish)

Every committing step is read back and runs only after "हाँ". Days arrive formatted ("29 अक्टूबर 2026").

| Key | Params | When |
|---|---|---|
| `step.reply_booking_yes` / `_no` / `_other_time` | site, day, time, rate | owner: confirm the answer before it goes |
| `step.record_meter_start` / `_end` | reading | operator: confirm the reading read from the photo (or typed) |
| `step.send_bill` | site, hours, rate, total | owner: confirm the bill |
| `step.send_correction` | site, hours, total | owner: confirm the corrected bill |
| `step.confirm_payment` | site, amount | owner: has the money arrived? (also the meaning of "हाँ" after `jcb.payment_claimed`) |
| `step.request_jcb` | site, day, time, hours | contractor/supervisor: confirm the JCB request |
| `step.accept_bill` | site, total | contractor: confirm acceptance (also the meaning of "हाँ" after `site.bill_received`) |
| `step.dispute_bill` | site, their, reason | contractor: confirm the objection |
| `step.claim_payment` | site, amount, utr | contractor: confirm the payment details |
| `step.cancelled` | — | the person said no; nothing was sent |
| `orchestrator.try_again` | — | the model could not be reached; try again shortly |
| `orchestrator.which_job` | — | more than one job fits; ask for the site or day |
| `voice.not_understood` | — | a voice note could not be converted or transcribed |
| `orchestrator.no_job_for_photo` | — | a meter photo came but no job is booked or working |
| `help.<role>`, `meter.not_meter`, `meter.ask_person` (raw), `payment.read` (amount, utr, day, status), `payment.retake`, `payment.not_upi`, `payment.amount_differs` (seen, total), `payment.status.*` | | Fable's existing keys, used as written (UPI screenshot flow) |

## Site office: approvals with limits, references, exact commands (docs/BUILD2.md 3 and 4; Claude drafted the Hindi)

Commands are parsed by code before the model (`src/agents/office.js`, `parseCommand`): `status <ref>` (स्टेटस, स्थिति, हालत), `pending` (बाक़ी, बाकी, पेंडिंग, लंबित), `stock [item]` (स्टॉक), `ok <ref> [note]` (OK, ओके, हाँ, मंज़ूर), `no <ref> <reason>` (नहीं, ना, नामंज़ूर). Texts show the Devanagari forms; "OK" stays Latin.

| Key | Params | When |
|---|---|---|
| `office.held` | ref | to the supervisor: the step waits for the contractor's approval |
| `office.approval_needed` | ref, by, estimate, step | to every contractor: who asks, the estimate, the read-back (without "हाँ / नहीं"), and the reply forms |
| `office.approved` / `office.approved_note` | ref, by (, note) | to the supervisor: who approved (then the step's own result) |
| `office.declined` | ref, by, reason | to the supervisor: who declined and why |
| `office.you_declined` | ref | to the contractor: the "no" is recorded |
| `office.already_decided` | ref, decision, by | a second ok/no: already decided, by whom (`office.decision.ok` / `.no`) |
| `office.only_contractor` | — | a supervisor sent ok/no |
| `office.own_entry` | — | nobody decides on their own entry |
| `office.no_such_ref` | ref | no order or held step with this reference |
| `office.reason_needed` | ref | "no" without a reason |
| `office.status` | ref, what, site, day, state, rate, bill, paid, awaited | `status <ref>` for an order (`what`: `office.what_jcb` hours / `office.what_material` items / `kind.jcb`; `state`: `state.*`; `awaited`: `office.await.buyer.*` on the contractor's agent, `office.await.seller.*` on the others) |
| `office.status_held` | ref, step, estimate, decision | `status <ref>` for a held step (`office.held_waiting`, `office.held_ok` by, `office.held_no` by, reason) |
| `office.pending` | lines | `pending`: `office.pending_held` (ref, step, by) and `office.pending_order` (ref, what, site, awaited) lines; `office.pending_none` when empty |
| `office.stock` | lines | `stock [item]` on the contractor's agent: `office.stock_site` (site), `office.stock_line` (name, qty), `office.stock_line_differs` (name, qty, challan); `office.stock_none` when empty |
| `office.stock_not_here` | — | `stock` on another agent |
| `help.contractor`, `help.supervisor`, `help.jcb_owner` | — | each now ends with the commands that role can use |
