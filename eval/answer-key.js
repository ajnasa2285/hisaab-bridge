import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { answerFromInput, validAnswer } from './answers.js';
import { buildUpiAnswer, validUpiAnswer } from './upi-answers.js';
import { createPrivateData, safeMain } from './private-data.js';

/** @param {string[]} args */
export function parseAnswerKeyArgs(args) {
  const copy = [...args];
  const kind = copy[0] && !copy[0].startsWith('--') ? copy.shift() : 'meter';
  if (!['meter', 'upi'].includes(kind ?? '') || copy.some(a => !['--heldout', '--review'].includes(a))
    || new Set(copy).size !== copy.length) throw new Error('invalid_arguments');
  return { kind: /** @type {import('./private-data.js').DatasetKind} */ (kind), heldout: copy.includes('--heldout'), review: copy.includes('--review') };
}

/** Latin shortcuts for the Hindi control words, so the owner need not switch keyboards. */
const WORDS = new Map([['y', 'हाँ'], ['yes', 'हाँ'], ['ha', 'हाँ'], ['haan', 'हाँ'], ['han', 'हाँ'], ['हां', 'हाँ'],
  ['n', 'नहीं'], ['no', 'नहीं'], ['nahi', 'नहीं'], ['nahin', 'नहीं'], ['skip', 'छोड़ें'], ['stop', 'बंद'], ['band', 'बंद']]);

/** @param {string} text */
export function normalizeWord(text) {
  const t = text.trim();
  return WORDS.get(t.toLowerCase()) ?? t;
}

/** @param {{question: (p: string) => Promise<string>}} input */
async function askUpiAnswer(input) {
  const kind = (await input.question('क्या यह UPI लेनदेन की रसीद है? हाँ (y) / नहीं (n) | बाद में: छोड़ें | रोकें: बंद: ')).trim();
  if (kind === 'बंद' || kind === 'छोड़ें') return kind;
  if (kind === 'नहीं') return { kind: /** @type {const} */ ('not_upi'), confirmedBy: /** @type {const} */ ('human') };
  if (kind !== 'हाँ') return null;
  console.log('जो नहीं दिखता उसके लिए Enter; जो दिखता है पर अस्पष्ट है उसके लिए ?। अनुमान न लगाएँ।');
  /** @param {string} prompt */
  const ask = async prompt => (await input.question(prompt)).trim();
  const amount = await ask('भुगतान राशि रुपये में, केवल ₹ या INR दिखने पर: ');
  const date = await ask('भुगतान की पूरी स्पष्ट तारीख YYYY-MM-DD: ');
  const time = await ask('भुगतान का UTC समय YYYY-MM-DDTHH:MM:SSZ, केवल तारीख, सेकंड और समय-क्षेत्र स्पष्ट हों तो: ');
  const utr = await ask('UTR / UPI संदर्भ / RRN, केवल वही लेबल दिखने पर; ऐप की सामान्य लेनदेन ID नहीं: ');
  const enteredStatus = await ask('लिखी हुई स्थिति: सफल / लंबित / विफल (सिर्फ टिक या रंग देखकर नहीं): ');
  const status = ({ सफल: 'success', लंबित: 'pending', विफल: 'failed' })[/** @type {'सफल'|'लंबित'|'विफल'} */ (enteredStatus)] ?? enteredStatus;
  const payeeName = await ask('प्राप्तकर्ता का पूरा दिखाई दे रहा नाम: ');
  const payeeVpa = await ask('प्राप्तकर्ता का दिखाई दे रहा UPI पता: ');
  const payerName = await ask('भेजने वाले का पूरा दिखाई दे रहा नाम: ');
  const clear = (await ask('क्या भरे हुए सभी विवरण बिना किसी शंका के स्पष्ट हैं? हाँ (y) / नहीं (n): ')) === 'हाँ';
  return buildUpiAnswer({ kind: 'upi_payment', amount, date, time, utr, status, payeeName, payeeVpa, payerName, clear });
}

/** Local human review only; never used by evaluation logging.
 * @param {any} answer */
function showAnswer(answer) {
  if (answer.kind === 'not_meter') { console.log('उत्तर: मीटर नहीं'); return; }
  if (answer.kind === 'not_upi') { console.log('उत्तर: UPI लेनदेन नहीं'); return; }
  if (answer.kind === 'hour_meter') { console.log(`अंक: ${answer.clear ? answer.raw : 'अस्पष्ट'} | घड़ी: ${answer.dashClock ?? 'नहीं दिखती'}`); return; }
  const amount = answer.amountPaise === null ? 'अज्ञात' : `${BigInt(answer.amountPaise) / 100n}.${String(BigInt(answer.amountPaise) % 100n).padStart(2, '0')}`;
  const status = answer.status === 'success' ? 'सफल' : answer.status === 'pending' ? 'लंबित' : answer.status === 'failed' ? 'विफल' : 'अज्ञात';
  console.log(`राशि: ₹${amount} | तारीख: ${answer.date ?? 'अज्ञात'} | UTC समय: ${answer.time ?? 'अज्ञात'}\nUTR: ${answer.utr ?? 'अज्ञात'} | लिखी स्थिति: ${status}\nप्राप्तकर्ता: ${answer.payeeName ?? 'अज्ञात'} | UPI पता: ${answer.payeeVpa ?? 'अज्ञात'} | भेजने वाला: ${answer.payerName ?? 'अज्ञात'}\nस्पष्ट: ${answer.clear ? 'हाँ' : 'नहीं'}`);
}

