// Every user-facing text (docs/CONTRACTS.md section 9), Hindi in Devanagari, as keys with
// {parameters}. Short, plain and polite: a site supervisor reads these on a phone. Numbers arrive
// already formatted by code (src/i18n/format.js): ₹7,320, 6.1 घंटे, 50 बोरी, 29 अक्टूबर.
// Only JCB, UPI, UTR and OK stay in Latin letters. Nothing here reminds anyone to pay or chases
// a payment (AGENTS.md rule 9): status is shown, never a nudge.

/** @type {Readonly<Record<string, string>>} */
export const hi = Object.freeze({
  // =========================================================================================
  // Keys the agents use (docs/text-keys.md on main). Parameters arrive formatted: ₹7,320, 6.1, 50;
  // a missing value arrives as "—". These come first; the keys further down are Fable's own.
  // =========================================================================================

  // --- Common, both agents ---------------------------------------------------------------------
  'common.unknown_step': 'समझ नहीं आया कि क्या करना है। "मदद" लिखें।',
  'common.not_allowed': 'यह कदम आपकी भूमिका में नहीं है।',
  'common.bad_args': 'कोई बात छूट गई या समझ नहीं आई। कृपया फिर से, साफ़ लिखें।',
  'common.no_such_order': 'ऐसा कोई काम दर्ज नहीं है।',
  'common.wrong_state': 'यह कदम अभी नहीं हो सकता, काम उस जगह पर नहीं है।',
  'common.pending': 'हमारी ओर दर्ज हो गया। दूसरी ओर अभी पहुँच नहीं है, अपने आप फिर भेजा जाएगा।',
  'common.refused': 'दूसरी ओर ने इसे नहीं माना।',
  // The one reply to a number not in the list (CONTRACTS section 7); nothing is stored.
  'wa.unknown_sender': 'नमस्ते। यह नंबर सिर्फ़ दर्ज साइट और JCB वालों के लिए है, इसलिए यहाँ कुछ दर्ज नहीं हो सका।',

  // --- JCB side: owner and operator ------------------------------------------------------------
  'jcb.booking_request': '{site} के लिए {day} को {time} बजे से JCB चाहिए, {hours} घंटे। हाँ, नहीं या दूसरा दिन लिखें।',
  'jcb.rate_needed': 'हाँ के साथ प्रति घंटा दर भी लिखें, जैसे "हाँ 1200"।',
  'jcb.day_needed': 'दूसरे दिन के लिए तारीख़ लिखें, जैसे "30-10"।',
  'jcb.reply_sent_yes': 'हाँ का जवाब ठेकेदार को भेज दिया।',
  'jcb.reply_sent_no': 'नहीं का जवाब ठेकेदार को भेज दिया।',
  'jcb.reply_sent_other_time': 'दूसरे दिन का सुझाव ठेकेदार को भेज दिया।',
  'jcb.job_booked': 'काम तय: {site}, {day}, {time} बजे से। शुरू और अंत में मीटर की फ़ोटो भेजें।',
  'jcb.meter_start_saved': 'शुरू का मीटर दर्ज: {reading}।',
  'jcb.meter_end_saved': 'अंत का मीटर दर्ज: {reading}। काम: {hours} घंटे।',
  'jcb.start_first': 'पहले शुरू के मीटर की फ़ोटो भेजें।',
  'jcb.end_not_after_start': 'अंत का मीटर शुरू ({start}) से ज़्यादा होना चाहिए। कृपया फ़ोटो जाँचकर दोबारा भेजें।',
  'jcb.meter_done': 'काम के घंटे आ गए: {hours} घंटे। "बिल" लिखें तो बिल भेजा जाएगा।',
  'jcb.readings_missing': 'दोनों मीटर पढ़ाई (शुरू और अंत) के बिना बिल नहीं बन सकता।',
  'jcb.bill_sent': 'बिल भेजा: {hours} घंटे × {rate} = {total}, मीटर की फ़ोटो के साथ।',
  'jcb.bill_accepted': '{site} का बिल ठेकेदार ने मंज़ूर किया।',
  'jcb.bill_disputed': '{site} के बिल पर ठेकेदार सहमत नहीं। उनका आँकड़ा: {their}। कारण: {reason}।',
  'jcb.correction_sent': 'सुधरा बिल भेजा: {hours} घंटे, कुल {total}।',
  'jcb.payment_claimed': 'ठेकेदार का कहना है कि {site} के लिए {amount} का भुगतान {day} को किया, UTR {utr}। कृपया अपना खाता देखें; आया हो तो "हाँ" लिखें, नहीं तो "नहीं"।',
  'jcb.settled_sent': 'आपने {amount} मिलना पक्का किया। काम का हिसाब पूरा।',

  // --- Contractor side: contractor and supervisor ------------------------------------------
  'site.jcb_requested': 'JCB की माँग भेजी: {site}, {day}, {time} बजे से। जवाब आते ही बताया जाएगा।',
  'site.booking_yes': 'JCB मालिक ने हाँ कहा: {site}, {day}, {time} बजे से, दर {rate} प्रति घंटा।',
  'site.booking_no': 'JCB मालिक {site} के लिए {day} को नहीं आ सकते। चाहें तो दूसरे दिन के लिए पूछें।',
  'site.booking_other_time': 'JCB मालिक {site} के लिए {day} को {time} बजे आ सकते हैं, दर {rate}। ठीक हो तो "हाँ" लिखें।',
  'site.bill_received': '{site} का बिल आया: {hours} घंटे × {rate} = {total}, मीटर की {photos} फ़ोटो के साथ। ठीक हो तो "हाँ" लिखें, नहीं तो अपना आँकड़ा और कारण लिखें।',
  'site.correction_received': '{site} का सुधरा बिल आया: {hours} घंटे × {rate} = {total}, मीटर की {photos} फ़ोटो के साथ। ठीक हो तो "हाँ" लिखें।',
  'site.bill_accepted': '{site} का बिल मंज़ूर किया, JCB मालिक को बता दिया।',
  'site.bill_disputed': '{site} के बिल पर आपकी आपत्ति JCB मालिक को भेज दी।',
  'site.reason_needed': 'आपत्ति के साथ कारण भी लिखें।',
  'site.figure_needed': 'आपत्ति के साथ अपना आँकड़ा लिखें: घंटे या रक़म।',
  'site.payment_claimed': '{amount} के भुगतान की जानकारी JCB मालिक को भेजी। उनकी पुष्टि आते ही बताया जाएगा।',
  'site.settled': 'JCB मालिक ने {amount} मिलना पक्का किया। {site} का यह हिसाब पूरा।',

  // =========================================================================================
  // Fable's own keys: request list, site account and the flows not yet wired by the agents.
  // =========================================================================================

  // --- Booking: questions and answers ---------------------------------------------------------
  'booking.ask_jcb': '{site} पर {day} को JCB चाहिए, {hours}। आ सकेंगे? हाँ / नहीं / दूसरा दिन',
  'booking.ask_jcb_time': '{site} पर {day} को {time} बजे से JCB चाहिए, {hours}। आ सकेंगे? हाँ / नहीं / दूसरा दिन',
  'booking.ask_material': '{site} पर {day} को {items} चाहिए। भेज सकेंगे? हाँ / नहीं / दूसरा दिन',
  'booking.confirm': 'पक्का करें: {site}, {day}, {what}। {to} से पूछें? हाँ / नहीं',
  'booking.sent': '{to} से पूछ लिया: {site}, {day}, {what}। जवाब आते ही बताया जाएगा।',
  'booking.reply_prompt': '{from} की माँग: {site}, {day}, {what}। हाँ, नहीं या दूसरा दिन (जैसे 30-10) लिखें।',
  'booking.rate_prompt': 'दर क्या रहेगी? सिर्फ़ अंक लिखें, जैसे 1200।',
  'booking.yes': '{from} ने हाँ कहा: {site}, {day}, {what}।',
  'booking.yes_rate': '{from} ने हाँ कहा: {site}, {day}, {what}। दर {rate}।',
  'booking.no': '{from} {day} को नहीं आ सकते। किसी और दिन के लिए पूछें?',
  'booking.other_time': '{from} {day} को नहीं, {otherDay} को आ सकते हैं। ठीक रहेगा? हाँ / नहीं',
  'booking.booked': 'तय हो गया: {site}, {day}, {what}।',
  'booking.declined': 'मना हो गया: {site}, {day}, {what}।',

  // --- Meter readings ---------------------------------------------------------------------------
  'meter.received': 'मीटर पढ़ा: {reading} घंटे, समय {when}। धन्यवाद।',
  'meter.start': 'शुरू का मीटर दर्ज: {reading}।',
  'meter.end': 'अंत का मीटर दर्ज: {reading}। आज का काम: {hours}।',
  'meter.confirm': 'मीटर {reading} पढ़ा है। सही है? हाँ / नहीं',
  'meter.retake': 'मीटर की फ़ोटो साफ़ नहीं है। कृपया पास से, बिना चमक के, दोबारा भेजें।',
  'meter.not_meter': 'इस फ़ोटो में घंटा-मीटर नहीं दिखा। कृपया JCB के मीटर की फ़ोटो भेजें।',
  'meter.ask_person': 'मीटर के अंक पक्के नहीं पढ़े गए ({raw})। कृपया अंक लिखकर भेजें, जैसे 3677.7।',

  // --- Bill with evidence -----------------------------------------------------------------------
  'bill.line': '{what}: {qty} × {rate} = {amount}',
  'bill.evidence_meter': 'मीटर {start} से {end} तक = {hours}',
  'bill.evidence_challan': 'चालान {no}: {items}',
  'bill.evidence_fingerprint': 'सबूत की पहचान: {sha}',
  'bill.received': '{from} का बिल #{rev}, {site}:\n{lines}\nकुल {total}\nसबूत:\n{evidence}',
  'bill.accept_prompt': 'बिल {total} ठीक है तो "हाँ" लिखें। आँकड़ा अलग हो तो वही लिखें, जैसे "5.5 घंटे" या "45 बोरी"।',
  'bill.sent': '{to} को बिल #{rev} भेजा: {total}। जवाब आते ही बताया जाएगा।',
  'bill.accepted': 'बिल {total} मंज़ूर किया। {to} को बता दिया।',
  'bill.accepted_by': '{from} ने बिल {total} मंज़ूर किया।',
  'bill.dispute_reason_prompt': 'आपका आँकड़ा {theirFigure}, बिल में {billFigure}। कारण एक पंक्ति में लिखें।',
  'bill.disputed': 'आपत्ति भेजी: आपका आँकड़ा {theirFigure}, कारण: {reason}। {to} का जवाब आते ही बताया जाएगा।',
  'bill.dispute_received': '{from} बिल {total} से सहमत नहीं। उनका आँकड़ा: {theirFigure}। कारण: {reason}। सुधार भेजने के लिए नया आँकड़ा लिखें।',
  'bill.corrected': '{from} ने सुधरा बिल #{rev} भेजा: कुल {total} (पहले {old})।',
  'bill.correction_sent': 'सुधरा बिल #{rev} {to} को भेजा: {total}।',
  'bill.total_mismatch': 'पंक्तियों का जोड़ {sum} है, कुल {total} लिखा है। बिल नहीं भेजा गया।',
  'bill.no_evidence': 'सबूत के बिना बिल नहीं बन सकता। पहले मीटर की फ़ोटो भेजें।',

  // --- Explanation wrapper: the model's words, the ledger's figures --------------------------
  'explain.wrapper': '{explanation}\n\nहर आँकड़ा बही से: {figures}',
  'explain.unavailable': 'अभी समझा नहीं पा रहे। बही के आँकड़े: {figures}',

  // --- Payment: received, confirm, settled -------------------------------------------------
  'payment.how_to_report': 'भुगतान की UPI फ़ोटो भेजें, या लिखें: रक़म, UTR, तारीख़।',
  'payment.read': 'UPI फ़ोटो पढ़ी: {amount}, UTR {utr}, {day}, {status}।',
  'payment.status.success': 'सफल',
  'payment.status.pending': 'अटका',
  'payment.status.failed': 'असफल',
  'payment.status.unknown': 'पता नहीं',
  'payment.confirm_claim': 'भुगतान {amount}, UTR {utr}, {day}, बिल {total} के लिए। {to} को भेजें? हाँ / नहीं',
  'payment.claim_sent': 'भुगतान की जानकारी {to} को भेजी: {amount}, UTR {utr}। उनकी पुष्टि आते ही बताया जाएगा।',
  'payment.received': '{from} ने भुगतान बताया: {amount}, UTR {utr}, {day}, बिल {total}। खाते में आया हो तो "हाँ" लिखें, नहीं तो "नहीं"।',
  'payment.retake': 'UPI की फ़ोटो साफ़ नहीं है। कृपया पूरी फ़ोटो दोबारा भेजें, जिसमें रक़म, UTR और तारीख़ दिखें।',
  'payment.not_upi': 'इस फ़ोटो में UPI भुगतान नहीं दिखा।',
  'payment.amount_differs': 'फ़ोटो में {seen} दिखा, बिल {total} का है। यही भेजें? हाँ / नहीं',
  'payment.not_confirmed': '{from} ने कहा कि {amount} अभी खाते में नहीं आया। UTR {utr} जाँच लें।',
  'payment.unconfirmed': 'भुगतान {amount} की पुष्टि अभी नहीं आई।',
  'settled.buyer': 'हिसाब पूरा: {from} ने {amount} मिलना पक्का किया। बिल {total}, {site}।',
  'settled.seller': '{amount} मिला दर्ज किया और {to} को बता दिया। हिसाब पूरा: {site}।',

  // --- Refusals: the other agent's codes (CONTRACTS section 4) and our own ------------------
  'refuse.UNSUPPORTED': 'दूसरी ओर ने संदेश नहीं समझा।',
  'refuse.NOT_CONNECTED': '{to} से हमारा जुड़ाव नहीं है।',
  'refuse.BAD_SIGNATURE': 'संदेश की मुहर नहीं मिली, इसलिए उसे नहीं माना गया।',
  'refuse.NOT_FOR_ME': 'यह संदेश हमारे लिए नहीं था।',
  'refuse.EXPIRED': 'संदेश की समय-सीमा निकल गई। फिर से भेजना होगा।',
  'refuse.WRONG_STATE': 'इस समय यह कदम नहीं हो सकता: काम "{state}" पर है।',
  'refuse.BAD_BODY': 'संदेश अधूरा था, इसलिए नहीं भेजा गया।',
  'refuse.not_allowed': 'यह फ़ैसला सिर्फ़ {role} कर सकते हैं।',
  'refuse.unknown_sender': 'नमस्ते। यह नंबर हमारी सूची में नहीं है, इसलिए कुछ दर्ज नहीं किया गया।',
  'refuse.not_understood': 'समझ नहीं आया। "मदद" लिखें।',
  'refuse.nothing_open': 'अभी कोई सवाल खुला नहीं है।',
  'refuse.no_match': 'यह जवाब खुले सवाल से मेल नहीं खाता। खुला सवाल: {question}',

  // --- Roles -----------------------------------------------------------------------------------
  'role.jcb_owner': 'JCB मालिक',
  'role.operator': 'चालक',
  'role.contractor': 'ठेकेदार',
  'role.supervisor': 'सुपरवाइज़र',
  'role.supplier': 'विक्रेता',

  // --- Help, per role ---------------------------------------------------------------------------
  'help.contractor': 'आप लिख सकते हैं:\n• "JCB चाहिए 30-10 साइट का नाम" — JCB की माँग\n• "सीमेंट 50 बोरी 30-10 साइट का नाम" — सामान की माँग\n• "हाँ" / "नहीं" — खुले सवाल का जवाब\n• "माँगें" — सुपरवाइज़र की माँगें\n• "हिसाब साइट का नाम" — साइट का हिसाब',
  'help.supervisor': 'आप लिख सकते हैं:\n• "JCB चाहिए 30-10" — माँग दर्ज\n• "सीमेंट 50 बोरी 30-10" — सामान की माँग\n• "माँगें" — आपकी माँगों की हालत\n• "हिसाब" — साइट का हिसाब',
  'help.jcb_owner': 'आप लिख सकते हैं:\n• "हाँ" / "नहीं" / "30-10" — JCB की माँग का जवाब\n• मीटर की फ़ोटो — पढ़ाई दर्ज\n• "बिल" — बिल बनाकर भेजें\n• "हाँ" — भुगतान मिलने की पुष्टि\n• "हिसाब" — सब काम की हालत',
  'help.operator': 'काम शुरू और ख़त्म होने पर मीटर की फ़ोटो भेजें। बाक़ी मालिक देखेंगे।',
  'help.supplier': 'आप लिख सकते हैं:\n• "हाँ" / "नहीं" / "30-10" — माँग का जवाब\n• चालान की फ़ोटो — पहुँच दर्ज\n• "बिल" — बिल भेजें\n• "हाँ" — भुगतान मिलने की पुष्टि',

  // --- The request list (CONTRACTS section 8) ----------------------------------------------
  'request.added': 'माँग #{id} दर्ज: {what}, {site}, चाहिए {neededOn}।',
  'request.needs_approval': 'माँग #{id} ठेकेदार की मंज़ूरी के बाद आगे जाएगी।',
  'request.within_limit': 'माँग #{id} सीमा के भीतर है, आगे भेजी जा रही है।',
  'request.decide_prompt': '{by} की माँग #{id}: {what}, {site}, चाहिए {neededOn}, अनुमान {estimate}। मंज़ूर? "हाँ {id}" या "नहीं {id}"',
  'request.approved': 'माँग #{id} मंज़ूर ({by})।',
  'request.declined': 'माँग #{id} नामंज़ूर ({by})।',
  'request.sent': 'माँग #{id} आगे भेजी गई।',
  'request.done': 'माँग #{id} पूरी हुई।',
  'request.list_header': '{site} की माँगें:',
  'request.list_line': '#{id} {what} — {neededOn} — {status}',
  'request.list_empty': 'कोई माँग दर्ज नहीं।',
  'request.own': 'अपनी माँग ख़ुद मंज़ूर नहीं की जा सकती।',
  'request.not_found': 'माँग #{id} नहीं मिली।',
  'request.already_decided': 'माँग #{id} पर फ़ैसला हो चुका है: {status}।',
  'request.status.requested': 'मंज़ूरी बाक़ी',
  'request.status.approved': 'मंज़ूर',
  'request.status.declined': 'नामंज़ूर',
  'request.status.sent': 'आगे भेजी',
  'request.status.done': 'पूरी',
  'kind.jcb': 'JCB',
  'kind.material': 'सामान',
  'kind.note': 'अन्य',

  // --- The site account (CONTRACTS section 8) --------------------------------------------
  'account.summary': '{site} का हिसाब\nJCB: {hours}\nसामान: {materials}\nबिल: {billed}\nदिया: {paid}\nबाक़ी: {pending}\nखुली आपत्तियाँ: {disputes}',
  'account.line': '{what} — {amount} — {state} — सबूत {evidence}',
  'account.material': '{name} {qty}',
  'account.empty': '{site} के लिए अभी कुछ दर्ज नहीं।',
  'account.none': '—',
  'state.requested': 'पूछा है',
  'state.offered': 'दूसरा दिन सुझाया',
  'state.declined': 'मना',
  'state.booked': 'तय',
  'state.working': 'काम चालू',
  'state.delivered': 'पहुँचा',
  'state.billed': 'बिल आया',
  'state.disputed': 'आपत्ति',
  'state.accepted': 'मंज़ूर',
  'state.payment_claimed': 'भुगतान बताया',
  'state.settled': 'हिसाब पूरा',
});
