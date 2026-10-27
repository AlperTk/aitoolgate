import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApiProviderStore } from '../src/api/providerStore';

test('model-only PATCH on the active provider keeps it active', () => {
  const store = createApiProviderStore();
  const a = store.add({ name: 'a', baseUrl: 'http://a/v1', protocol: 'openai' });
  store.add({ name: 'b', baseUrl: 'http://b/v1', protocol: 'openai' });
  assert.equal(store.getActive()?.id, a.id);

  const updated = store.update(a.id, { model: 'x' });
  assert.equal(updated?.model, 'x');
  assert.equal(updated?.isActive, true);
  assert.equal(store.getActive()?.id, a.id);
  assert.equal(store.list().filter((p) => p.isActive).length, 1);
});

test('activating another provider deactivates the previous active one', () => {
  const store = createApiProviderStore();
  const a = store.add({ name: 'a', baseUrl: 'http://a/v1', protocol: 'openai' });
  const b = store.add({ name: 'b', baseUrl: 'http://b/v1', protocol: 'openai' });
  store.update(b.id, { isActive: true });
  assert.equal(store.getActive()?.id, b.id);
  assert.equal(store.get(a.id)?.isActive, false);
  assert.equal(store.list().filter((p) => p.isActive).length, 1);
});
