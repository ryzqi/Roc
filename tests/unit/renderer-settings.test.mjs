import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

/**
 * Unit tests for the settings centre's pure rules (P8/T8.1–T8.4).
 *
 * Same discipline as P6/P7: every rule the surface obeys is a function of the real
 * contract, and each test pins a *contract* subtlety a component would otherwise
 * re-derive (and get subtly wrong):
 *
 *   - `settings.save` has no partial patch, so "dirty" is a diff against the loaded
 *     document and the bar's count and the section dots come from one call;
 *   - the backend rewrites the three fixed providers on every save, so a locked field is
 *     not a UI preference but a statement about `normalizeProvidersConfig`;
 *   - an exported snapshot cannot contain a plaintext secret, because the draft type has no
 *     key field at all — the assertion is the positive control for that design;
 *   - an import is validated structurally before it can replace the draft, and the round
 *     trip export → import reproduces the document.
 *
 * `settings-rules.ts` imports only types plus the dependency-free `provider-model-key`
 * helper, so esbuild yields a bundle with no zod and no React.
 */

let rules;
let tempDir;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'roc-settings-rules-'));
  const outfile = join(tempDir, 'settings-rules.mjs');
  await esbuild.build({
    entryPoints: ['src/renderer/settings/settings-rules.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'node22',
    logLevel: 'silent'
  });
  rules = await import(outfile);
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function model(id, overrides = {}) {
  return {
    id,
    displayName: `${id} display`,
    enabled: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsImages: false,
    ...overrides
  };
}

function provider(id, overrides = {}) {
  return {
    id,
    name: `${id} name`,
    type: 'openai_compatible',
    endpoint: 'https://api.openai.com/v1',
    credentialRef: null,
    enabled: true,
    models: [model(`${id}-model`)],
    ...overrides
  };
}

function draft(overrides = {}) {
  return {
    settings: {
      schemaVersion: 3,
      startup: { openAtLogin: false },
      globalHotkey: null,
      memory: {
        charLimits: { user: 20000, agents: 20000, memory: 40000 },
        sessionRetentionDays: 30,
        securityScan: {
          promptInjection: true,
          credential: true,
          sshBackdoor: true,
          invisibleUnicode: true
        },
        autoMemory: { enabled: true, lowConfidenceTtlDays: 7, auditRetentionDays: 30, maxCandidatesPerRun: 5 }
      },
      tasks: {
        longRunningThresholds: { runningSeconds: 120, toolCallCount: 20, subagentCount: 3 },
        scheduler: { catchUpOnStartup: true, maxRegisteredTasks: 100 }
      }
    },
    providers: [provider('openai')],
    defaultModelId: 'openai:openai-model',
    permissions: { schemaVersion: 3, mode: 'default', grants: [] },
    hooks: { schemaVersion: 1, hooks: {} },
    index: null,
    ...overrides
  };
}

/* ------------------------------------------------------------------ */
/* Diffing and section attribution                                     */
/* ------------------------------------------------------------------ */

test('an unchanged draft has no diff (the baseline and the draft must not alias)', () => {
  const base = draft();
  const copy = rules.cloneDraft(base);
  assert.deepEqual(rules.diffDraft(base, copy).paths, []);
  assert.equal(rules.diffDraft(base, copy).count, 0);
});

test('a nested provider option is one changed path, and it maps to 模型与服务', () => {
  const base = draft();
  const next = rules.cloneDraft(base);
  next.providers[0].models[0].options = { temperature: 0.4 };
  const diff = rules.diffDraft(base, next);
  assert.deepEqual(diff.paths, ['providers.0.models.0.options']);
  assert.equal(diff.count, 1);
  assert.deepEqual([...diff.sections], ['models']);
});

test('adding a whole provider counts once, not once per field', () => {
  const base = draft();
  const next = rules.cloneDraft(base);
  next.providers.push(provider('second'));
  const diff = rules.diffDraft(base, next);
  assert.deepEqual(diff.paths, ['providers.1']);
  assert.equal(diff.count, 1);
});

test('memory maps by purpose: autoMemory → 记忆策略, securityScan/charLimits → 智能体安全', () => {
  assert.equal(rules.sectionForDraftPath('settings.memory.autoMemory.enabled'), 'memory');
  assert.equal(rules.sectionForDraftPath('settings.memory.autoMemory.maxCandidatesPerRun'), 'memory');
  assert.equal(rules.sectionForDraftPath('settings.memory.securityScan.credential'), 'guardrail');
  assert.equal(rules.sectionForDraftPath('settings.memory.charLimits.user'), 'guardrail');
  assert.equal(rules.sectionForDraftPath('settings.memory.sessionRetentionDays'), 'guardrail');
});

test('every section id in the normative order is addressable', () => {
  assert.deepEqual(
    rules.SETTINGS_SECTIONS.map((section) => section.id),
    [
      'models',
      'default-model',
      'rag',
      'literature',
      'sandbox',
      'guardrail',
      'app',
      'tasks',
      'authorization',
      'hooks',
      'memory',
      'backup'
    ]
  );
  assert.equal(rules.sectionForDraftPath('defaultModelId'), 'default-model');
  assert.equal(rules.sectionForDraftPath('settings.startup.openAtLogin'), 'app');
  assert.equal(rules.sectionForDraftPath('settings.globalHotkey'), 'app');
  assert.equal(rules.sectionForDraftPath('settings.tasks.scheduler.maxRegisteredTasks'), 'tasks');
  assert.equal(rules.sectionForDraftPath('permissions.mode'), 'guardrail');
  assert.equal(rules.sectionForDraftPath('hooks.hooks.PreToolUse'), 'hooks');
  assert.equal(rules.sectionForDraftPath('index.include'), 'rag');
  assert.equal(rules.sectionForDraftPath('unknown.field'), null);
});

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

test('a duplicate model id inside one provider is flagged before the backend rejects it', () => {
  const next = draft();
  next.providers[0].models = [model('same'), model('same')];
  const issues = rules.validateDraft(next);
  assert.ok(issues.some((issue) => issue.path === 'providers.0.models.1.id' && issue.message.includes('重复')));
});

test('a thinking budget that reaches maxTokens is flagged (backend superRefine)', () => {
  const next = draft();
  next.providers[0].models[0].options = { maxTokens: 2048, anthropicThinking: { mode: 'enabled', budgetTokens: 2048 } };
  const issues = rules.validateDraft(next);
  assert.ok(issues.some((issue) => issue.path.includes('anthropicThinking.budgetTokens')));
});

test('a default model whose provider is disabled is flagged, because the backend nulls it', () => {
  const next = draft();
  next.providers[0].enabled = false;
  const issues = rules.validateDraft(next);
  assert.ok(issues.some((issue) => issue.path === 'defaultModelId'));
});

test('a default model whose model is disabled is flagged too', () => {
  const next = draft();
  next.providers[0].models[0].enabled = false;
  assert.ok(rules.validateDraft(next).some((issue) => issue.path === 'defaultModelId'));
});

test('index options must keep at least one kind and one include pattern', () => {
  const next = draft({
    index: {
      projectId: 'p1',
      revision: 3,
      kinds: [],
      include: [],
      exclude: [],
      watch: true,
      paused: false,
      embeddingConfigId: null
    }
  });
  const issues = rules.validateDraft(next);
  assert.ok(issues.some((issue) => issue.path === 'index.kinds'));
  assert.ok(issues.some((issue) => issue.path === 'index.include'));
});

test('an empty endpoint / name / model display name are field errors, not opaque save failures', () => {
  const next = draft();
  next.providers[0].endpoint = '   ';
  next.providers[0].name = '';
  next.providers[0].models[0].displayName = '';
  const paths = rules.validateDraft(next).map((issue) => issue.path);
  assert.ok(paths.includes('providers.0.endpoint'));
  assert.ok(paths.includes('providers.0.name'));
  assert.ok(paths.includes('providers.0.models.0.displayName'));
});

test('a clean draft has no issues', () => {
  assert.deepEqual(rules.validateDraft(draft()), []);
});

/* ------------------------------------------------------------------ */
/* High-impact changes                                                 */
/* ------------------------------------------------------------------ */

test('the three high-impact settings each produce an impact line, and nothing else does', () => {
  const base = draft();
  const next = rules.cloneDraft(base);
  next.defaultModelId = null;
  next.settings.startup.openAtLogin = true;
  next.settings.globalHotkey = 'CommandOrControl+Shift+R';
  next.settings.memory.charLimits.user = 30000;
  const impacts = rules.highImpactChanges(base, next);
  assert.deepEqual(
    impacts.map((impact) => impact.id),
    ['default-model', 'open-at-login', 'global-hotkey']
  );
  assert.match(impacts[0].detail, /清空/);
  assert.match(impacts[2].detail, /CommandOrControl\+Shift\+R/);
});

test('modelOptions labels disabled models and testableModelOptions only lists enabled ones', () => {
  const providers = [provider('a', { models: [model('m1'), model('m2', { enabled: false })] })];
  const options = rules.modelOptions(providers);
  assert.deepEqual(
    options.map((option) => option.key),
    ['a:m1', 'a:m2']
  );
  assert.match(options[1].label, /已停用/);
  assert.deepEqual(
    rules.testableModelOptions(providers, 'a').map((option) => option.key),
    ['m1']
  );
  assert.deepEqual(rules.testableModelOptions(providers, 'missing'), []);
});

/* ------------------------------------------------------------------ */
/* Export / import                                                     */
/* ------------------------------------------------------------------ */

test('the exported snapshot is secret-free by construction and the assertion is a real positive control', () => {
  const next = draft();
  next.providers[0].credentialRef = 'secret:openai';
  const text = rules.serializeSettingsExport(next, '2026-10-15T00:00:00.000Z');
  const document = JSON.parse(text);

  assert.equal(document.schemaVersion, 1);
  assert.equal(document.defaultModelId, 'openai:openai-model');
  assert.equal(document.providers[0].credentialRef, 'secret:openai');
  assert.equal(document.providers[0].apiKey, undefined);

  // No plaintext key exists anywhere in the draft; the export cannot carry one.
  rules.assertNoPlaintextSecret(text, ['sk-live-abcdef123456', 'nvapi-xyz']);

  // Positive control: the assertion is not a no-op — a string that does contain the secret
  // must throw, which is what makes the assertion above meaningful.
  assert.throws(() => rules.assertNoPlaintextSecret(text, ['sk-live-abcdef123456', '2026-10-15T00:00:00.000Z']), {
    message: /settings_export_contains_plaintext_secret/
  });
});

test('export → import round-trips the document into an equal draft', () => {
  const base = draft();
  const next = rules.cloneDraft(base);
  next.providers[0].models[0].options = { temperature: 0.2, maxTokens: 4096 };
  next.permissions.mode = 'fully_automatic';
  next.hooks = { schemaVersion: 1, hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] } };

  const text = rules.serializeSettingsExport(next, '2026-10-15T00:00:00.000Z');
  const parsed = rules.parseSettingsImport(text);
  assert.equal(parsed.ok, true);
  const applied = rules.applyImport(parsed.document, next);

  assert.deepEqual(applied.settings, next.settings);
  assert.deepEqual(applied.providers, next.providers);
  assert.equal(applied.defaultModelId, next.defaultModelId);
  assert.deepEqual(applied.permissions, next.permissions);
  assert.deepEqual(applied.hooks, next.hooks);
});

