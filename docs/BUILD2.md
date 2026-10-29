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
  `P-n`). Whether a contractor's photo is the site challan or a UPI screenshot is decided by its kind
  (section 7), never by which orders are open.
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

`explainDifference({spark, facts, audience})` sends injected Muse Spark a small request: a short
system prompt and a few Hindi lines with only this difference (reader, ref, bill in force, meter or
delivery/site count, the objection to the bill in force with its recorded reason in «», any
correction), a strict schema with a 350-character explanation, no images or tools, and
`reasoning_effort: "minimal"`. Live, that takes 3–6 s (p50 3.75 s, p95 5.6 s, 8/8 accepted; see
`docs/explanation-live-check.md`). Attempts time out at 15 s; 35 s bounds the whole wait including
one client retry. The existing discrepancy notice is sent first and never waits (`app.js` runs
`onApplied` without awaiting it).

The guard rejects the whole text, never edits it, with one check per promise
(`guardViolation` names the rule broken): every number exists in the facts (complete tokens,
normalized digits/grouping/units; references, dates and times are indivisible); no verdict on who
is right; no payment, dues, dates, deadlines or reminders; no directive; no invented cause or
guess. Quoting the other side's recorded reason is allowed: a quote must be a reason recorded on
the bill in force, word for word, and is then set aside as their words (its numbers and wording do
not count as the explanation's own). "कारण" as a noun is accepted only beside such a quote. These
are wording checks, not a semantic proof. Accepted prose uses `explain.wrapper`; otherwise
`explain.unavailable` contains the same plain figures assembled by code.

The sellers explain after their existing DISPUTE notice; the contractor explains after a material
bill/count or bill/rate mismatch notice. There is no JCB buyer count-mismatch hook in this build.
`app.js` passes its existing Spark injection to these agents; the runtime client remains
`src/meta/client.js`. Explanations carry no confirmation expectation, tool, ledger entry or state
change. Full tests and typecheck remain the lead's AWS checks, per the explanation brief.

## Evidence on request (Build 4)

The agents retain confirmed photo bytes in separate private stores under `HB_DATA_DIR`, outside
the repository (5 MiB per image, SHA-256 filename plus MIME). They exchange a signed
`EVIDENCE_REQUEST` and a signed `EVIDENCE` response for one record at a time. The receiver checks
the request, order, parties and its previously recorded hash before storing, showing or reading a
photo. Ledger events retain signed hashes and metadata only. Missing historical bytes return
`not_kept`; they cannot be recovered from a fingerprint.

A site-count difference asks for the supplier's challan; a bill dispute asks for the bill's
challan or meter photos. When that dispute cites the site's photo count, its signed body commits
the count's record ID and hash, letting the seller ask for that site's copy. Each automatic
request occurs once per record, including after restart. `सबूत P-1` or `saboot J-1` asks for the
other party's latest known photo records of that order; the operator cannot use this command.

Verified photos are forwarded within the person's WhatsApp 24-hour window with a code-generated
caption naming the record owner and recorded time: “फ़ोटो वही है जो दर्ज हुई थी”. Upload or image
send failure falls back to the same caption as text. The matching Muse Spark reader then reads
the received photo; a local reading note supplies both sides' attributed figures to
`explainDifference`. Its existing number and wording checks still apply. A new reading never
changes the recorded quantities, a bill, or a person's decision. No reminders or verdicts.

## 6. Intake: ask only for what is missing (28 Oct 2026)

A real test showed a supervisor's plain request ("कल साइट पर सीमेंट 50 बोरी चाहिए", a voice note with
"pachaas", our own help example) answered with `common.bad_args` or help every time: the model wrote
null as the string "null", a quantity in words could not be copied as digits, and a request without a
site name had no way through. Now:

* **Null words.** Every nullable field the model fills counts "", "null", "none", "-" (any case) as
  null (`blank` in `src/orchestrator/units.js`), the job reference too.
* **Number words in code.** The model copies a quantity as written, digits or words; code converts
  (`parseQuantity`): एक/ek … नब्बे/nabbe (the common ones), सौ/sau, हज़ार/hazar, डेढ़/dedh, ढाई/dhai,
  साढ़े/saadhe, सवा/sawa, पौने/paune and combinations ("do sau pachaas", "dhai sau", "2 सौ"). Anything
  not exactly a number is null and is asked, never guessed.
* **The site.** `people.json` may give a person a `site` (a supervisor usually works on one). For
  `request_jcb` and `request_material` the model gives the site as written or null; a generic word
  ("साइट", "site", "साइड", "side", "yahan", "यहाँ") and the little words around a name ("pe", "पर") are
  not a name. No name: the person's `site`; else the only site among the agent's open jobs; else asked.
  A name matching a known site whatever its case becomes that site.
* **Ask, keep the rest.** A request complete except site, day, a quantity or a unit is kept as a
  pending question (`fill`, 30 minutes like the others) and one message asks only for what is missing
  (`ask.*`). The reply is read by code when one value is asked and the reply is plainly that value
  (a site name, आज/कल/परसों/30-10, a quantity with or without its unit, a unit); otherwise Muse Spark
  reads it with the first message and the step so far as context, and only the missing values are taken
  from it. Then the usual read-back and "हाँ". "नहीं" cancels; "मदद" or a reply that fills nothing ends
  the question and is read as a new message; a model outage keeps the question open.
