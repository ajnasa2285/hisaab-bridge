// WhatsApp voice notes arrive as OGG/Opus; Muse Voice Transcribe takes mono 16-bit PCM WAV at
// 16 kHz. ffmpeg (installed on the server) converts in memory: bytes in on stdin, WAV out on stdout,
// nothing written to disk. The WAV header from a pipe has unknown sizes, so they are filled in here.

import { spawn } from 'node:child_process';

const MAX_SECONDS = 120;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_OUTPUT_BYTES = MAX_SECONDS * 16000 * 2 + 1024;

/**
 * @typedef {(cmd: string, args: string[], input: Uint8Array, o: {timeoutMs: number, maxOutputBytes: number}) =>
 *   Promise<{code: number | null, stdout: Buffer}>} Runner
 */

/** @type {Runner} */
export function runProcess(cmd, args, input, o) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'], timeout: o.timeoutMs });
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    child.stdout.on('data', (c) => {
      size += c.length;
      if (size > o.maxOutputBytes) child.kill('SIGKILL');
      else chunks.push(c);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: size > o.maxOutputBytes ? null : code, stdout: Buffer.concat(chunks) }));
    child.stdin.on('error', () => {});
    child.stdin.end(Buffer.from(input));
  });
}

/**
 * Sets the RIFF and data chunk sizes of a WAV whose header was written to a pipe (sizes unknown).
 * @param {Buffer} wav
 * @returns {Buffer | null} the fixed WAV, or null when it is not a WAV with a data chunk
 */
export function fixWavSizes(wav) {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') return null;
  const out = Buffer.from(wav);
  let p = 12;
  while (p + 8 <= out.length) {
    const tag = out.toString('ascii', p, p + 4);
    if (tag === 'data') {
      let dataBytes = out.length - (p + 8);
      dataBytes -= dataBytes % 2;
      if (dataBytes <= 0) return null;
      out.writeUInt32LE(dataBytes, p + 4);
      const total = p + 8 + dataBytes;
      out.writeUInt32LE(total - 8, 4);
      return out.subarray(0, total);
    }
    const size = out.readUInt32LE(p + 4);
    p += 8 + size + (size % 2);
  }
  return null;
}

/**
 * @param {Uint8Array} bytes the voice note as received (OGG/Opus, AAC, MP3 …)
 * @param {{run?: Runner, ffmpeg?: string, timeoutMs?: number}} [o]
 * @returns {Promise<{ok: true, wav: Uint8Array} | {ok: false, reason: string}>}
 */
export async function toWav(bytes, o = {}) {
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > MAX_INPUT_BYTES) return { ok: false, reason: 'too_large' };
  const args = ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-t', String(MAX_SECONDS), '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', 'pipe:1'];
  let r;
  try {
    r = await (o.run ?? runProcess)(o.ffmpeg ?? 'ffmpeg', args, bytes, { timeoutMs: o.timeoutMs ?? 30000, maxOutputBytes: MAX_OUTPUT_BYTES });
  } catch {
    return { ok: false, reason: 'converter_missing' };
  }
  if (r.code !== 0) return { ok: false, reason: 'conversion_failed' };
  const wav = fixWavSizes(r.stdout);
  return wav ? { ok: true, wav: new Uint8Array(wav) } : { ok: false, reason: 'conversion_failed' };
}
