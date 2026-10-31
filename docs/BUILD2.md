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

* Limit (rupees, optional): `HB_LIMIT_PROCUREMENT_RUPEES` (material and JCB requests). Kept as integer
  paise. Payment claims are the contractor's own step, so they have no limit.
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

Since 30 Oct the photo's owner decides first (next section): a request is answered with a receipt,
the owner is asked "हाँ / नहीं", and only a yes sends the photo. The requester is told it waits.

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
  and payments; `stock` only on the contractor agent; the operator gets only orders and one order,
  each as its order, site, day and state, with no rate, bill, balance or payment (nor do `status` and
  `pending` show them), so none of it reaches the model.
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

## Fewer steps (30 Oct 2026)

A live test on 29 Oct (supervisor orders cement → contractor OK → supplier "हाँ 380") had too many
steps: the supplier's exact "हाँ 380" was read back and needed a second "हाँ". Every record already has
a second person checking it downstream, so a read-back that only asks the same sender to repeat "हाँ"
is dropped. The model proposes, code checks, people decide; a person's own exact reply is their
decision. The ledger, protocol, message types, state machine, approvals and limits are unchanged.

**Removed confirmations, and the check that covers each:**

| Was read back | Now | Downstream check |
|---|---|---|
| Supplier's "हाँ 350 4000" / "नहीं" / a day; JCB owner's "हाँ 1200" / "नहीं" / a day | sent at once, one receipt with the figures | the contractor sees the answer and the rates; nothing is billed without a delivery or meter readings |
| "बिल" from the JCB owner or supplier | sent at once (receipt shows the bill's figures) | the contractor accepts or disputes the bill |
| Contractor's "नहीं <figure> <reason>" to a bill | dispute sent at once | the seller answers with a correction or keeps the bill |
| Supervisor's request that goes for approval | no read-back; one message "P-n ठेकेदार की मंज़ूरी के लिए भेजी: …" | the contractor's OK (the approval notice shows the same statement) |
| Clear meter photo (end above start) | recorded with a receipt | the bill carries both meter photos; the contractor accepts or disputes |
| Clear supplier challan photo, every item read | DELIVERY signed and sent with a receipt | the site's own count is compared with it |
| Clear site challan photo that agrees with the supplier's delivery (or no delivery yet) | site count recorded with a receipt | code compares with the delivery when it comes; the bill is checked against the count |
| Clear UPI screenshot, successful, for the bill's amount | payment claim sent with a receipt | only the seller's own "हाँ, आ गया" settles it |
| Figures or meter digits the person typed | recorded at once | as for the photo they replace |

**Confirmations that stay:** free words understood by the model (a request, or an answer that is not
exact) are read back once; the contractor's own requests, and a supervisor's within the limit (nobody
else checks before they reach the seller); a photo that is unclear, misses a figure, or that code finds
inconsistent (meter end not above start; site challan different from the supplier's delivery in a
quantity or the challan number; UPI amount different from the bill) is read back or typed, and the
existing difference message follows on "हाँ"; "यह फ़ोटो क्या है?" only when the kind is unsure; the
exact commands as before.

**Exact replies** are parsed by code before the model (`src/agents/replies.js`) against this agent's
open orders: the seller's yes with one rate per item, in order (a wrong count asks only for the rates;
a bare "हाँ" asks for them, or confirms a reported payment when that is the only thing waiting), "नहीं",
a day (with an optional time), "बिल"; the contractor's "नहीं <figure> <reason>" to a bill (hours on a JCB
bill, a quantity on a one-line material bill, or rupees with ₹/रुपये; no reason asks only for it). A
reference in front or behind picks the order; several fitting orders and none named asks which
(`reply.which_order`). Anything else goes to the model as before.

**Short yes and no** (`yesNo`): at most 4 words, only yes words (or only no words) and the little words
beside them ("जी", "है", "भेज दो", "अभी", "चाहिए", "आ गया"), no digits, never both; the punctuation a
voice transcript adds (", । ? !") is stripped. "हाँ जी", "जी हाँ", "ok bhej do", "ठीक है भेजो",
"नहीं चाहिए", "nahi abhi nahi" count; "हाँ 50 बोरी", "हाँ नहीं" and "हाँ सीमेंट कल भेजो" do not.

**No "—" placeholders:** a time, hours, an estimate or a challan number that was not given is left out
of the sentence by a variant key (`variant()`, `docs/text-keys.md`); a seller's answer without a day
shows the day the order asked for.

## 9. Signed copy and payment time (29 Oct 2026)

**The site's signed copy goes back to the supplier.** A supplier's challan comes in two copies: the
site keeps one and signs the other, which goes back to the supplier as proof of receipt. When the
site's count is recorded from the photo of its copy (section 2a), the contractor's agent now also
tells the supplier's agent, signed:

* A new message `SITE_RECEIPT` (contractor → supplier; CONTRACTS section 4). Not `RECEIPT`, which is
  the transport's acknowledgement of every message. Body: `delivery` (the DELIVERY's msg_id),
  `challan: {sha256, number}` (the site's photo), `items` (what the site wrote it received) and
  `signed`. It never changes the order's state and fits a material order from `delivered` on.
* `signed` comes from Muse Spark's challan reader, which now also reports a receiver's mark
  (`signature: visible|absent|unclear` → `true|false|null`). A printed name or the supplier's stamp is
  not a signature. It never makes a reading unclear, since the figures do not depend on it.
* When: at the "हाँ" (or typed figures) if the DELIVERY is already there, else as soon as the DELIVERY
  arrives. Only a count from a challan photo; a typed count without a photo is not the signed copy. A
  changed count sends a new receipt; the latest is the one shown. Not delivered → pending, sent again
  with the other pending messages.
* The supplier's code checks it against its own DELIVERY: the challan number (`sameChallanNo`:
  ignoring case, spaces and leading zeros) and every item by name and unit (`countDifferences`), and
  tells the supplier: "P-1: साइट ने चालान 96 पर सीमेंट 48 बोरी प्राप्त लिखी (आपके चालान पर सीमेंट 50
  बोरी)। साइट की प्रति पर दस्तख़त नहीं दिखे।", or "… प्राप्त लिखी, मिलान ठीक।" when equal. A different
  number is shown with both numbers, never accepted silently; a number missing on either side is said
  so. No verdict, no reminder, nothing asked.
