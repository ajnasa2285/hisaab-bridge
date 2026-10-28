# Build 2: supplier, approvals, references (27 Oct 2026)

The contractor agent grows from "book a JCB" to a site office: material from a supplier agent over
A2A, approvals with limits, and short references with exact commands. Everything here is new code;
the interfaces in `docs/CONTRACTS.md` (3.3 challan reader, 8 contractor features) stay the anchor.

Hackathon rules still apply to every line: only Meta models at runtime (`test/rules/meta-only.test.js`),
no real names, phones or data in the repository, no payment reminders, no code from outside this
repository.

## 1. Three agents

| Agent | Id (default) | Ledger | People (role) | WhatsApp line |
|---|---|---|---|---|
| JCB | `agent:jcb-1` | `jcb.db` | `jcb_owner`, `operator` | `jcb` |
| Contractor (site) | `agent:contractor-1` | `contractor.db` | `contractor`, `supervisor` | `site` |
| Supplier | `agent:supplier-1` | `supplier.db` | `supplier` | `jcb` (shared) |

A WhatsApp line is only transport: `people.json` maps each phone on a line to an agent and role, so
the supplier's people use the JCB owner's number (the "service providers' line"). A phone may appear
once per line. `people.json` accepts `agent: 'supplier'`. The contractor agent has two peers (JCB and
supplier); the JCB and supplier agents each have one (the contractor). `HB_SUPPLIER_AGENT_ID` is
optional; its key is `keys/supplier.pem`, made once like the others.

## 2. Material over A2A (the protocol already carries it)

```
contractor/supervisor   request_material   BOOKING_REQUEST {kind:'material', site, day, time?, items:[{name, qtyHundredths, unit}]}
supplier                reply_order        BOOKING_REPLY   {answer:'yes', rates:[{name, unit, ratePaise}]} | no | other_time
supplier (challan photo) record_delivery   DELIVERY        {items (as delivered), challan:{sha256, number?}, deliveredAt}
supervisor              confirm_count      local NOTE      {kind:'site_count', items:[{name, qtyHundredths, unit}], challan?:{sha256, number}}  (contractor ledger only)
supplier                send_bill          BILL            lines = delivered qty x agreed rate, evidence = [{kind:'challan', ...}]
contractor              accept / dispute   ACCEPT | DISPUTE {theirFigure:{qtyHundredths} | {totalPaise}}
supplier                send_correction    CORRECTION
contractor              claim_payment      PAYMENT_CLAIM (UPI screenshot, unchanged)
supplier                confirm_payment    SETTLED
```

* `BOOKING_REPLY.rates` (new, optional in the schema): required when a material order is answered
  `yes`; one entry per requested item, `ratePaise` per `unit`. A JCB reply keeps `ratePaise`.
* A material BILL may carry challan evidence; the bill's lines must equal the signed DELIVERY's
  items times the agreed rates (the supplier's code builds it; the contractor's code checks it
  before telling anyone, and a mismatch is told to the contractor, never silently accepted).
* When a DELIVERY arrives the supervisor is asked for the site's own count. If the site's count
  differs from the challan, the contractor is told both figures and the dispute tool is offered with
  the site's figure. Code compares; the model never decides a quantity.
* The challan photo is read by `readChallan` (CONTRACTS 3.3) on the supplier side, read back, and
  confirmed or typed by the supplier, exactly like a meter photo. Its sha256 is evidence.

### 2a. The site's own challan photo

A challan comes in two copies: the site keeps one, the other goes back to the supplier signed. The
supervisor (or the contractor) photographs the site's copy on the contractor agent; that is the
site's record of what arrived, with the photo as evidence.

* The photo is for a material order (`P-n`) of this contractor agent that is `booked` or
  `delivered` and not yet counted at site. None: the person is told how to make an order, nothing is
  read or recorded. Several: the photo is read once and the person is asked which reference (reply
  `P-n`). A contractor's photo is the site challan when an order waits for a count and no bill waits
  for payment; when both could be, it is read as a UPI screenshot first and as a challan if it is not one (read
  before any "which order?" about payments, so a challan photo never gets that question).
* `readChallan` reads it; code maps what was read onto the order's items (`challanQuantities`). Read
  back with the reference, challan number and items (`step.site_challan`); "हाँ" or the right figures
  in order. An unclear read or a missing quantity asks the person to type them; nothing is filled in.
* Recorded through `confirm_count` with `challan: {sha256, number}`: the local `NOTE {kind:
  'site_count', items, challan}` on the contractor ledger only (items at 0 left out). A bare "हाँ"
  never overwrites a count already recorded; typed figures may, and the contractor sees old and new.
