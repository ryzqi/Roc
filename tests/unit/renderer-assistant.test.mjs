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
/* highlight.js output allowlist                                       */
/* ------------------------------------------------------------------ */

test('highlight.js markup is tokenised, not injected', () => {
  const tokens = syntax.tokenizeHighlightedHtml(
    '<span class="hljs-keyword">const</span> x = <span class="hljs-string">"a&amp;b"</span>;'
  );
  assert.notEqual(tokens, null);
  assert.deepEqual(tokens[0], { text: 'const', classes: ['hljs-keyword'] });
  assert.equal(tokens[1].text, ' x = ');
  assert.deepEqual(tokens[1].classes, []);
  // Entities are decoded once, so the rendered text matches the source.
  assert.equal(tokens[2].text, '"a&b"');
  assert.deepEqual(tokens[2].classes, ['hljs-string']);
});

test('any markup highlight.js would not emit is rejected', () => {
  const forged = [
    '<img src=x onerror="alert(1)">',
    '<script>alert(1)</script>',
    '<span onclick="alert(1)">x</span>',
    '<span class="evil">x</span>',
    '<span class="hljs-keyword" style="x">y</span>',
    '<span class="hljs-keyword">unbalanced',
    '</span>',
    '<div class="hljs-keyword">x</div>'
  ];
  for (const markup of forged) {
    assert.equal(syntax.tokenizeHighlightedHtml(markup), null, markup);
  }
  assert.deepEqual(syntax.tokenizeHighlightedHtml('plain text'), [{ text: 'plain text', classes: [] }]);
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
