/**
 * Unit tests for the shared protocol helpers in `src/telemetry/protocol-common.ts`
 * (currently: the conservative leading error-marker heuristic `isErrorResultContent`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isErrorResultContent } from '../src/telemetry/protocol-common';

test('isErrorResultContent: leading error markers are detected (case-insensitive)', () => {
  const trueCases: string[] = [
    'Error: project not found',
    '  error: lowercase with leading whitespace',
    'ERROR:500 no space before the colon',
    'Error:500: nested colon',
    'Error — em-dash detail',
    "Error executing tool activate_project: ProjectNotFoundError: Project 'nonexistent-project-xyz' not found: Not a valid project name or directory. Existing project names: ['opencode-sandbox']",
    'Error occurred while applying the patch',
    'Error happened during cleanup',
    'Error failed at step 3',
    'Error while loading the config',
    'Error when reading the input',
    'Error during startup',
    'Error in the tool pipeline: timeout',
    'Tool execution failed: timed out after 30s',
    'Internal server error (503)',
  ];
  for (const content of trueCases) {
    assert.equal(isErrorResultContent(content), true, `expected true: ${JSON.stringify(content)}`);
  }
});

test('isErrorResultContent: content that merely mentions "error" mid-text is NOT flagged', () => {
  const falseCases: string[] = [
    'The word error appears mid-text',
    'error handling docs: how to catch exceptions',
    'Result: 0 errors found in the build',
    'errors are handled gracefully in this mode',
    'Success: all tests passed',
    'Tool ran without issues',
  ];
  for (const content of falseCases) {
    assert.equal(isErrorResultContent(content), false, `expected false: ${JSON.stringify(content)}`);
  }
});

test('isErrorResultContent: empty and non-string content return false without throwing', () => {
  assert.equal(isErrorResultContent(''), false, 'empty string');
  assert.equal(isErrorResultContent('   '), false, 'whitespace-only string');
  assert.equal(isErrorResultContent(undefined), false, 'undefined');
  assert.equal(isErrorResultContent(null), false, 'null');
  assert.equal(isErrorResultContent(42), false, 'number');
  assert.equal(isErrorResultContent(true), false, 'boolean');
  assert.equal(isErrorResultContent(['Error: nested array content']), false, 'array content is not traversed');
  assert.equal(isErrorResultContent({}), false, 'empty record');
  assert.equal(isErrorResultContent({ error: true }), false, 'record with no non-empty string value');
  assert.equal(isErrorResultContent({ note: 'all good' }), false, 'first string value does not match');
  assert.equal(isErrorResultContent({ error: 'Error: something failed' }), true, 'first string value matches');
  assert.equal(
    isErrorResultContent({ meta: { x: 1 }, message: 'Internal server error' }),
    true,
    'non-string values are skipped until the first string value',
  );
});
