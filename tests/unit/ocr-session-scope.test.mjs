import assert from 'node:assert/strict';
import { test } from 'node:test';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const { summarizeOcrCleanupErrors, summarizeOcrOperationErrors, withOcrSessionScope } = await importTypeScriptModule(
  'src/main/plugins/research/ocr-session-scope.ts'
);

test('OCR session scope releases every unique session after success', async () => {
  const released = [];
  const first = { release: async () => { released.push('first'); } };
  const second = { release: async () => { released.push('second'); } };

  const result = await withOcrSessionScope(async (register) => {
    register(first);
    register(first);
    register(second);
    return 'parsed';
  });

  assert.equal(result, 'parsed');
  assert.deepEqual(released, ['first', 'second']);
});

test('OCR session scope releases sessions created before partial initialization fails', async () => {
  const released = [];
  const primaryError = new Error('second_session_creation_failed');

  await assert.rejects(withOcrSessionScope(async (register) => {
    register({ release: async () => { released.push('first'); } });
    register({ release: async () => { released.push('second'); } });
    throw primaryError;
  }), (error) => error === primaryError);

  assert.deepEqual(released, ['first', 'second']);
});

test('OCR session scope attempts all releases and reports disposal failures', async () => {
  const released = [];
  const firstError = new Error('first_release_failed');
  const secondError = new Error('second_release_failed');

  await assert.rejects(withOcrSessionScope(async (register) => {
    register({ release: async () => { released.push('first'); throw firstError; } });
    register({ release: async () => { released.push('second'); throw secondError; } });
    return 'parsed';
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [firstError, secondError]);
    assert.deepEqual(summarizeOcrCleanupErrors(error), [
      'Error: first_release_failed',
      'Error: second_release_failed'
    ]);
    return true;
  });

  assert.deepEqual(released, ['first', 'second']);
});

test('OCR cleanup failure stays visible without replacing the parse error', async () => {
  const primaryError = new Error('parse_failed');
  const cleanupError = new Error('release_failed');

  await assert.rejects(withOcrSessionScope(async (register) => {
    register({ release: async () => { throw cleanupError; } });
    throw primaryError;
  }), (error) => {
    assert.equal(error, primaryError);
    assert.deepEqual(error.cleanupErrors, [cleanupError]);
    return true;
  });
});

test('OCR cleanup summary survives a frozen parse error', async () => {
  const primaryError = Object.freeze(new Error('parse_failed'));
  const cleanupError = new Error('release_failed');

  await assert.rejects(withOcrSessionScope(async (register) => {
    register({ release: async () => { throw cleanupError; } });
    throw primaryError;
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.cause, primaryError);
    assert.deepEqual(summarizeOcrCleanupErrors(error), ['Error: release_failed']);
    return true;
  });
});

test('OCR cleanup aggregate preserves a frozen parse error code', async () => {
  const primaryError = Object.freeze(Object.assign(new Error('research_parse_failed'), {
    code: 'research_parse_failed'
  }));
  const cleanupError = new Error('release_failed');

  await assert.rejects(withOcrSessionScope(async (register) => {
    register({ release: async () => { throw cleanupError; } });
    throw primaryError;
  }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.name, 'OcrSessionCleanupAfterParseError');
    assert.equal(error.cause, primaryError);
    assert.equal(error.code, 'research_parse_failed');
    assert.deepEqual(summarizeOcrCleanupErrors(error), ['Error: release_failed']);
    return true;
  });
});

test('OCR cleanup errors can be summarized across the worker boundary', () => {
  const primaryError = new Error('parse_failed');
  primaryError.cleanupErrors = [
    new Error('release_failed'),
    new AggregateError([new Error('first_native_error'), 'second_native_error'], 'multiple_releases_failed')
  ];

  assert.deepEqual(summarizeOcrCleanupErrors(primaryError), [
    'Error: release_failed',
    'Error: first_native_error',
    'second_native_error'
  ]);
});

test('late operation errors can be summarized separately from OCR cleanup errors', () => {
  const primaryError = new Error('research_process_timeout');
  primaryError.operationErrors = [new Error('late_inference_failed')];

  assert.deepEqual(summarizeOcrOperationErrors(primaryError), ['Error: late_inference_failed']);
  assert.deepEqual(summarizeOcrCleanupErrors(primaryError), []);
});
