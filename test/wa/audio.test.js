import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fixWavSizes, toWav } from '../../src/wa/audio.js';

/** A WAV as ffmpeg writes it to a pipe: sizes unknown (0xFFFFFFFF), a LIST chunk before data. @param {number} samples */
function pipeWav(samples) {
  const fmt = Buffer.alloc(24);
  fmt.write('fmt ', 0, 'ascii');
  fmt.writeUInt32LE(16, 4);
  fmt.writeUInt16LE(1, 8); // PCM
  fmt.writeUInt16LE(1, 10); // mono
  fmt.writeUInt32LE(16000, 12);
  fmt.writeUInt32LE(32000, 16);
  fmt.writeUInt16LE(2, 20);
  fmt.writeUInt16LE(16, 22);
  const list = Buffer.concat([Buffer.from('LIST', 'ascii'), Buffer.from([4, 0, 0, 0]), Buffer.from('INFO', 'ascii')]);
  const dataHead = Buffer.concat([Buffer.from('data', 'ascii'), Buffer.from([0xff, 0xff, 0xff, 0xff])]);
  const head = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from('WAVE', 'ascii')]);
  return Buffer.concat([head, fmt, list, dataHead, Buffer.alloc(samples * 2, 1)]);
}

test('the sizes of a piped WAV are filled in', () => {
  const fixed = fixWavSizes(pipeWav(1600));
  assert.ok(fixed);
  assert.equal(fixed.readUInt32LE(4) + 8, fixed.length);
  const dataAt = fixed.indexOf('data');
  assert.equal(fixed.readUInt32LE(dataAt + 4), 3200);
  assert.equal(fixWavSizes(Buffer.from('not a wav at all, definitely not one')), null);
});

test('conversion goes through ffmpeg on stdin/stdout and fails safely', async () => {
  /** @type {string[][]} */
  const calls = [];
  const ok = await toWav(new Uint8Array([1, 2, 3]), { run: async (cmd, args) => { calls.push([cmd, ...args]); return { code: 0, stdout: pipeWav(160) }; } });
  assert.equal(ok.ok, true);
  assert.ok(calls[0].includes('pipe:0') && calls[0].includes('16000') && calls[0].includes('pcm_s16le'));
  assert.deepEqual(await toWav(new Uint8Array([1]), { run: async () => ({ code: 1, stdout: Buffer.alloc(0) }) }), { ok: false, reason: 'conversion_failed' });
  assert.deepEqual(await toWav(new Uint8Array([1]), { run: async () => { throw new Error('ENOENT'); } }), { ok: false, reason: 'converter_missing' });
  assert.deepEqual(await toWav(new Uint8Array(0)), { ok: false, reason: 'empty' });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

test('with a real ffmpeg, a generated tone becomes a 16 kHz mono WAV', { skip: !hasFfmpeg && 'ffmpeg not installed here' }, async () => {
  const ogg = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus', '-f', 'ogg', 'pipe:1']).stdout;
  const r = await toWav(new Uint8Array(ogg));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const wav = Buffer.from(r.wav);
  assert.equal(wav.readUInt32LE(4) + 8, wav.length);
  const fmt = wav.indexOf('fmt ');
  assert.deepEqual([wav.readUInt16LE(fmt + 10), wav.readUInt32LE(fmt + 12), wav.readUInt16LE(fmt + 22)], [1, 16000, 16]);
});
