import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

/**
 * Unit tests for the assistant's risky pure logic (P4).
 *
 * These four groups are exactly the places a previous review round identified as able to fail
 * silently — a dropped live event, an unverified HTML allowlist, a model-key format that never
 * matches, and a slash command that swallows a normal prompt. Each group is here because the
 * corresponding bug is invisible in the UI until a user hits it.
 *
 * Still missing on purpose (registered in the phase file): a minimal-payload case for **every**
 * `ChatRunEvent` variant driving the reducer, which is the "T4.1 单测" checkbox and needs the
 * full set of event schemas to be written out.
 */

let chatRun;
let syntax;
let imageAttachments;
let slash;

let tempDir;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'roc-assistant-'));
  const build = async (entry, name) => {
    const outfile = join(tempDir, name);
    await esbuild.build({
      entryPoints: [entry],
      outfile,
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'node22',
      logLevel: 'silent'
    });
    return import(outfile);
  };
  chatRun = await build('src/renderer/assistant/use-chat-run.ts', 'use-chat-run.mjs');
  syntax = await build('src/renderer/assistant/syntax-highlight.ts', 'syntax.mjs');
  imageAttachments = await build('src/renderer/assistant/image-attachments.ts', 'image.mjs');
  slash = await build('src/renderer/assistant/slash-skill-command.ts', 'slash.mjs');
});