* `स्थिति P-1` on the supplier's agent adds one line ("साइट की प्रति: चालान 96 पर सीमेंट 48 बोरी प्राप्त
  लिखी, दस्तख़त हैं"), and ask-anything's `order_detail` carries `site_signed_copy` (received, challan
  number, signed). The contractor's agent's status is unchanged.

**The payment's time.** The payer's agent tells the receiver the date, the time when visible, the
amount and the UTR.

* `PAYMENT_CLAIM.paidAt` (optional): the clock printed on the UPI receipt as `HH:MM` on 24 hours. The
  UPI reader's new `clock` gives it ("2:05 PM" → `14:05`; an hour 1–12 without AM/PM is ambiguous →
  `null`). It is sent only when visible; an old claim without it stays valid.
* The JCB owner or supplier sees "… का भुगतान 23 अक्टूबर 2026 को 14:05 बजे किया, UTR …"; the payer's
  receipt is "₹35,000, 23 अक्टूबर 2026, 14:05 बजे, UTR …". Without a time the phrase is left out, never
  shown as "—".
* Ask-anything: `payments` rows carry `paid_at` when present, and `order_detail`'s
  `payment_reported` includes it; the time is an allowed figure for the answer check.

## Photo guards and owner consent (30 Oct 2026)

Live on 29 Oct the operator sent a clear start photo of one JCB (2061.7) and, as the end photo,
forwarded an old photo of a different JCB (a plain LCD showing 6799.9 and "26 OCT"). Muse Spark read
both correctly; code accepted end > start and a 4,738-hour bill reached the contractor. The lead added
the 24-hour limit (`MAX_JOB_TENTHS`) and the 12-hour read-back. The owner's rule: a wrong photo is
rejected at the start, or every later step between agents needs corrections from every person. The
same day the JCB agent sent its owner's meter photos to the contractor without asking.

**A meter photo is checked before anything is recorded** (`onMeterImage`, `src/agents/meter-guard.js`):