/** Opens only the selected private photo with the owner's Windows file association.
 * @param {string} path */
function showPhoto(path) {
  return new Promise((resolveDone, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      'Start-Process -FilePath $env:HISAAB_REVIEW_IMAGE'], {
      // Start-Process uses FilePath; keep the private path out of shell interpolation.
      env: { ...process.env, HISAAB_REVIEW_IMAGE: path }, stdio: 'ignore', windowsHide: true,
    });
    child.once('error', () => reject(new Error('viewer_failed')));
    child.once('exit', code => code === 0 ? resolveDone(undefined) : reject(new Error('viewer_failed')));
  });
}

export async function labelImages() {
  if (!stdin.isTTY || !stdout.isTTY || process.platform !== 'win32') throw new Error('interactive_windows_terminal_required');
  const { kind, heldout, review } = parseAnswerKeyArgs(process.argv.slice(2));
  const { loadSplit, privatePath, readPrivateJson, writePrivateJson, imageHash } = createPrivateData(kind);
  const valid = kind === 'meter' ? validAnswer : validUpiAnswer;
  const side = heldout ? 'heldout' : 'development';
  const split = loadSplit();
  const answers = readPrivateJson('answers.json', {});
  // Drafts read by Claude from the screenshots; nothing is saved until the owner confirms each one against the photo.
  const drafts = kind === 'upi' ? readPrivateJson('drafts.json', { answers: {} }).answers ?? {} : {};
  const rl = createInterface({ input: stdin, output: stdout });
  const input = { question: async (/** @type {string} */ p) => normalizeWord(await rl.question(p)) };
  try {
    const files = Object.entries(split.files).filter(([, v]) => v.side === side);
    for (let index = 0; index < files.length; index++) {
      const [name, entry] = files[index];
      if (!review && valid(answers[name])) continue;
      if (imageHash(name) !== entry.sha256) throw new Error('image_changed');
      await showPhoto(privatePath(name));
      console.log(`फोटो ${index + 1}/${files.length}`);
      if (valid(answers[name])) {
        showAnswer(answers[name]);
        if ((await input.question('यही सही है? हाँ (y) / नहीं (n): ')).trim() === 'हाँ') continue;
      }
      const draft = drafts[name] && { ...drafts[name], confirmedBy: 'human', prefilledBy: 'claude' };
      if (!valid(answers[name]) && valid(draft)) {
        console.log('Claude ने फोटो से यह पढ़ा:');
        showAnswer(draft);
        const reply = await input.question('फोटो से मिलाएँ। सही: y | गलत, खुद भरें: n | बाद में: skip | रोकें: stop: ');
        if (reply === 'बंद') return;
        if (reply === 'छोड़ें') continue;
        if (reply === 'हाँ') { answers[name] = draft; writePrivateJson('answers.json', answers); console.log('उत्तर सुरक्षित हो गया।'); continue; }
      }
      for (;;) {
        if (kind === 'upi') {
          const answer = await askUpiAnswer(input);
          if (answer === 'बंद') return;
          if (answer === 'छोड़ें') break;
          if (!answer) { console.log('उत्तर का रूप सही नहीं है। दोबारा लिखें।'); continue; }
          showAnswer(answer);
          if ((await input.question('फोटो देखकर इस उत्तर की पुष्टि करें: हाँ (y) / नहीं (n): ')).trim() !== 'हाँ') continue;
          answers[name] = answer; writePrivateJson('answers.json', answers);
          console.log('उत्तर सुरक्षित हो गया।'); break;
        }
        const raw = (await input.question('ठीक दिख रहे अंक लिखें (दशमलव सहित)। अस्पष्ट: ? | मीटर नहीं: नहीं | बाद में: छोड़ें | रोकें: बंद: ')).trim();
        if (raw === 'बंद') return;
        if (raw === 'छोड़ें') break;
        const clock = raw === 'नहीं' ? '' : (await input.question('अलग डैशबोर्ड घड़ी HH:MM; न दिखे तो Enter: ')).trim();
        const answer = answerFromInput(raw, clock);
        if (!answer) { console.log('उत्तर का रूप सही नहीं है। दोबारा लिखें।'); continue; }
        if ((await input.question('फोटो देखकर इस उत्तर की पुष्टि करें: हाँ (y) / नहीं (n): ')).trim() !== 'हाँ') continue;
        answers[name] = answer;
        writePrivateJson('answers.json', answers);
        console.log('उत्तर सुरक्षित हो गया।');
        break;
      }
    }
  } finally { rl.close(); }
}

export async function labelMeters() { await labelImages(); }
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await safeMain(labelImages);
