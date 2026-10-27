// AGENTS.md rule 3: every model called at runtime is a Meta model, and only src/meta/client.js
// talks to a model API. This test fails the build if another model provider appears in src/.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const FORBIDDEN = [
  /generativelanguage\.googleapis\.com/i, /\bgemini\b/i, /api\.openai\.com/i, /\bopenai\b/i, /\bgpt-[0-9]/i,
  /api\.anthropic\.com/i, /\banthropic\b/i, /\bclaude-[a-z0-9]/i, /\bmistral\b/i, /\bcohere\b/i,
  /aiplatform\.googleapis\.com/i, /bedrock-runtime/i, /api\.groq\.com/i, /\bollama\b/i,
];

/** @param {string} dir @returns {string[]} */
function jsFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return jsFiles(p);
    return p.endsWith('.js') ? [p] : [];
  });
}

test('no other model provider is named anywhere in src/', () => {
  const hits = [];
  for (const file of jsFiles(join(ROOT, 'src'))) {
    const text = readFileSync(file, 'utf8');
    for (const re of FORBIDDEN) if (re.test(text)) hits.push(`${relative(ROOT, file)}: ${re}`);
  }
  assert.deepEqual(hits, []);
});

test('package.json depends on no other model provider SDK', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const bad = deps.filter((d) => /openai|anthropic|google\/genai|generative-ai|@google-cloud\/vertexai|mistral|cohere|groq|ollama|langchain/i.test(d));
  assert.deepEqual(bad, []);
});