test('applyImport keeps the live per-project index options (they are not in the snapshot)', () => {
  const current = draft({
    index: {
      projectId: 'p1',
      revision: 5,
      kinds: ['pdf'],
      include: ['**/*'],
      exclude: [],
      watch: false,
      paused: true,
      embeddingConfigId: 'e1'
    }
  });
  const exported = draft({ index: null });
  const parsed = rules.parseSettingsImport(rules.serializeSettingsExport(exported, 'now'));
  assert.equal(parsed.ok, true);
  const applied = rules.applyImport(parsed.document, current);
  assert.deepEqual(applied.index, current.index);
});

test('import refuses text that is not this surface’s document, naming the field', () => {
  assert.match(rules.parseSettingsImport('not json').error, /JSON/);
  assert.match(rules.parseSettingsImport('[]').error, /对象/);
  assert.match(rules.parseSettingsImport('{"schemaVersion":2}').error, /schemaVersion/);

  const base = JSON.parse(rules.serializeSettingsExport(draft(), 'now'));
  assert.match(rules.parseSettingsImport(JSON.stringify({ ...base, settings: null })).error, /settings/);
  assert.match(rules.parseSettingsImport(JSON.stringify({ ...base, providers: {} })).error, /providers/);
  assert.match(
    rules.parseSettingsImport(JSON.stringify({ ...base, providers: [{ id: 'x' }] })).error,
    /providers\[0\]/
  );
  assert.match(rules.parseSettingsImport(JSON.stringify({ ...base, defaultModelId: 5 })).error, /defaultModelId/);
  assert.match(
    rules.parseSettingsImport(JSON.stringify({ ...base, permissions: { mode: 'anything' } })).error,
    /permissions\.mode/
  );
  assert.match(rules.parseSettingsImport(JSON.stringify({ ...base, hooks: undefined })).error, /hooks/);
});