after(() => {
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* Live vs wrapped run events                                          */
/* ------------------------------------------------------------------ */

test('a wrapped event is recognised, and a live event never is', () => {
  const wrapped = {
    runId: 'run-1',
    sequence: 3,
    event: { type: 'assistant_block', runId: 'run-1', block: { kind: 'text', blockId: 'b1', text: 'hi' } }
  };
  assert.equal(chatRun.isSequencedChatRunEvent(wrapped), true);

  // The regression this guard exists for: a live `subagent_event` carries its own `sequence`
  // *and* an `event` field, so the original check unwrapped it into the subagent payload —
  // which has no `type` — and the reducer dropped it. Live subagent cards never rendered.
  const liveSubagentEvent = {
    type: 'subagent_event',
    runId: 'run-1',
    sequence: 4,
    identity: { subagentId: 's1', parentSubagentId: null, name: 'scout', depth: 1, path: ['scout'] },
    event: { kind: 'started' }
  };
  assert.equal(chatRun.isSequencedChatRunEvent(liveSubagentEvent), false);

  const liveAssistantBlock = {
    type: 'assistant_block',
    runId: 'run-1',
    block: { kind: 'text', blockId: 'b1', text: 'hi' }
  };
  assert.equal(chatRun.isSequencedChatRunEvent(liveAssistantBlock), false);
  assert.equal(chatRun.isSequencedChatRunEvent({ runId: 'run-1', sequence: 1 }), false);
});

test('normalizeSequencedChatRunEvent unwraps only the wrapper', () => {
  const inner = { type: 'run_started', runId: 'run-1' };
  assert.deepEqual(chatRun.normalizeSequencedChatRunEvent({ runId: 'run-1', sequence: 1, event: inner }), inner);
  assert.deepEqual(chatRun.normalizeSequencedChatRunEvent(inner), inner);
});

test('the sequence guard rejects replays and keeps the newest window bounded', () => {
  const seen = new Map();
  assert.equal(chatRun.shouldApplySequencedRunEvent(seen, { runId: 'r1', sequence: 2, event: {} }), true);
  assert.equal(chatRun.shouldApplySequencedRunEvent(seen, { runId: 'r1', sequence: 2, event: {} }), false);
  assert.equal(chatRun.shouldApplySequencedRunEvent(seen, { runId: 'r1', sequence: 1, event: {} }), false);
  assert.equal(chatRun.shouldApplySequencedRunEvent(seen, { runId: 'r1', sequence: 3, event: {} }), true);

  const bounded = new Map();
  for (let index = 0; index < chatRun.maxSeenRunSequences + 5; index += 1) {
    chatRun.shouldApplySequencedRunEvent(bounded, { runId: `run-${index}`, sequence: 1, event: {} });
  }
  assert.ok(bounded.size <= chatRun.maxSeenRunSequences);
});

/* ------------------------------------------------------------------ */
/* Lowlight AST and safe React text                                    */
/* ------------------------------------------------------------------ */

test('lowlight preserves source text, aliases, and nested highlight classes', async () => {
  const cases = [
    { alias: 'js', canonical: 'javascript', code: 'function greet(name) { return "<b> & text"; }' },
    { alias: 'ts', canonical: 'typescript', code: 'const count: number = 1;' },
    { alias: 'shell', canonical: 'bash', code: 'echo "$HOME"' },
    { alias: 'html', canonical: 'xml', code: '<img src=x onerror="alert(1)">&amp;' }
  ];
  for (const item of cases) {
    const aliasTokens = await syntax.highlightCodeTokens(item.alias, item.code);
    const canonicalTokens = await syntax.highlightCodeTokens(item.canonical, item.code);
    assert.notEqual(aliasTokens, null, `${item.alias} did not highlight`);
    assert.deepEqual(aliasTokens, canonicalTokens, `${item.alias} changed the canonical grammar output`);
    assert.equal(aliasTokens.map((token) => token.text).join(''), item.code);
    assert.ok(aliasTokens.some((token) => token.classes.some((name) => name.startsWith('hljs-'))));
  }

  const javascript = await syntax.highlightCodeTokens('js', cases[0].code);
  assert.ok(javascript.some((token) => token.classes.includes('hljs-keyword')));
  assert.ok(javascript.some((token) => token.classes.includes('hljs-title') && token.classes.includes('function_')));
  const html = await syntax.highlightCodeTokens('html', cases[3].code);
  assert.ok(html.some((token) => token.classes.includes('hljs-tag')));
  assert.ok(html.some((token) => token.classes.includes('hljs-attr')));

  const concurrentCode = 'def greet(name):\n    return name';
  const [firstPython, secondPython] = await Promise.all([
    syntax.highlightCodeTokens('python', concurrentCode),
    syntax.highlightCodeTokens('python', concurrentCode)
  ]);
  assert.notEqual(firstPython, null);
  assert.deepEqual(secondPython, firstPython);
  assert.equal(firstPython.map((token) => token.text).join(''), concurrentCode);
});

test('unknown languages and unsafe lowlight nodes fall back without emitting markup', async () => {
  const code = '<img src=x onerror=alert(1)>';
  assert.equal(await syntax.highlightCodeTokens(null, code), null);
  for (const unknown of ['roc-unknown', 'constructor', 'toString', '__proto__']) {
    assert.equal(await syntax.highlightCodeTokens(unknown, code), null, `${unknown} must stay plain text`);
  }

  const valid = {
    type: 'root',
    children: [
      { type: 'element', tagName: 'span', properties: { className: ['hljs-title', 'function_'] }, children: [{ type: 'text', value: 'greet' }] },
      { type: 'text', value: '(<b>&amp;)' }
    ]
  };
  assert.deepEqual(syntax.lowlightRootToCodeTokens(valid, 'greet(<b>&amp;)'), [
    { text: 'greet', classes: ['hljs-title', 'function_'] },
    { text: '(<b>&amp;)', classes: [] }
  ]);
  assert.equal(syntax.lowlightRootToCodeTokens(valid, 'greet()'), null, 'an incomplete AST must retain source fallback');

  const forgedTrees = [
    { type: 'root', children: [{ type: 'element', tagName: 'img', properties: { onError: 'alert(1)' }, children: [] }] },
    { type: 'root', children: [{ type: 'element', tagName: 'span', properties: { className: ['hljs-keyword', 'onclick=alert(1)'] }, children: [{ type: 'text', value: 'x' }] }] },
    { type: 'root', children: [{ type: 'script', value: 'alert(1)' }] }
  ];
  for (const tree of forgedTrees) {
    assert.equal(syntax.lowlightRootToCodeTokens(tree, ''), null);
  }
});

/* ------------------------------------------------------------------ */
/* Model key format                                                    */
/* ------------------------------------------------------------------ */

test('image support is resolved through the provider:model key format', () => {
  const snapshot = {
    defaultModelId: 'openai:gpt-4o',
    providers: [
      {
        id: 'openai',
        models: [
          { id: 'gpt-4o', supportsImages: true },
          { id: 'gpt-3.5', supportsImages: false }
        ]
      }
    ]
  };
  assert.equal(imageAttachments.isImageInputSupported(snapshot), true);
  assert.equal(
    imageAttachments.isImageInputSupported({ ...snapshot, defaultModelId: 'openai:gpt-3.5' }),
    false
  );
  // A key in the wrong shape (`provider/model`) must not be silently accepted.
  assert.equal(
    imageAttachments.isImageInputSupported({ ...snapshot, defaultModelId: 'openai/gpt-4o' }),
    false
  );
  assert.equal(imageAttachments.isImageInputSupported({ ...snapshot, defaultModelId: null }), false);
  assert.equal(imageAttachments.isImageInputSupported({ ...snapshot, defaultModelId: 'missing:model' }), false);
});

/* ------------------------------------------------------------------ */
/* Slash skill commands                                                */
/* ------------------------------------------------------------------ */

test('known /skill tokens are consumed into explicitSkillIds', () => {
  const ids = ['pdf-reader', 'figure-maker'];
  const parsed = slash.parseSlashSkillCommand('/pdf-reader 把这篇论文读完', ids);
  assert.equal(parsed.kind, 'ok');
  assert.deepEqual(parsed.explicitSkillIds, ['pdf-reader']);
  assert.equal(parsed.input, '把这篇论文读完');
});

test('an unknown slash command stays plain text', () => {
  // A path must never be swallowed by command parsing: an unrecognised first token is
  // ordinary text (`none`), not an error the user has to clear.
  const parsed = slash.parseSlashSkillCommand('/usr/bin/env python', ['pdf-reader']);
  assert.equal(parsed.kind, 'none');
  assert.equal(parsed.input, '/usr/bin/env python');
});

test('repeating the same skill does not duplicate it', () => {
  const parsed = slash.parseSlashSkillCommand('/pdf-reader /pdf-reader 继续', ['pdf-reader']);
  assert.equal(parsed.kind, 'ok');
  assert.deepEqual(parsed.explicitSkillIds, ['pdf-reader']);
});
