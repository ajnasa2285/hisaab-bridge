import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize } from '../../src/protocol/canonical.js';

test('object keys are sorted, whatever order they arrive in', () => {
  assert.equal(canonicalize({ b: 1, a: 2, c: { z: true, y: null } }), '{"a":2,"b":1,"c":{"y":null,"z":true}}');
  assert.equal(canonicalize({ c: { y: null, z: true }, a: 2, b: 1 }), '{"a":2,"b":1,"c":{"y":null,"z":true}}');
});

test('keys sort by UTF-16 code units (RFC 8785), not by locale', () => {
  assert.equal(canonicalize({ 'é': 1, z: 2, Z: 3, '1': 4 }), '{"1":4,"Z":3,"z":2,"é":1}');
});

test('arrays keep their order; Hindi text is kept as UTF-8, not escaped', () => {
  assert.equal(canonicalize([3, 'घंटे', [1, 2]]), '[3,"घंटे",[1,2]]');
});

test('numbers are written like JSON.stringify; -0 is 0', () => {
  assert.equal(canonicalize({ a: 732000, b: -0, c: 1e21 }), '{"a":732000,"b":0,"c":1e+21}');
});

test('undefined fields are left out, as JSON.stringify does', () => {
  assert.equal(canonicalize({ a: 1, b: undefined }), '{"a":1}');
});

test('what JSON cannot represent exactly is refused', () => {
  for (const bad of [NaN, Infinity, () => 1, new Date(0), new Map(), Symbol('x'), 10n]) {
    assert.throws(() => canonicalize({ x: bad }), TypeError);
  }
});
