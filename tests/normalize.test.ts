import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeParams, hashValue } from '../src/policy/normalize';

test('normalizeParams: reordering object keys → identical output', () => {
  assert.equal(
    normalizeParams({ a: 1, b: 2, c: 3 }),
    normalizeParams({ c: 3, a: 1, b: 2 }),
  );
});

test('normalizeParams: whitespace differences in string values → identical output', () => {
  assert.equal(
    normalizeParams({ s: '  hello    world  ' }),
    normalizeParams({ s: 'hello world' }),
  );
});

test('normalizeParams: differing values → different output', () => {
  assert.notEqual(normalizeParams({ a: 1 }), normalizeParams({ a: 2 }));
  assert.notEqual(
    normalizeParams({ a: 1, b: 'x' }),
    normalizeParams({ a: 1, b: 'y' }),
  );
});

test('normalizeParams: nested objects are order-independent at every level', () => {
  assert.equal(
    normalizeParams({ outer: { inner: { z: 1, a: 2 } } }),
    normalizeParams({ outer: { inner: { a: 2, z: 1 } } }),
  );
});

test('normalizeParams: ignoreKeys drops a volatile key so differing values normalize identically', () => {
  assert.equal(
    normalizeParams({ a: 1, ts: 123 }, { ignoreKeys: ['ts'] }),
    normalizeParams({ a: 1, ts: 999 }, { ignoreKeys: ['ts'] }),
  );
  // …and still differs from the un-ignored form
  assert.notEqual(
    normalizeParams({ a: 1, ts: 123 }, { ignoreKeys: ['ts'] }),
    normalizeParams({ a: 1, ts: 999 }),
  );
});

test('normalizeParams: arrays preserve order ([1,2] !== [2,1])', () => {
  assert.notEqual(normalizeParams([1, 2]), normalizeParams([2, 1]));
  assert.equal(normalizeParams([1, 2]), normalizeParams([1, 2]));
});

test('normalizeParams: arrays keep element order even when elements are objects', () => {
  assert.notEqual(
    normalizeParams([{ a: 1 }, { b: 2 }]),
    normalizeParams([{ b: 2 }, { a: 1 }]),
  );
});

test('normalizeParams: string vs number are not conflated (JSON semantics)', () => {
  assert.notEqual(normalizeParams({ v: '1' }), normalizeParams({ v: 1 }));
  assert.notEqual(normalizeParams({ v: 'true' }), normalizeParams({ v: true }));
});

test('hashValue: deterministic', () => {
  const value = { a: 1, b: { c: 'x' } };
  assert.equal(hashValue(value), hashValue(value));
});

test('hashValue: equal after reordering / whitespace differences', () => {
  assert.equal(
    hashValue({ a: 1, b: '  hello    world  ' }),
    hashValue({ b: 'hello world', a: 1 }),
  );
});

test('hashValue: different for semantically-different values', () => {
  assert.notEqual(hashValue({ a: 1 }), hashValue({ a: 2 }));
  assert.notEqual(hashValue([1, 2]), hashValue([2, 1]));
  assert.notEqual(hashValue({ a: 1 }), hashValue({ a: 1, b: 2 }));
});