* `common.bad_args` is kept for messages that cannot be used even with a question; its text shows
  examples that work. Every request example in `help.*` and `common.bad_args` is run through the real
  parsing path in `test/orchestrator/intake.test.js`; "माँगें" and "हिसाब", which no command answered,
  are gone from the help texts.

## 7. Any photo, any time (28 Oct 2026)

Real people send any photo at any time, so the kind of a photo is no longer taken from the sender's
role. Every agent gets `classifyPhoto` (CONTRACTS 3.4); `onImage` in `src/agents/conversation.js`:

* **Who may send what, on this agent** (`photoKinds`, from the tools' roles): `meter` for the
  operator and JCB owner (JCB agent, `record_meter`); `upi` for the contractor (contractor agent,
  `claim_payment`); `challan` for the supplier (supplier agent, `record_delivery`) and for the
  supervisor or contractor (contractor agent, the site's own copy, `confirm_count`). A person who may
  send none gets `photo.none` and the photo is not classified.
* **One classification, then one reader.** Muse Spark says `meter`, `upi`, `challan` or `other`
  with `clear`. A clear kind the person may send goes to that kind's flow, whose reader reads the photo
  once and keeps its own `not_*` check as a second safety. A clear kind they may not send: who sends it
  (`photo.sent_by_*`), with what they can send; `other` (or a file that is not an image): what they can
  send (`photo.other`). Nothing is read or recorded in these cases.
* **Unsure → ask once.** `photo.ask_kind` with the exact forms for this person's kinds ("मीटर",
  "UPI", "चालान"). The photo is kept in memory until record confirmation as a pending question with the
  usual 30-minute expiry. The answer routes it as if Muse Spark had said that kind (still checked
  against the role); a cancel word cancels; any other text lapses the question, photo too, and is read
  as a new message.
* **Failure.** A classifier error or timeout is `orchestrator.try_again`; nothing is read or kept.
* **A photo while another question is open** starts its own flow and the old question lapses, as it
  does for a new text: the photo is the newest thing the person said, and an older read-back must not
  be confirmed by a "हाँ" meant for the new photo.
* The old workaround (a contractor's photo read as UPI first, then as a challan) is gone: a challan
  photo is never offered to the UPI reader, and a UPI screenshot asks "which order?" before any read.

## 8. Ask anything (29 Oct 2026)

A person asks about their own records in Hindi or Hinglish ("इस महीने शिवपुरी पर कितना सीमेंट आया?",
"JCB के कितने घंटे का बिल बाक़ी है?", "पिछले हफ़्ते किसको कितना भुगतान किया?") and gets a short answer.
Muse Spark plans and phrases; code produces every figure (`src/agents/ask.js`).

* **Route.** Exact commands are parsed by code first, as before. The router (`proposeStep`, with
  `ask: true` from the conversation) also offers `ask_records`: "the person only asks a question about
  their own records; nothing is to be done". Committing steps are unchanged, read back and confirmed.
  A question has no read-back, no "हाँ", no pending question and no ledger entry.
* **Lookups** (read-only, this agent's own ledger only, refused messages left out as in `view`):
  `list_orders` (site, kind, state or `open`, period), `order_detail` (one reference), `totals`
  (material asked / on the challan / received at site / billed with amount; JCB hours asked / billed /
  billed and not settled; money billed / accepted / payment reported / settled / billed and not
  settled; optionally per site or per kind), `payments` (reported UPI payments by the day paid, and
  whether the seller confirmed), `stock` (the contractor agent only, as the `stock` command). The
  model names a period (`today`, `this_week`, `last_month`, …) or copies dates as written; code
  turns them into days (weeks from Monday, IST). Results are display values (`₹7,320`, `6.1 घंटे`,
  `50 बोरी`), never stored integers. Empty words ("null", "-") are null; a made-up choice returns an
  error the model sees, never a guess.
* **Who may ask what** follows the exact commands (`office.js`): everyone may see orders and one
  order (as `status` and `pending`); the contractor, supervisor, JCB owner and supplier also totals
  and payments; `stock` only on the contractor agent; the operator gets only orders and one order.
  The model sees only the lookups allowed; one named anyway is refused by code.
* **The loop.** At most 4 lookups, in sequence (independent ones may come in one round), then
  `answer` (Hindi, at most 400 characters); a fifth round offers only `answer`. `reasoning_effort:
  "low"`, 15 s per attempt, 30 s for the whole question. Live: p50 8.9 s, p95 12.6 s per question
  including the router; 9 of 10 correct and 1 partly (`docs/ask-live-check.md`).
* **Checks** (the answer is rejected whole, never edited): every number exists in the lookups
  (`numbersSupported` from `explain.js`); the explanation wording rules `format`, `verdict`,
  `directive`, `cause` (`wordingViolation`); plus no reminder, chasing or due-date words; no quotes;
  Devanagari; and at least one lookup that worked. "भुगतान" itself is allowed here, since people ask
  about it. A passing answer goes out with the references it came from (`records.answer`). Otherwise
  code's own lines from the last lookup that worked (`records.unavailable`), or `records.no_answer`
  when none did (also on a timeout or outage before any lookup).
