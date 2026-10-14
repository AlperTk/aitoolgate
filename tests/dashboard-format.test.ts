/**
 * Unit tests for the dashboard shared number / size formatters (js/format.mjs).
 *
 * formatCount / formatSize are pure, framework-free functions. They are loaded
 * at runtime via a NON-LITERAL dynamic import (resolves relative to
 * dist/tests/ -> ../../dashboard) so the file compiles cleanly and runs
 * against the real served .mjs module (identical trick to the other
 * dashboard-*.test.ts specs).
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

const base = '../..' + '/dashboard';

interface FormatModule {
  formatCount: (n: number) => string;
  formatSize: (n: number) => string;
}

let F: FormatModule;

before(async () => {
  F = (await import(base + '/js/format.mjs')) as unknown as FormatModule;
});

test('formatCount: plain integers below 1000', () => {
  assert.equal(F.formatCount(0), '0');
  assert.equal(F.formatCount(1), '1');
  assert.equal(F.formatCount(999), '999');
});

test('formatCount: compact k/M with a 1-decimal mantissa', () => {
  assert.equal(F.formatCount(1000), '1k');
  assert.equal(F.formatCount(1100), '1.1k');
  assert.equal(F.formatCount(10000), '10k');
  assert.equal(F.formatCount(1500000), '1.5M');
  assert.equal(F.formatCount(1234567), '1.2M');
});

test('formatCount: no "1000k" rollover; trailing ".0" stripped', () => {
  assert.equal(F.formatCount(1000000), '1M');
  assert.equal(F.formatCount(1999999), '2M');
  assert.equal(F.formatCount(999950000), '1G');
});

test('formatCount: absent / non-finite render as em-dash', () => {
  assert.equal(F.formatCount(undefined as unknown as number), '\u2014');
  assert.equal(F.formatCount(NaN), '\u2014');
});

test('formatSize: plain bytes below 1 KB', () => {
  assert.equal(F.formatSize(0), '0 B');
  assert.equal(F.formatSize(999), '999 B');
});

test('formatSize: KB/MB/GB (1000-based) with a 1-decimal mantissa', () => {
  assert.equal(F.formatSize(1000), '1 KB');
  assert.equal(F.formatSize(1536), '1.5 KB');
  assert.equal(F.formatSize(1234560), '1.2 MB');
  assert.equal(F.formatSize(1000000), '1 MB');
  assert.equal(F.formatSize(1500000), '1.5 MB');
});

test('formatSize: no "1000KB" rollover; trailing ".0" stripped', () => {
  assert.equal(F.formatSize(999950000), '1 GB');
});

test('formatSize: absent / non-finite render as em-dash', () => {
  assert.equal(F.formatSize(undefined as unknown as number), '\u2014');
  assert.equal(F.formatSize(NaN), '\u2014');
});