* Code compares with the supplier's signed DELIVERY whenever both exist (at the "हाँ" if the DELIVERY
  is there, else when it arrives, and then nobody is asked for a count again): quantity per item by
  name and unit, and the challan numbers when both are known. A difference is told with both figures;
  the dispute (with the site's figure) is offered when the bill comes, which is checked against the
  site's count as before.
* `readChallan` accepts a handwritten d/m/yy or dd/mm/yy as 20yy, Indian day/month order, only when
  day and month are valid.

## 3. Approvals with limits (contractor agent, local)

* Limits (rupees, optional): `HB_LIMIT_PROCUREMENT_RUPEES` (material and JCB requests),
  `HB_LIMIT_PAYMENT_RUPEES` (payment claims). Kept as integer paise.
* A committing step taken by a `supervisor` whose estimated value is above the limit, or whose value
  cannot be estimated, or when no limit is set, is held instead of sent: it gets a reference, the
  supervisor is told only that approval was requested, and every `contractor` gets one message with
  the step and the exact reply forms. The contractor's own steps are never held (nobody approves
  their own entry; the contractor is the top of this firm).
* Estimate: material = qty x the last rate agreed with that supplier for that item and unit (from the
  ledger); JCB = hours x the last agreed JCB rate. Unknown rate or hours = cannot estimate.
* `ok <ref> [note]` runs the held step exactly as it was read back (same args, the supervisor as the
  requester on record); `no <ref> <reason>` declines it. Decided once: a second `ok` changes nothing
  and says so. The supervisor is told who decided.
* Held steps and decisions are stored append-only (decided set-once), and survive a restart.

## 4. References and exact commands

* Each agent gives each order a short reference on its own side, stable for ever: `J-n` for a JCB
  order, `P-n` for a material order, numbered per agent in order of creation. A held step uses the
  reference its order will have. References replace the orchestrator's `#n`.
* Commands are parsed by code before the model, in Latin or Devanagari forms where natural:
  `status <ref>`, `pending`, `stock [item]` (contractor: received per item per site, from signed
  deliveries and the site's own counts), `ok <ref> [note]`, `no <ref> <reason>`, `help` / `मदद`.
  Anything else goes to the model as now. Role limits are code: only a contractor decides.
* Every text that names an order shows its reference.

## 5. Who builds what (branches from main d7e5f43)

| Branch | Worktree | Scope |
|---|---|---|
| `claude/supplier` | `hb-sup` | supplier agent, material tools on the contractor, BOOKING_REPLY rates, 3-agent wiring (app/main), challan step in the conversation, texts (draft) |
| `claude/office` | `hb-office` | references, commands, approvals with limits, orchestrator refs |
| `claude/challan` | `hb-challan` | `readChallan` (Muse Spark, strict schema, tests with a stand-in), eval support for challans |

Claude (lead) merges in the order challan -> supplier -> office and resolves the seams.

## Explanations

`src/agents/explain-facts.js` snapshots one agent's own ledger: the bill in force and corrections,
meter evidence and code-computed hours, signed delivery, the local site count and its photo
provenance, and attributed dispute figures/reasons. Refused outgoing messages do not count.
Human display values authorize numbers; stored paise/tenths, fingerprints, message IDs and numbers
inside free-text reasons do not. Capture times remain unknown when absent; recorded times are
separate and displayed in IST. Material totals use the existing integer rounding rules.

`explainDifference({spark, facts, audience})` requests strict JSON from injected Muse Spark. It
accepts only short Hindi prose with supported complete numeric tokens (including normalized
Devanagari digits, grouping, money and hour units). References, dates and times are indivisible;
their digits cannot authorize quantities. Unknown numbers, malformed responses, tool calls,
common directives/blame/payment/causal language, errors and timeouts discard the entire prose.
The number check proves numeric support, not every semantic claim in free text; the prompt and
conservative language checks also restrict the explanation to neutral descriptions of evidence.
Accepted prose uses `explain.wrapper`; otherwise `explain.unavailable` contains the same plain
figures assembled by code. Requests have a 30-second attempt timeout and a 95-second total bound
(including the existing client's retries). The existing discrepancy notice is sent before waiting.

The sellers explain after their existing DISPUTE notice; the contractor explains after a material
bill/count or bill/rate mismatch notice. There is no JCB buyer count-mismatch hook in this build.
`app.js` passes its existing Spark injection to these agents; the runtime client remains
`src/meta/client.js`. Explanations carry no confirmation expectation, tool, ledger entry or state
change. Full tests and typecheck remain the lead's AWS checks, per the explanation brief.
