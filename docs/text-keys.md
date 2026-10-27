# Text keys used by the agents

Claude adds a key here when code starts using it; Fable writes the Hindi in `src/i18n/hi.js`. Parameters arrive already formatted by `src/i18n/format.js` (`₹7,320`, `6.1`, `50`); missing values arrive as `—`.

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
| `wa.unknown_sender` | — | someone not registered wrote to the number |

## JCB side (owner `jcb_owner`, operator)

| Key | Params | When |
|---|---|---|
| `jcb.booking_request` | site, day, time, hours | to owner: a contractor asks for the JCB |
| `jcb.rate_needed` | — | to owner: "yes" needs the hourly rate |
| `jcb.day_needed` | — | to owner: "another time" needs a day |
| `jcb.reply_sent_yes` / `_no` / `_other_time` | — | to owner: the answer went to the contractor |
| `jcb.job_booked` | site, day, time | to operator: a job is booked |
| `jcb.meter_start_saved` | reading | to operator: start reading saved |
| `jcb.meter_end_saved` | reading, hours | to operator: end reading saved, hours worked |
| `jcb.start_first` | — | to operator: send the start photo first |
| `jcb.end_not_after_start` | start | to operator: the end reading must be more than the start |
| `jcb.meter_done` | hours | to owner: the job's hours are in |
| `jcb.readings_missing` | — | to owner: no bill without both meter readings |
| `jcb.bill_sent` | hours, rate, total | to owner: bill sent with photos |
| `jcb.bill_accepted` | site | to owner: the contractor accepted the bill |
| `jcb.bill_disputed` | site, their, reason | to owner: the contractor disputes; their figure and reason |
| `jcb.correction_sent` | hours, total | to owner: corrected bill sent |
| `jcb.payment_claimed` | site, amount, utr, day | to owner: the contractor says they paid; please check your account |
| `jcb.settled_sent` | amount | to owner: you confirmed receipt; the job is settled |

## Contractor side (contractor, supervisor)

| Key | Params | When |
|---|---|---|
| `site.jcb_requested` | site, day, time | JCB request sent |
| `site.booking_yes` / `_no` / `_other_time` | site, day, time, rate | the JCB owner's answer |
| `site.bill_received` | site, hours, rate, total, photos | a bill arrived (with this many meter photos) |
| `site.correction_received` | site, hours, rate, total, photos | a corrected bill arrived |
| `site.bill_accepted` | site | you accepted the bill |
| `site.bill_disputed` | site | your objection was sent |
| `site.reason_needed` | — | an objection needs a reason |
| `site.figure_needed` | — | an objection needs your figure (hours or amount) |
| `site.payment_claimed` | amount | the payment details were sent to the JCB owner |
| `site.settled` | site, amount | the JCB owner confirmed the money arrived |