/* ------------------------------------------------------------------ */
/* Imported-file shape helpers                                         */
/* ------------------------------------------------------------------ */

test('patterns round-trip one-per-line and drop blanks and padding', () => {
  assert.deepEqual(rules.linesToPatterns('**/*.md\n\n  **/dist/**  \n'), ['**/*.md', '**/dist/**']);
  assert.equal(rules.patternsToLines(['a', 'b']), 'a\nb');
  assert.deepEqual(rules.linesToPatterns(rules.patternsToLines(['a', 'b'])), ['a', 'b']);
});

/* ------------------------------------------------------------------ */
/* Provider drafts                                                     */
/* ------------------------------------------------------------------ */

test('providerIdFromName slugs ASCII and falls back for names with no ASCII letters', () => {
  assert.equal(rules.providerIdFromName('My Provider!'), 'my-provider');
  assert.equal(rules.providerIdFromName('  '), '');
  const cjk = rules.providerIdFromName('智谱');
  assert.match(cjk, /^provider-[0-9a-f]{8}$/u);
  assert.equal(rules.providerIdFromName(cjk), cjk);
});

test('a new provider gets a unique id and a credential ref pointing at its own slot', () => {
  const base = rules.providerIdFromName('new-openai_compatible');
  const first = rules.createProviderDraft('openai_compatible', []);
  assert.equal(first.id, base);
  const second = rules.createProviderDraft('openai_compatible', [first.id]);
  assert.equal(second.id, `${base}-2`);
  assert.notEqual(first.id, second.id);
  assert.equal(first.credentialRef, null);
  assert.equal(rules.credentialRefFor(first.id), `secret:${first.id}`);
  assert.equal(first.models.length, 1);
  // A freshly created provider has an empty name, which the field validation flags before it
  // can reach the backend's stricter schema.
  assert.ok(
    rules.validateDraft(draft({ providers: [first], defaultModelId: null })).some((issue) => issue.path === 'providers.0.name')
  );
});

test('the three fixed providers are recognised, and their fields are the locked ones', () => {
  assert.deepEqual([...rules.FIXED_PROVIDER_IDS], ['nvidia', 'openrouter', 'llama_cpp']);
  assert.equal(rules.isFixedProviderId('NVIDIA'), true);
  assert.equal(rules.isFixedProviderId('my-openai'), false);
});

test('a created model row has the legacy defaults (streaming and tools on, images off)', () => {
  assert.deepEqual(rules.createModelDraft(), {
    id: '',
    displayName: '',
    enabled: true,
    supportsStreaming: true,
    supportsToolCalls: true,
    supportsImages: false
  });
});
