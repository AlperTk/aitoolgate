import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteStorage } from '../src/storage/sqlite';
import type { ToolCallEvent, InterventionEvent } from '../src/telemetry/events';

const AT = 1_700_000_000_000;

/** Build a ToolCallEvent with sensible defaults plus optional overrides. */
function toolCall(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  const base: ToolCallEvent = {
    type: 'tool.call',
    sessionKey: 'sess-1',
    toolName: 'bash',
    at: AT,
  };
  return { ...base, ...overrides };
}

/** Build an InterventionEvent with sensible defaults plus optional overrides. */
function intervention(overrides: Partial<InterventionEvent> = {}): InterventionEvent {
  const base: InterventionEvent = {
    type: 'policy.intervention',
    sessionKey: 'sess-1',
    ruleId: 'rule-loop',
    action: 'injectMessage',
    at: AT,
  };
  return { ...base, ...overrides };
}

/** A fresh, unique temp file path suitable for a SQLite database. */
function tempFile(): string {
  return path.join(
    os.tmpdir(),
    `mcp-mgr-storage-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`,
  );
}

/** Remove a sqlite file plus any `-wal` / `-shm` sidecars (best effort). */
function cleanupFile(file: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(`${file}${suffix}`, { force: true });
  }
}

// --- counts -----------------------------------------------------------------

test('getCounts reports totalCalls and per-tool counts', () => {
  const storage = createSqliteStorage({ file: ':memory:' });
  storage.recordToolCall(toolCall({ toolName: 'bash' }));
  storage.recordToolCall(toolCall({ toolName: 'bash', clientId: 'client-A' }));
  storage.recordToolCall(toolCall({ toolName: 'read', args: { path: '/tmp/x' } }));
  storage.recordToolCall(toolCall({ toolName: 'read' }));
  // An intervention is a separate table and must not inflate tool counts.
  storage.recordIntervention(intervention({ ruleId: 'rule-loop' }));

  const counts = storage.getCounts();
  assert.equal(counts.totalCalls, 4);
  assert.deepEqual(counts.perTool, { bash: 2, read: 2 });
  storage.close();
});

// --- top tools --------------------------------------------------------------

test('getTopTools ranks by count desc then name asc, and honors n', () => {
  const storage = createSqliteStorage({ file: ':memory:' });
  for (const name of ['websearch', 'websearch', 'websearch']) {
    storage.recordToolCall(toolCall({ toolName: name }));
  }
  for (const name of ['bash', 'bash']) {
    storage.recordToolCall(toolCall({ toolName: name }));
  }
  for (const name of ['read', 'read']) {
    storage.recordToolCall(toolCall({ toolName: name }));
  }

  const ranked = storage.getTopTools();
  assert.deepEqual(ranked.map((entry) => entry.toolName), ['websearch', 'bash', 'read']);
  assert.deepEqual(ranked.map((entry) => entry.count), [3, 2, 2]);
  // Tie at count 2 (bash/read) resolves alphabetically.
  assert.deepEqual(storage.getTopTools(1), [{ toolName: 'websearch', count: 3 }]);
  assert.deepEqual(storage.getTopTools(2), [
    { toolName: 'websearch', count: 3 },
    { toolName: 'bash', count: 2 },
  ]);
  storage.close();
});

// --- interventions ----------------------------------------------------------

test('getInterventions returns newest-first and honors limit', () => {
  const storage = createSqliteStorage({ file: ':memory:' });
  storage.recordIntervention(intervention({ ruleId: 'rule-1', detail: 'first' }));
  storage.recordIntervention(intervention({ ruleId: 'rule-2', detail: 'second' }));
  storage.recordIntervention(intervention({ ruleId: 'rule-3', detail: 'third' }));

  const all = storage.getInterventions();
  assert.equal(all.length, 3);
  assert.deepEqual(all.map((event) => event.ruleId), ['rule-3', 'rule-2', 'rule-1']);
  assert.deepEqual(all.map((event) => event.detail), ['third', 'second', 'first']);

  const one = storage.getInterventions(1);
  assert.equal(one.length, 1);
  assert.equal(one[0].ruleId, 'rule-3');
  assert.equal(one[0].type, 'policy.intervention');
  assert.equal(typeof one[0].at, 'number');
  storage.close();
});

// --- round-trip -------------------------------------------------------------

test('fields stored on a tool_calls row come back intact', () => {
  const file = tempFile();
  try {
    const storage = createSqliteStorage({ file });
    storage.recordToolCall(
      toolCall({ sessionKey: 'sess-rt', clientId: 'client-A', toolName: 'bash', args: { cmd: 'ls -la' } }),
    );
    storage.recordIntervention(
      intervention({ sessionKey: 'sess-rt', ruleId: 'rule-loop', action: 'injectMessage', detail: 'you are looping' }),
    );
    storage.close();

    // Re-open the same file with a raw connection to inspect the stored rows.
    const raw = new DatabaseSync(file);
    const toolRow = (raw.prepare('SELECT * FROM tool_calls WHERE tool_name = ?').get('bash') as
      | Record<string, unknown>
      | undefined);
    assert.ok(toolRow, 'expected the inserted tool_calls row to be readable');
    assert.equal(toolRow.session_key, 'sess-rt');
    assert.equal(toolRow.client_id, 'client-A');
    assert.equal(toolRow.tool_name, 'bash');
    assert.equal(toolRow.args_json, JSON.stringify({ cmd: 'ls -la' }));
    assert.equal(typeof toolRow.created_at, 'number');

    const interventionRow = (raw.prepare('SELECT * FROM interventions WHERE rule_id = ?').get(
      'rule-loop',
    ) as Record<string, unknown> | undefined);
    assert.ok(interventionRow, 'expected the inserted interventions row to be readable');
    assert.equal(interventionRow.session_key, 'sess-rt');
    assert.equal(interventionRow.rule_id, 'rule-loop');
    assert.equal(interventionRow.action, 'injectMessage');
    assert.equal(interventionRow.detail, 'you are looping');
    raw.close();
  } finally {
    cleanupFile(file);
  }
});

// --- reset ------------------------------------------------------------------

test('reset() clears both telemetry tables', () => {
  const storage = createSqliteStorage({ file: ':memory:' });
  storage.recordToolCall(toolCall({ toolName: 'bash' }));
  storage.recordIntervention(intervention({ ruleId: 'rule-loop' }));
  assert.equal(storage.getCounts().totalCalls, 1);
  assert.equal(storage.getInterventions().length, 1);

  storage.reset();
  assert.equal(storage.getCounts().totalCalls, 0);
  assert.deepEqual(storage.getCounts().perTool, {});
  assert.deepEqual(storage.getTopTools(), []);
  assert.equal(storage.getInterventions().length, 0);
  storage.close();
});

// --- file persistence (optional) --------------------------------------------

test('a file-backed instance persists rows across two separate opens', () => {
  const file = tempFile();
  try {
    const first = createSqliteStorage({ file });
    first.recordToolCall(toolCall({ toolName: 'bash', sessionKey: 'sess-1' }));
    first.recordToolCall(toolCall({ toolName: 'read', sessionKey: 'sess-2' }));
    first.recordIntervention(intervention({ ruleId: 'rule-loop' }));
    first.close();

    const second = createSqliteStorage({ file });
    assert.equal(second.getCounts().totalCalls, 2);
    assert.deepEqual(second.getCounts().perTool, { bash: 1, read: 1 });
    assert.equal(second.getInterventions().length, 1);
    second.close();
  } finally {
    cleanupFile(file);
  }
});