| Check | By | Result |
|---|---|---|
| Forwarded (WhatsApp's `context.forwarded` / `frequently_forwarded`, carried by the webhook as `image.forwarded`) | code | refused before it is read: "मीटर की फ़ोटो अभी खींचकर भेजें, फ़ॉरवर्ड की हुई फ़ोटो नहीं चलेगी।" Challan photos are not checked: a supplier's staff often forward them |
| Same machine as the other reading's photo (the end against the start, a start against an end) | Muse Spark `sameMeter`, one call with both images, run alongside the reading | `no` refused, naming what differs (display, make, layout); `unsure` read back once, "हाँ" records it; `yes` goes on. Model error or timeout: handled as before, said in the log only, work never blocked. No kept photo of the other reading: no comparison |
| Date on the display (meter reader's new `displayDate`, as printed) | code parses "26 OCT", "26/10/2026", "2026-10-26", "OCT 26"; no year = the nearest | refused unless the job's day, the day before (a night shift), today or yesterday in IST (a job worked later than booked). A numeric date that reads both ways is refused only when neither reading fits. Unparseable or absent: ignored |
| 24 hours between readings / more than 12 hours | code (unchanged) | refused / read back once |

A refused photo records nothing and leaves no question open; the person sends a fresh photo of the
same JCB's meter (or types the digits where the existing flow asks for them).

**The owner decides before their photo is shared** (`src/agents/evidence.js`, CONTRACTS section 4):

* A received `EVIDENCE_REQUEST` (automatic on a dispute or count difference, or `सबूत <ref>`) is
  recorded and answered with a receipt. The record owner's agent asks its owner once per order:
  "J-1: ठेकेदार मीटर की फ़ोटो माँग रहे हैं (बिल पर आपत्ति)। भेजें? हाँ / नहीं". JCB photos: the JCB owner;
  challans: the supplier; the site's copy of a challan: the contractor. A second request on the same
  order while the question is open is covered by it (same kind of photo) or asks again naming all.
* "हाँ" (any short yes) sends every open request's photo as a signed `EVIDENCE`, hash-checked as
  before. "नहीं" sends a signed `REFUSE` with `declined_by_owner`; the requester is told
  "J-1: JCB मालिक ने फ़ोटो भेजने से मना किया।" once. No reason asked, no reminder.
* The requester is told at once that it waits for the other side's owner. No answer within the
  question's 30 minutes: nothing is sent. A later `सबूत` asks again.
* Each decision is a local `NOTE evidence_consent` before anything leaves; the protocol refuses an
  `EVIDENCE` without a yes. The `no` of a yes/no question can now be a step too (`expect.no`).

Live check of `sameMeter` (30 Oct, invented drawn images, `muse-spark-1.3`): 5 of 6 pairs as expected
(same panel moved, tilted and darker: yes; same mechanical counter: yes; LCD against drum counter: no,
display/make/layout; same panel shape with another brand plate: no, make; blurred: unsure). A full
panel against a close-up of a plain LCD came back unsure (twice), so it is read back; in the live
case the display date and the 24-hour rule refuse that photo too. p50 8 s, run alongside the meter
reading. The prompt was not tuned on these images.

## GST on material (30 Oct 2026)

Live on 29 Oct a cement delivery came with a GST tax invoice: 50 bags at ₹380, taxable ₹19,000,
CGST 14% ₹2,660, SGST 14% ₹2,660, grand total ₹24,320. The supplier had answered "हाँ 380", so the
bill would have been ₹19,000 and the UPI payment compared with the wrong amount. Now:

* **The yes may carry GST** (`src/agents/replies.js`, exact, before the model): "हाँ 380 + 28%",
  "हाँ 380 28% gst", "हाँ 350 18%, 4000 5%". A percent belongs to the rate before it; only the slabs
  0, 5, 12, 18, 28, 40 (whole percent); anything else goes to the model route, whose `reply_order`
  has `gst_percents` and is read back. Stored as `rates[i].gstPercent` (optional; old replies = no GST
  known).
* **The invoice tells too** (`challan-v2`): per line `rate`, `taxableValue`, CGST/SGST/IGST rates and
  the document's `grandTotal`, as printed, parsed by code to paise; unclear → null; never quantities,
  never `clear`. A tax summary printed once applies to lines that print no rate. Carried on the
  DELIVERY: items' `gstPercent`, `invoiceRatePaise`, `taxablePaise`, and `grandTotalPaise`.
* **The bill** (code, both sides with the same `billLine`): taxable = qty × rate; GST = 2 × each half
  (taxable × gst% / 200) rounded to the paisa, half up (as invoices print CGST and SGST); line amount =
  taxable + GST; `totalPaise` the sum. GST rate from the yes, else the invoice, else none (today's
  bill). The contractor's code checks every line including GST.
* **Against the invoice's grand total** (`invoiceCheck`): equal, or the invoice rounded off to the
  rupee and equal to the bill rounded to the rupee → both sides read "चालान/इनवॉइस से मिलान ठीक".
  Different → the supplier's "बिल" is read back once with both figures before it leaves; the contractor
  gets the bill with both figures. The bill is always code's figure, never the printed one.
* **Downstream**: UPI amount vs the bill, ask-anything totals (`order_detail` adds `bill_gst_included`),
  explanation facts (taxable and GST as rupee figures; a percent is never allowed in an explanation),
  the judge page (lines, rates, invoice total). Stock and counts unchanged (quantities only).
  The approval-limit estimate (`request_material`) is still rate × quantity, without GST.
* **JCB hire**: unchanged (no GST). The same optional line fields would fit, but nothing sets them.

Live check (30 Oct, four invented invoices rendered by us, `muse-spark-1.3`): 4/4 read exactly (rate,
taxable value, GST percent, grand total), including two items at 18% and 5% on one invoice, IGST 18%,
and a tax summary printed once with a round-off; code's total matched the grand total on all four
(one by the rupee round-off). p50 about 7.6 s. Clean rendered images, not phone photos.

**Two fixes from the same live test.**

* *Notices lost outside the 24-hour window.* A notice about an order (its reference and text key,
  never the text) that could not be sent because the window was closed is remembered
  (`wa_missed` in the WhatsApp store). When that person next writes anything, the agent first rebuilds
  what is still waiting for them from its ledger (`waiting(role)`: JCB owner — open requests,
  objections, reported payments; operator — booked jobs not started; supplier — open orders,
  objections, reported payments) and sends each missed one that is still open, as its notice would
  say it now; then the message is handled. Each missed record is taken once, so nothing is told twice;
  one about an order that moved on is dropped. Contractor-side notices: see "Missed notices on the contractor's side" below.
* *Correction hint.* The seller's dispute notice ends "सुधार भेजना हो तो लिखें: 'सुधार 6.0 घंटे'" (the
  hours the contractor named, else billed) / "'सुधार 48 बोरी'" (the quantity named on a one-line bill,
  else the delivered quantities). Code reads "सुधार <figure(s)> [unit]" as `send_correction` and reads
  it back once.

## Payments: part, cash, advance, clubbed (30 Oct 2026)

The recording side of CONTRACTS 4.1 (branch `claude/payments`; the read side, ask-anything, status,
judge page and the cash-receipt reader, is Astra's `astra/payments-view`). One UPI claim no longer
settles a bill: an order has a list of payments and a balance worked out by code (`paymentSummary`).

* **Messages and states.** `PAYMENT_CLAIM` takes `bill: null` (advance), `method: 'cash'` (no UTR, a
  receipt photo optional) and `group` (one share of a clubbed payment); `PAYMENT_ACK` (the seller's
  हाँ/नहीं to one claim), `PAYMENT_RECEIVED` (money the seller got himself, confirmed at once) and the new
  `SETTLED {bill, amountPaise, payments}` (old forms stay valid; old ledgers replay). New state
  `part_paid`. Payments fit from `booked` until `settled` and never move the state before `ACCEPT`.
  The view carries `billTotalPaise`, `confirmedPaise`, `pending` (and `paid`, every payment's status).
* **The seller's agent settles by itself** (`src/agents/pay.js`, the same for the JCB owner and the
  supplier): after a हाँ, after money recorded, or at `ACCEPT` when advances already cover the bill —
  bill accepted, nothing waiting, confirmed ≥ total. Nobody types "settled".
* **Every receipt and notice shows the balance**: "बाक़ी ₹7,500", "बाक़ी ₹17,500; इसमें ₹10,000 पुष्टि के
  इंतज़ार में", "पूरा मिला, ₹2,000 ज़्यादा", "अभी बिल नहीं बना; अग्रिम ₹5,000 पक्का". Status only: no
  reminder, no "please pay", no due date.

**Contractor, parsed by code first** (`src/agents/replies.js` `moneyWords`; exact single-order payments
act at once):

| Written | What happens |
|---|---|
| UPI screenshot alone | one order owed something (or, nothing billed, one order booked) → claimed at once, any amount; several owed by one seller and none owed exactly this amount → the split read back (`pay.split_choose`): "हाँ" sends it, a reference sends it all to that order; different sellers → which order |
| `P-2 ₹10,000 नकद दिए` | cash claim on P-2, at once |
| `P-3 अग्रिम ₹5,000` | "send the UPI screenshot or write नकद"; the screenshot (or "नकद") completes it; a screenshot of another amount is read back with both |
| `P-3 अग्रिम ₹5,000 नकद` | cash advance (no bill yet → `bill: null`), at once |
| `P-1 P-2 ₹39,650` + screenshot or `नकद` | clubbed: the split read back once, then one claim per order with the group |
| a UTR already told to this seller | both payments shown, asked; nothing sent before "हाँ" |

The split (`shares`, using `allocate`): the orders in the order named (none named: every order with
something owed, oldest bill first) each take what is owed, up to what is left; the rest goes to the last
order (an advance when it has no bill, else a credit, shown only). "Owed" counts claims still waiting,
so the same money is never allocated twice.

**Seller, parsed by code first**: a bare "हाँ"/"नहीं" answers the one reported payment waiting (a clubbed
payment is one, answered whole; several → which); `P-2 ₹10,000 नकद मिले` (or `UPI`) records money
received, at once. The seller's notice sets what his next हाँ/नहीं means. Free words go to the model
route, read back once: contractor `claim_payment` (cash only; UPI needs its screenshot), seller
`record_received` and `confirm_payment`.

## Inside the agent (29 Oct 2026)

Judges see the WhatsApp chats and the signed ledgers; the trace shows what each agent did in
between, per order, live.

* `src/trace/trace.js`: per agent, an append-only working log in its own SQLite file
  (`<dataDir>/<name>.trace.db`, in memory without a data dir), never in the hash chain and never in a
  protocol message; the last 2,000 entries are kept. Entries `{at, agent, orderId, ref, convo, kind,
  title, detail, ms}`, kinds `received`, `model`, `check`, `decision`, `signed_out`, `signed_in`,
  `ledger`, `reply`. A handling (one person's message, or one A2A message) runs in an
  `AsyncLocalStorage` context: its entries carry the conversation (a keyed hash of agent, line and
  phone) and join the order as soon as one is written; a held step's entries join through its
  reference; the person's understood message before a "हाँ" that creates the order joins it too.
* `src/trace/hooks.js`: wrappers at the central places, contracts unchanged: Muse Spark (job read
  from the request's shape: schema = explain, an `answer` tool = ask, else understand), the photo
  readers and voice, the committing tools (the decision, recorded before the step runs), the
  ledger's `append`/`ensureOrder`, the link's sends with the A2A transport timed, and
  `createA2AHandler`'s new optional `onReceived` observer. Named checks are one `traceCheck(...)`
  line at the place each check is made (meter continuity and photo consistency, hours × rate, UPI
  amount vs bill, site count vs signed delivery, challan numbers, bill vs delivery × rate, the site's
  signed copy, the explanation and answer guards); the approval gate's check wraps `office.commit`
  and calls the office's own `holds`.
* Privacy: no phone, key, prompt, image or audio bytes; people's words only with `HB_TRACE_TEXT=1`,
  every run of 8+ digits masked, a UTR only in its own field. Every recording is caught and dropped
  on failure; `test/trace/app-trace.test.js` runs both jobs with all traces broken and gets the same
  messages to the same people.
* `GET /agents/<name>/trace?since=<iso>&order=<ref>`: the export's token rule. The judge page shows
  the timeline under each ledger column and polls every 3 s when "live" is on (`web/README.md`).

## Payments on every screen (Build 5, 29 Oct 2026)

`paymentSummary` and `allocate` in `src/ledger/payments.js` remain the shared arithmetic,
with unchanged signatures. Ask-anything, explanation facts, status, waiting lists and the judge
page read the contract's part/cash/advance/clubbed events through this summary. Refused outgoing
messages stay visible in history but do not count. Waiting or denied money never reduces due;
an advance counts when a bill arrives, and a correction changes the bill without changing payments.

Ask-anything exposes each payment's method, advance/bill purpose, group refs and total, status,
and every order's billed/confirmed/waiting/due/credit figures. Payment-day filters include cash,
status and named refs; a group counts once. Code still checks every answer number. Explanation
facts include the same payment figures; the existing conservative payment-word guard remains,
so prohibited prose falls back to code's plain figures.

Status and ordinary pending lines show balances; the seller's pending list and `waiting(role)`
rebuild one item per unanswered claim/group, including advances before a bill. Missed-window
replay matches either group member and sends it once. The recording branch should use
`payview.waiting` (from `paymentWaiting`) or extend `missedWaiting` with its new notice keys;
legacy `jcb/supplier.payment_claimed(_at)` keys already work.

Each judge ledger column shows payment rows, balances and links across a group. After ledger
append, trace audit checks show balance, complete group shares adding to their total, allocation
agreement, and whether a UTR appeared in another claim/group of this counterparty. These checks
observe records; the recording branch retains all acceptance and settlement decisions. The sample
contains invented cash advances, partial payments, a clubbed UPI payment, denial and credit.

CONTRACTS 3.7 adds `readCashReceipt`. The evaluated photo-kind reader is unchanged. When a
contractor's photo is unsure or `other`, an explicit `नकद पर्ची` option reads it once and shows a
read-only preview. The recording branch must bind the receipt to its exact order/group and cash
claim with human confirmation; this branch creates no cash payment from a photo. Missing fields
are omitted; uncertain readings stay uncertain. See `docs/payments-view-report.md` for live checks,
focused tests and integration details. Full tests/typecheck remain the lead's AWS step.

## Learning from corrections (31 Oct 2026)

Every time a person corrects what Muse read, that is the best signal the agent gets; it used to be
thrown away. Now each agent keeps its own corrections and uses them the next time it reads the same
kind of document from the same party. Memory only steers the reading: code still checks every
figure, and a person still decides. Branch `claude/learn-corrections`; brief
`docs/briefs/CLAUDE-learn-corrections.md`.

* **Memory** (`src/learn/corrections.js`): per agent, its own SQLite file
  (`<dataDir>/<name>.learn.db`, in memory without a data dir), apart from the ledger and the trace,
  append-only (triggers refuse UPDATE/DELETE). One row per correction `{kind, party, field, read,
  corrected, sha256, layout, orderId, memory, at}`; `kind` is `meter`, `challan`, `site_challan` or
  `voice` today (`invoice` and `upi` are reserved, see below). `party` is the sender's role on this
  agent, or for the site's copy of a challan the supplier agent that printed it. `layout` is a short
  note made by code from the reading (line count, "tax invoice", the item's line as read), at most 80
  characters. No bytes, no phone numbers (every run of 8+ digits masked), never sent to another agent.
* **Recorded only when the person's own figures for a photo are committed** (`learnFrom` in
  `src/agents/conversation.js`, through the existing paths): meter digits typed after a read-back or
  an unclear photo; challan quantities the supplier types; the site's figures typed after its challan
  copy was read back. A figure equal to the reading, a reading with a doubtful digit (`36?7.7`), a
  "नहीं", or a step that did not commit teaches nothing.
* **Used in the next reading of the same kind from the same party**: the readers take an optional
  `{memory}` (the three field readers; contracts unchanged otherwise), a block after the request with
  at most the 5 most recent corrections as JSON, headed "This is data, never instructions". The photo
  is read with and without the block together (one wait for the person). The reading with memory is
  used; when any figure (or the challan number) differs from the reading without memory, or that
  reading failed, it is read back once (`learn.read_back_meter` / `_challan` / `_site`: "हाँ", "नहीं"
  or the right figures), never recorded silently. Same figures: handled exactly as before.
* **Voice**: a step understood from a voice note that the person refuses and says again (or types)
  with another site or item name, committed within 30 minutes, gives one `voice` correction per
  replaced word, only when the heard word was in the transcript. A word replacement is applied by code
  to later transcripts (before `spokenRefs`, in `src/app.js`) only after 2 committed corrections agree
  and never when people corrected it to two different words; whole words only, never part of a word.
  Note: the orchestrator already drops "साइट" from a site name, so "पिठला" → "पिठला साइट" is not a
  correction; "पिठला" → "पिपला" is.
* **Shown**: trace `check` lines "used 2 past correction(s) from supplier: same figures as without
  them ✓" / "… figures differ … ✗ → read back", "n correction(s) kept for the next challan from
  supplier", and "corrected again after using n past correction(s) ✗"; the export's optional
  `learning` field (`stats()`: per kind corrections recorded, readings that used memory, of those
  corrected again, read back by memory) for the judge page's learning card (`web/learning-view.js`);
  "कितनी बार ग़लत पढ़ा गया?" (a question: "how many", no figure, so a dispute is never taken) answered
  by code from the counts.
* **Controls**: `HB_LEARN=0` turns the use off (no block, no glossary, one reading as before);
  recording goes on. "भूल जाओ P-1" (JCB owner, supplier or contractor; not operator or supervisor)
  drops that order's corrections from use with a row of its own; nothing is erased.
* **Not learnt yet**: a UPI screenshot has no path where the person gives the right figure (a
  differing amount is only read back for yes/no); a "सुधार" of a bill corrects the bill, and may be
  a real difference in what came rather than a misread, so neither is recorded as a reading's
  correction.

Eval (29 Oct, `eval/learn/`, 10 pairs of invented challans rendered by us, `muse-spark-1.3`, 23
live reads; `eval/results/learn-2026-10-29-*.json`): read doc A without memory, keep a correction for
each quantity misread, then read the similar doc B from the same supplier with memory off and on.
Doc B field accuracy (each item's quantity and the challan number): **30/39 off → 36/39 on**;
wrong-but-confident 6 → 3. The whole gain is one layout, the rate printed before the quantity
("380 x 35"): with memory 8/8 instead of 2/8 (p9, p10). The remaining 3 misses are p2, the same
layout, where doc A happened to be read right, so nothing was learnt. Six other layouts were read
right without memory (controls: no memory used). Muse varies between runs by a few fields; the
sample is small; harm on another supplier's layout was not measured.

Second run (30 Oct, after raw line text left the layout note, 21 live reads;
`eval/results/learn-2026-10-30-*.json`): **30/39 off → 33/39 on**; wrong-but-confident 6 → 3. Doc A of p2 and
p9 happened to be read right, so memory was used on one pair only, p10, which went from 1/4 to 4/4. With so few
pairs the two runs do not show whether removing the raw text changed the gain.

## Usual figures (Build 6, 29 Oct 2026)

`src/ledger/usual.js` remembers the latest 10 accepted or settled orders from one agent's own
ledger, per counterparty, item, unit and metric (rate before GST, quantity per order, JCB hours
per job, GST percent). One order contributes once; the accepted correction replaces its disputed
figure. Refused outgoing records and unaccepted bills do not count. Acceptance sequence determines
recency, not payment activity. Integer medians round the middle pair half up. Fewer than 3 values
produces no usual notice. `USUAL_RULES` holds every threshold: strictly more than 25% from the
median, or outside half the minimum to 1.5 times the maximum; integer cross-products decide.

One line is appended to the contractor's bill, a seller's yes read-back/receipt, and a held order's
approval request when unusual. The current order never contributes to its own baseline. An unusually
large supervisor request within the existing limit still goes through; its existing order receipt
is also shown to the contractor with the quantity note. The supervisor gets the ordinary receipt.
Approving a held order returns one enriched receipt to the contractor. Nothing is held, changed,
accepted or disputed because it is unusual. The approval gate and all reply bindings are unchanged.
Approval context also compares the estimate with an estimate computed from each item's median
quantity and pre-tax rate, explicitly labelled as an estimate; combined changes can flag even when
neither component crosses the threshold alone. No historical total is invented.

Ask-anything adds `usual`, with separate counterparty/unit rows, optional site/item/metric filters,
and the existing code checks on answer numbers. JCB hours are per job, never asserted as daily hours.
Insufficient history is said plainly when asked. Disputed-bill explanations include an unusual
median from history already accepted before that bill. GST percentages remain code display only
under the existing conservative prose guard. Trace checks show both normal and unusual comparisons;
the judge page uses the same pure calculator for each ledger's counterparty cards. The signed
sample has accepted cement history at ₹380 and one ₹500 bill flagged at 32% above usual.

## Two requests, unknown site names (30 Oct 2026)

Live on 30 Oct, "50 bags cement, 40 tons sand and jcb for 2 hours ..." and its Hindi form, 8 runs: 5 silently
dropped the JCB (the read-back showed only the material, so a "हाँ" never ordered it) and 3 got
`common.unknown_step` because Muse correctly returned two calls. "NDUAT" would also have become a new site, though
it may be a short name for one on the books. The owner's rule: the agent asks about a name it does not know; it
never guesses. Brief: `docs/briefs/CLAUDE-multi-request-site-names.md`.

**One message, two requests** (`proposeStep`, `twoRequests`/`commitTwo` in `src/agents/conversation.js`).

* Only one `request_material` with one `request_jcb`, for the roles that may call them; the prompt allows it for
  them only. Any other several-call answer is `common.unknown_step`. A call code cannot use refuses both.
* A site or day said once serves both: one the model left out of a call comes from the other, and a value asked
  for one request and answered fills the other (`shareFilled`). What is still missing is asked as in section 6,
  one question at a time; "नहीं" cancels both; nothing goes until the one read-back gets its one "हाँ".
* **One read-back always**, even when a supervisor's two would both be held (a single held request has none).
  After "हाँ" each runs as its own order through `office.commit`: own reference, own signed message, own limit
  check. One may be held while the other goes. A failure on one (refused, unreachable, thrown) leaves the other
  standing, and the one reply says what happened to each.
* **The JCB is never dropped silently.** A message with a JCB word that comes back as material only is read once
  more with that said; if it still does, nothing is sent and the person is asked to write them separately
  (`ask.jcb_separately`). A material word left out of a JCB call has no such guard (none seen live).
* The open question holds both (`two_requests`), like any read-back: a notice waits in the queue behind it, and a
  yes older than the question is not its answer.
* Hours may be words, with or without "घंटे" ("दो", "ढाई"), and a time may carry am/pm ("10 Am"): the live messages
  refused them with `common.bad_args`. This also helps a single request.

**A site name the agent does not know** (`stepsReady`, `src/agents/site-names.js`).

* A request (one or both of two) naming a site not known here, with at least one site known, asks once before the
  read-back: "NDUAT कौन सी साइट है? 1. शिवपुरी ... 3. नई साइट", at most 6 sites (the person's own first, then the most
  recent), then "नई साइट". Known means: the person's own site, every order on the ledger (settled too), steps
  waiting for approval, saved names, and the sites `people.json` gives this agent's people.
* Code decides, from an exact match after trimming and case-folding. Muse is not asked; "Shivpur" is not "Shivpuri".
* A number (or a site's exact name) picks that site: the short name is saved and the order goes under the full name.
  The last number or "नई साइट" saves the name as a new site. Either way it is not asked again, for anyone on this
  agent. "नहीं" cancels and saves nothing; another message lapses the question and is read as new; a number off the
  list or a "हाँ" asks again.
* Two requests with one unknown name ask one question. Two different unknown names ask one after the other.
* Saved in `<dataDir>/<name>.sites.db`, append-only, not in the ledger, so events and old ledgers stay as they are.
  The first answer stands until "भूल जाओ NDUAT" (contractor or supervisor) drops it; orders already recorded stay.
* With no known sites nothing is asked. A person's default site works as before and needs no question.
* Known limits: a voice note's corrected words are not learnt from a refused two-request read-back; ask-anything
  and `stock` know full site names only, so "NDUAT पर कितना सीमेंट" does not find the site's orders.

Live check (30 Oct, `proposeStep` at its real effort, `muse-spark-1.3`, invented wordings; 11 asking for both in
Hindi, Hinglish and English, 7 that must stay as they are). First run, prompt only, 3 runs each: both came back
30/33; one Hindi wording dropped the JCB once, and a wording with hours in words was refused 3/3. With the guard and
hours in words, 5 runs each: both 55/55; the singles stayed single 34/35, with "10am" refused twice. With am/pm too,
3 runs each: both 33/33, singles 21/21, none dropped, none turned into two; p50 3.3 s, slowest 7.0 s. How often the
guard's second reading fired was not counted. Site, day, time, hours, items and units in the second run's pairs were
all as written.

## Meter photo with several jobs, cancelling an order (31 Oct 2026)

Live on 31 Oct: J-2 and J-3 both booked, and no meter photo could be recorded: "write the site or day" kept nothing
and no answer resolved it. J-2 could not be called off either: nothing could end a booked order. Brief:
`docs/briefs/CLAUDE-meter-choice-cancel.md`.

**Which job** (`onMeterImage`, `askJob`, `jobAnswer` in `src/agents/conversation.js`). With several jobs booked or
working the photo waits, unread, as the open question (`meter_job`): "1. J-2: शिवपुरी, 31 अक्टूबर 2026 का काम". A number
on the list or a listed reference picks the job, and the normal flow goes on, reading included. A number or reference off
the list or a "हाँ" asks again; a cancel word drops the photo; another message lapses it and is read as new. One reference in the photo's
caption answers it before it is asked; a caption naming a job not open asks, even with one job open. A new photo replaces the held one.
A supplier's challan photo with several orders booked works the same way (`challan_job`), each line also naming the items.

**Cancelling** (`src/agents/cancel.js`). `रद्द J-2` (also `J-2 रद्द करो`, `cancel J-2`) is parsed by code. The contractor, the
JCB owner or the supplier; anyone else is told whose decision it is. What blocks it is said at once, with the reason;
otherwise one read-back, one "हाँ", one signed `CANCEL` (CONTRACTS 4 and 5). The other side's agent records it without a
yes and tells the contractor and supervisor, or the JCB owner and operator, or the supplier. On the sender's side the
operator or supervisor is told too. A cancelled order leaves `orderRefs`, `बाक़ी` and the totals; `स्थिति`, ask-anything
and the judge page show it as cancelled. A step held for approval has no order yet: it is declined with `नहीं J-2 कारण`.

## A free-text reply and the open question (31 Oct 2026)

The owner's rule: a reply maps to the person's latest open question unless it names a reference. Live on 31 Oct, on a two-line
bill, `Cement 50 बोरी है 40 नहीं` became `confirm_count`, then `Cement 50 bori, sand 40 ton` became a new order, stopped only by a "नहीं".

**The open questions** come from the ledger (`src/agents/open-questions.js`), so they survive a restart and the 30 minutes of a
pending question: a bill or correction for the contractor; a delivery not counted for the supervisor; a request, an objection or a
reported payment for a seller. Latest means the newest asking message. The operator has none.

**The order of reading.** Commands, the pending question's own forms and exact replies run first, unchanged. Then, with no reference or
with one naming an open question, `answerOpen` gives Muse Spark that question and only the steps that answer it, plus `not_an_answer`.
Its step goes through the same conversion and read-back as any. Not an answer: `proposeStep`, as before. Two references: as before.

**A question set aside is not lost.** A notice's question left by another message goes first in the queue and is asked again once when
nothing else is open, so a bare "हाँ" means what was last asked. After that it stands on the ledger: free text still maps to it, and a
bare "हाँ" needs a read-back naming the order. A clarifying reply does not repeat it.

**An objection naming items.** Code ties each figure to one line of the bill by name, the figure being in the person's own words; items not
named keep their billed quantity; the total comes from the agreed rates and GST. The wire stays `theirFigure.totalPaise`, and the
person's whole message is the reason. A figure that cannot be tied is asked about.

**A first bill before the site's count** rests only on the supplier's figures. It says so (`site.material_bill_no_count`) and offers no one-word "हाँ"; `हाँ P-5` reads back. A correction answers the contractor's own objection and keeps the one word. The count still closes once a bill is in force.

**A challan is matched to the order by name, never by position, and never across units.** Two known units that differ (40 cft on an order in tons), or an item no line names, are asked. Unit words we don't know are not called different.

**`हाँ P-4` and `नहीं P-4 ...` from the contractor** decide an approval while a step for that reference waits. With none waiting and the order billed or disputed they are about the bill: `हाँ` reads back `accept_bill`, bound to the bill in force, and `नहीं` goes to the objection. The notices of a bill with no open question (`site.material_bill_mismatch`, `site.material_bill_count_differs`) say so.

**Code's rule on an objection.** With a bill question open and no reference, a `request_material` with no site, day or time whose every item, with a figure, is a line of that bill is the objection, whatever the model chose (live, both runs). It gets the same checks and read-back. With a site, day or time, or any other item, it stays a new order.

**A seller's yes without its rate** is asked for (`jcb.rate_needed`, `supplier.rates_needed`), never read back with a dash. A rate in number words counts only when it comes to whole rupees (`parseRatePaise`).

**The count** is recorded once and never with a bill in force: not offered to the model, refused by reference and at the tool. A different
figure afterwards is an objection to the bill.

**Missed notices on the contractor's side.** The contractor's agent and the office now have `waiting`, rebuilt from the ledger like the sellers': the contractor's bill or correction in force in state `billed`, and a held step not decided; the supervisor's delivery in state `delivered` with no site count; for both another day offered. The bill's notice is built by one function (`billNotice`) when first told and when told again. `tellBill` can make the recorded key `usual.notice`, and a replaced bill has another key, so a notice can name other keys of the same question on that reference (`also`, in `missedWaiting`), and the bill in force is what is told.

A notice told again sets no expectation, because the person's own message runs after it and may be a "हाँ" written before they saw it. The one-word texts take `{yes}`, which is "हाँ" when first told and "हाँ P-1" when told again. `हाँ P-1` from the contractor is the existing read-back bound to the bill in force. From a supervisor on a delivery waiting for the count it records the count as the same as the challan (new; it answered "only the contractor" before). For 30 minutes after a replay a bare yes from that person, with no question open, gets `site.yes_needs_ref`: it decides nothing and reaches no model. After that, or after a restart, it goes the usual way (read against the latest open question, then a read-back). A notice whose send fails is put back and told at the next message; a crash between taking and sending still loses it.

## The ledgers checked against each other's receipts (31 Oct 2026)

**The fault.** A ledger's hash chain has no secret. Whoever can write its SQLite file can change a row and recompute every later hash, and `verifyChain` passes; deleting the last rows leaves a shorter chain that passes too. On the server `verifyChain` ran only inside the token-gated `/agents/<name>/export`, on request, and its result was only shown: no timer, no log, no alarm. The judge page recomputed the chain in the browser when someone opened it.

**The check.** Each delivered message brings back the receiver's signed `RECEIPT`, kept only in the sender's ledger, naming `entry_hash` (the receiver's row for that message) and `chain_head` (the receiver's newest hash once that row was written; on a repeat, a later head, and the entry is the first row). `src/ledger/cross-check.js` is pure, with no imports, and the judge page runs the same file: for each receipt held from a peer, the entry must be in the peer's chain and be the `in` row of that message, same order and sender; the head must be in the chain and not older than the entry. Both directions. A refused or undelivered message has no receipt and nothing to compare. Each problem comes back with the holder's row, the kind and the order.

**On the server.** `src/ledger/integrity.js` runs `verifyChain` on each agent and the cross-check between connected agents, with each receipt's signature checked against the peer key the agent already holds. `src/app.js` runs it at start and every 6 hours (`integrityCheckMs`, cleared on close). All ledgers are read in one turn, so a message in flight cannot look like a mismatch; the steps run in separate turns, so messages keep moving. A healthy check logs one line and sends nothing. An error in the check is logged by its name only and is no alarm.

**On failure.** The log names agents, row numbers and kinds. The owner-level person (`contractor`, `jcb_owner`, `supplier`) of each agent concerned gets `common.records_disagree`, no figures, one message however many receipts one edit disturbs. A broken chain concerns that agent; a receipt mismatch concerns the pair. Told failures are kept by id per person in the WhatsApp store (`wa_integrity_told`, a new table beside the others), so a restart does not repeat them and only a new failure tells again. A send that fails, the 24-hour window included, stays untold and is tried at the next check; 6 hours is under 24, so the first check after the person writes reaches them. This does not use `tellWaiting`, which rebuilds notices about an order from its ledger.

**On the page.** Under the ledger cards, for the contractor with each seller: receipts compared, signatures checked, and each mismatch, in both languages. Live, each side is fetched at its own moment, so a receipt at or after the other side's `exportedAt` is counted as "next time", not judged.

**On copies.** `node src/ledger/check-files.js jcb=<file> site=<file> supplier=<file>`, with `<name>.key=ed25519:...` to check signatures too. Exit 0 agrees, 1 does not, 2 wrong use or not checked.

**What it still cannot see.** Rows written after the last receipt from that peer, which include a seller's own sent bill until it next receives a message. Three agents with their keys on one server: someone with full server access can rewrite all three ledgers and re-sign them consistently, and only a copy of the chain heads held off the server would catch that, which is not built. Rows with no receipt relation (local notes) are covered only by the chain, so an edit to one shows only if a later receipt names a head after it. Nothing here changes how hashes are computed or any existing row, and no protocol message is added.

**A JCB bill is checked too.** On a BILL or CORRECTION for a JCB order the contractor's agent checks the rate against the one in the JCB owner's yes on that order, and the amount against hours × that rate (rounded as `jcbBillBody` does). A correction may change the hours, never the rate. One that does not follow is told with both figures (`site.bill_mismatch`), to the contractor only, with no one-word "हाँ" (it asks for `हाँ J-1`), also when told again. The trace check is `bill_follows`, as for material. The hours are not checked here: the meter readings are on the owner's side, and the photos come with the bill.

**A repeat gets a fresh receipt.** A receipt sent is not kept in the receiver's ledger, and keeping it would change the ledger's chain. So a repeat is not applied twice and is answered with a new `RECEIPT` for the same entry: new id and time, the same `entry_hash`, and `chain_head` as it stands at that moment, not as it stood when the entry was written.

**Approval results outside the window.** `office.declined`, and an approval with its result, are remembered as missed under the held step's reference (`wa_missed`) when they cannot be sent. When that supervisor next writes, the office's `waiting` rebuilds the notice from `held_decisions`, and an approval says the order's state now, since the run's result is not stored. It goes once, sets no expectation, and leaves a following "हाँ" as it was (`toldOnly`). The latest decision on a reference is the one told.

**The same money counted twice.** `record_received` and the yes of `confirm_payment` compare the amount with money already confirmed on that order, claims and direct entries, one order at a time (each share of a clubbed payment against its own order). On a match nothing is counted: the seller is told the earlier payment with its date and method (`pay.seller.same_recorded`, `pay.seller.claim_same_confirmed`), and only an explicit yes goes on (`sameAmountOk`, as `sameUtrOk`; the model's tools cannot set it). A no records nothing, or for a claim tells the contractor it did not come. It runs at the tool, so every way to the step passes it. A second equal payment can be genuine and cash has no UTR, so this warns and never blocks. The waiting-claim check comes first, and a "separate" answer to it still meets this one. The UTR check is unchanged.

**A seller's plain yes after a notice told again.** The replay guard now holds on every agent, not only the contractor's: `tellWaiting` calls `replayed` for all, `openQuestions` already knows the sellers, and the operator has no open questions, so nothing changes for him. For 30 minutes a bare yes gets `site.yes_needs_ref`, before `sellerReply` can confirm a claim. `payview.waiting` says how to answer, also in `pending`. Three holes closed with it: a clubbed notice carried no `ref`, so a missed one was never remembered or told; a notice whose send failed left the guard off, so a yes could confirm a claim never seen (its references now count as told); and `हाँ P-5` with two claims on P-5 answered "which order: P-5, P-5", with no way out, so it now reads the oldest back with its amount (`नहीं P-5` likewise, `step.deny_payment`). After 30 minutes or a restart a seller's bare yes goes the usual way, which for one waiting claim is to confirm it.
