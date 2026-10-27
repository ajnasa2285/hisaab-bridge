import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { answerFromInput, validAnswer } from './answers.js';
import { loadSplit, privatePath, readPrivateJson, writePrivateJson, imageHash, safeMain } from './private-data.js';

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

export async function labelMeters() {
  if (!stdin.isTTY || !stdout.isTTY || process.platform !== 'win32') throw new Error('interactive_windows_terminal_required');
  const args = process.argv.slice(2);
  if (args.some(a => !['--heldout', '--review'].includes(a))) throw new Error('invalid_arguments');
  const side = args.includes('--heldout') ? 'heldout' : 'development';
  const split = loadSplit();
  const answers = readPrivateJson('answers.json', {});
  const input = createInterface({ input: stdin, output: stdout });
  try {
    const files = Object.entries(split.files).filter(([, v]) => v.side === side);
    for (let index = 0; index < files.length; index++) {
      const [name, entry] = files[index];
      if (!args.includes('--review') && validAnswer(answers[name])) continue;
      if (imageHash(name) !== entry.sha256) throw new Error('image_changed');
      await showPhoto(privatePath(name));
      console.log(`फोटो ${index + 1}/${files.length}`);
      if (validAnswer(answers[name])) {
        const a = answers[name];
        console.log(a.kind === 'not_meter' ? 'पहला उत्तर: मीटर नहीं' : `पहला उत्तर: ${a.clear ? a.raw : 'अस्पष्ट'}`);
        if ((await input.question('यही सही है? हाँ / नहीं: ')).trim() === 'हाँ') continue;
      }
      for (;;) {
        const raw = (await input.question('ठीक दिख रहे अंक लिखें (दशमलव सहित)। अस्पष्ट: ? | मीटर नहीं: नहीं | बाद में: छोड़ें | रोकें: बंद: ')).trim();
        if (raw === 'बंद') return;
        if (raw === 'छोड़ें') break;
        const clock = raw === 'नहीं' ? '' : (await input.question('अलग डैशबोर्ड घड़ी HH:MM; न दिखे तो Enter: ')).trim();
        const answer = answerFromInput(raw, clock);
        if (!answer) { console.log('उत्तर का रूप सही नहीं है। दोबारा लिखें।'); continue; }
        if ((await input.question('फोटो देखकर इस उत्तर की पुष्टि करें: हाँ / नहीं: ')).trim() !== 'हाँ') continue;
        answers[name] = answer;
        writePrivateJson('answers.json', answers);
        console.log('उत्तर सुरक्षित हो गया।');
        break;
      }
    }
  } finally { input.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await safeMain(labelMeters);
