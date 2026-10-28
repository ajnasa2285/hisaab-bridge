# Text keys used by the agents

Claude adds a key here when code starts using it; Fable writes the Hindi in `src/i18n/hi.js`. Parameters arrive already formatted by `src/i18n/format.js` (`₹7,320`, `6.1`, `50`); missing values arrive as `—`. `ref` is the order's short reference on that agent's side (`J-1` JCB, `P-1` material; `src/ledger/refs.js`).

## Common (both agents)

| Key | Params | When |
|---|---|---|
| `common.unknown_step` | — | the request did not match any step |
| `common.not_allowed` | — | this person's role may not take this step |
| `common.bad_args` | — | the message cannot be used even with a question (no item name, a time that is no time); says what to send, with examples that work |
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

## Material (Build 2; Claude drafted the Hindi, Fable to polish)

Items arrive formatted as `सीमेंट 50 बोरी, रेत 2 ट्रॉली`, rates as `सीमेंट ₹350/बोरी`, bill lines as `सीमेंट 50 बोरी × ₹350 = ₹17,500` (joined by commas). Every order notice carries `ref` (`P-n` on that agent's side). A line's amount is qty × rate / 100 rounded to the nearest paisa, half a paisa up (`lineAmountPaise`, `src/agents/material.js`). For a material order the contractor side uses the `site.material_*` twin of a JCB key (`keyFor` in `src/agents/contractor.js`).

Contractor side (contractor, supervisor):

| Key | Params | When |
|---|---|---|
| `site.no_supplier` | — | no supplier agent is configured |
| `site.material_requested` | ref, site, day, items | material request sent to the supplier |
| `site.material_booking_yes` / `_no` / `_other_time` | ref, site, day, time, rates | the supplier's answer, with the rate per item on a yes |
| `site.delivery_received` | ref, site, items, challan | a DELIVERY arrived: what the challan says; asks for the site's count ("हाँ" = same as the challan, or figures in order). The first count recorded closes everyone else's question |
| `site.count_figures` | items | the count needs one figure per delivered item, in order |
| `site.count_matches` | ref, site, items | the site's count is saved and equals the challan |
| `site.count_saved_differs` | ref, site, challan, count | to the person who counted: saved, differs from the challan |
| `site.count_differs` | ref, site, challan, count | to the contractor: the site's count differs from the challan (both figures) |
| `site.count_already` | ref, count | a one-word "हाँ" to the delivery notice after a count is already recorded: nothing changes (type figures to change it) |
| `site.count_changed` | ref, site, old, count, challan | a recorded count changed by typed figures; to the person and to the contractor (old and new) |
| `site.challan_no_order` | — | the site sent a challan photo but no material order is booked/delivered and still uncounted; nothing recorded; how to make an order (Claude drafted, Fable to polish) |
| `site.challan_which_order` | lines | several orders could be this challan's: which reference? one `site.challan_order_line` (ref, site, what) per order, with the exact reply `"P-n"` (Claude drafted, Fable to polish) |
| `site.challan_ask_person` | ref, raw, names | the site's challan was not read clearly: type the quantities in the order's order (`names` = `बालू (cft), गिट्टी (brass)`), 0 for what did not come (Claude drafted, Fable to polish) |
| `site.challan_figures` | ref, names | typed figures do not fit the order: one per ordered item, in order (Claude drafted, Fable to polish) |
| `site.challan_count_saved` | ref, site, items, challan | the site's count from its challan photo is recorded; the supplier's delivery has not come yet (Claude drafted, Fable to polish) |
| `site.challan_count_matches` | ref, site, items, challan | recorded, and it agrees with the supplier's signed delivery (Claude drafted, Fable to polish) |
| `site.challan_count_differs` | ref, site, count, siteNo, challan, challanNo | the site's challan and the supplier's delivery differ (quantities or challan numbers): both figures; a dispute with the site's figure once the bill comes. To the person who counted and the contractor; on a later DELIVERY to contractor and supervisor (Claude drafted, Fable to polish) |
| `site.delivery_matches_count` | ref, site, count, siteNo, challan, challanNo | a DELIVERY arrived for an order the site already counted from its challan, and it agrees; nobody is asked again (Claude drafted, Fable to polish) |
| `site.material_bill_received` | ref, site, lines, total, photos | a material bill that follows from the delivery, the agreed rates and the site's count; "हाँ" accepts |
| `site.material_correction_received` | ref, site, lines, total, photos | a corrected material bill; "हाँ" accepts |
| `site.material_bill_mismatch` | ref, site, lines, total, expected, expectedTotal | to the contractor: the bill does not equal delivered qty × agreed rates (no "हाँ" offered) |
| `site.material_bill_count_differs` | ref, site, lines, total, count, siteTotal | to the contractor: the bill follows the challan but the site counted differently (no "हाँ" offered) |
| `site.material_bill_accepted` / `site.material_bill_disputed` | ref, site | accepted / objection sent to the supplier |
| `site.material_figure_needed` | — | an objection needs your figure (quantity or amount) |
| `site.material_total_only` | — | a quantity objection on a bill with more than one line: only a total is accepted |
| `site.material_payment_claimed` | amount | payment details sent to the supplier |
| `site.material_settled` | ref, site, amount | the supplier confirmed the money arrived |

Supplier side (`supplier`):

| Key | Params | When |
|---|---|---|
| `supplier.order_request` | ref, site, day, time, items | a material order arrived; answer with a rate per item, no, or another day |
| `supplier.rates_needed` | items | "yes" needs one rate per item, in order |
| `supplier.reply_sent_yes` / `_no` / `_other_time` | — | the answer went to the contractor |
| `supplier.item_not_agreed` | item | a delivered item has no agreed rate in this order |
| `supplier.delivery_sent` | ref, site, items | the delivery (with the challan fingerprint) went to the contractor |
| `supplier.delivery_missing` | — | no bill before the delivery is recorded |
| `supplier.bill_sent` | lines, total | bill sent with the challan as evidence |
| `supplier.bill_accepted` | ref, site | the contractor accepted the bill |
| `supplier.bill_disputed` | ref, site, their, reason | the contractor disputes; their figure and reason |
| `supplier.correction_sent` | lines, total | corrected bill sent |
| `supplier.payment_claimed` | ref, site, amount, utr, day | the contractor says they paid; please check your account ("हाँ" = confirm_payment) |
| `supplier.settled_sent` | amount | you confirmed receipt; settled |
| `challan.not_challan` | — | the photo is not a challan |
| `challan.ask_person` | raw, items | the challan was not read clearly: type the quantities in the order's order (`items` = `सीमेंट (बोरी), रेत (ट्रॉली)`) |
| `challan.no_order_for_photo` | — | a challan photo came but no order is booked and waiting for delivery |

Read-backs (each ends with "हाँ / नहीं"):

| Key | Params | When |
|---|---|---|
| `step.reply_order_yes` / `_no` / `_other_time` | site, day, time, rates | supplier: confirm the answer before it goes |
| `step.record_delivery` | site, items, challan | supplier: confirm the quantities read from the challan (or typed) |
| `step.send_material_bill` | site, lines, total | supplier: confirm the bill |
| `step.send_material_correction` | site, lines, total | supplier: confirm the corrected bill |
| `step.request_material` | site, day, time, items | contractor/supervisor: confirm the material request |
| `step.confirm_count` | site, items | supervisor/contractor: confirm the site's count |
| `step.site_challan` | ref, site, challan, items, names | supervisor/contractor: confirm what was read from the photo of the site's challan, or type the right figures in order (Claude drafted, Fable to polish) |
| `step.confirm_payment` | site, amount | (shared with the JCB owner) the supplier confirms the money arrived |

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

Commands are parsed by code before the model (`src/agents/office.js`, `parseCommand`): `status <ref>` (स्टेटस, स्थिति, हालत), `pending` (बाक़ी, बाकी, पेंडिंग, लंबित), `stock [item]` (स्टॉक), `ok <ref> [note]` (OK, ओके, हाँ, मंज़ूर), `no <ref> <reason>` (नहीं, ना, नामंज़ूर). Texts show the Devanagari forms; "OK" stays Latin. A command is answered before an open question is looked at and leaves it open (a challan or count question still takes typed figures afterwards); typed figures are never a command.

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
| `help.contractor`, `help.supervisor`, `help.jcb_owner`, `help.supplier` | — | each now ends with the commands that role can use |

## Explanations (Astra drafted, Fable to polish)

Existing messages are sent first. These are extra display-only notices; none proposes a step.
The model writes only `{explanation}`. All `{figures}` fragments below come from code and one ledger.

| Key | Params | When |
|---|---|---|
| `explain.wrapper` | explanation, figures | accepted neutral model prose plus code's figures (existing text) |
| `explain.unavailable` | figures | unsupported number, unsafe/invalid prose, timeout or model failure (existing text) |
| `explain.unit.hours` / `explain.time.ist` | — | hour unit / explicit timezone label |
| `explain.figures.order` | ref, site | identify this ledger's order |
| `explain.figures.line` | item, quantity, unit, rate, amount | formatted current or historical bill line |
| `explain.figures.bill` | lines, total | bill figures, including corrections |
| `explain.figures.meter` | start, end, hours | bill's meter evidence and integer-computed difference |
| `explain.figures.photoTimes` | start, end | known photo capture times, or em dash when unknown |
| `explain.figures.delivery` | number, items | signed supplier delivery/challan |
| `explain.figures.deliveryAmount` | total | delivery valued at the agreed rates by code |
| `explain.figures.sitePhoto` | number, items, total | local count confirmed from the site's challan photo |
| `explain.figures.siteCount` | items, total | local typed count, without inferring a photo |
| `explain.figures.dispute` / `explain.figures.previousDispute` | figure | attributed objection to the current / previous bill |
| `explain.figures.correction` | before, after | previous and replacement bill figures |

## Asking for what is missing (docs/BUILD2.md section 6; Claude drafted, Fable to polish)

| Key | Params | When |
|---|---|---|
| `ask.missing` | questions | a JCB or material request is complete except some values: the questions below, one per line, and how to cancel |
| `ask.site` | — | no site named, none in people.json, and not exactly one among the open jobs |
| `ask.day` | — | no day said, or one that is not understood |
| `ask.qty` | name, unit | an item's quantity is not said or not exactly a number |
| `ask.qty_unit` | name | an item has neither quantity nor unit |
| `ask.unit` | name, qty | an item's unit is not said |
