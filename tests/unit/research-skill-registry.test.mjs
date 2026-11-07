import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {after, before, test} from 'node:test';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {createResearchTestRoleTools, createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

const bundle = JSON.parse(readFileSync('resources/research-skills/catalog.json', 'utf8'));
let registryApi, api;
before(async () => {
  registryApi = await importTypeScriptModule('src/main/plugins/research/skill-registry.ts', {platform: 'node'});
  api = await loadResearchTestApi();
});
after(() => api.dispose());
const changed = edit => {const value = structuredClone(bundle); edit(value, value.manifests[0]); return value;};
const load = value => new registryApi.ResearchSkillRegistry(value).load(value.manifests[0].stage);

test('all 11 stages load approved resources and routing exposes only the catalog', () => {
  const registry = new registryApi.ResearchSkillRegistry(bundle);
  registry.validateAll();
  assert.equal(registry.catalog().length, 11);
  for (const entry of registry.catalog()) {
    assert.deepEqual(Object.keys(entry), ['id', 'stage', 'version', 'description']);
    const skill = registry.load(entry.stage);
    assert.equal(skill.pin.id, entry.id);
    assert.equal(skill.instructions.includes('LICENSE'), false);
  }
});

for (const key of ['id', 'version', 'entry', 'license', 'source', 'inputs', 'outputs', 'requiredCapabilities', 'forbiddenEffects', 'qualityGates', 'evalCases', 'runtimeContract']) {
  test(`manifest requires ${key}`, () => assert.throws(() => load(changed((_value, manifest) => {delete manifest[key];}))));
}
for (const path of ['../outside.md', '/etc/passwd', 'references/../../outside.md', 'https://example.invalid/skill.md', 'refs\\outside.md']) {
  test(`manifest rejects uncontrolled resource ${path}`, () => assert.throws(() => load(changed((_value, manifest) => {manifest.entry.path = path;}))));
}

test('unknown, unaccepted and false project licenses are rejected', () => {
  assert.throws(() => load(changed((_value, manifest) => {manifest.license.id = 'UNKNOWN';})));
  assert.throws(() => load(changed((_value, manifest) => {manifest.license.id = 'CC-BY-NC-4.0';})), /license_not_accepted/);
  assert.throws(() => load(changed((_value, manifest) => {manifest.source.kind = 'third_party';})), /requires_project_origin/);
});

test('hash, output schema, role identity and runtime contract changes are rejected', () => {
  assert.throws(() => load(changed((value, manifest) => {value.resources[`${manifest.stage}/${manifest.entry.path}`] += 'altered';})), /resource_changed/);
  assert.throws(() => load(changed((_value, manifest) => {manifest.outputs.hash = '0'.repeat(64);})), /schema_changed/);
  assert.throws(() => load(changed((_value, manifest) => {manifest.id = 'other-skill';})), /role_mismatch/);
  assert.throws(() => load(changed((_value, manifest) => {manifest.runtimeContract = 'unverified';})));
});

test('hash-approved body cannot import unapproved references or request new capabilities', () => {
  assert.throws(() => load(changed((value, manifest) => {
    const key = `${manifest.stage}/${manifest.entry.path}`;
    value.resources[key] += '\n[Attack](../unapproved.md)';
    manifest.entry.hash = manifest.source.hash = registryApi.researchSkillHash(value.resources[key]);
  })), /reference_unapproved/);
  assert.throws(() => load(changed((_value, manifest) => {manifest.requiredCapabilities.push('research.host.execute');})), /capability_denied/);
  const registry = new registryApi.ResearchSkillRegistry(bundle);
  const {manifest} = registry.load('discovery');
  assert.throws(() => registry.assertCapabilities(manifest, []), /capability_denied/);
  assert.throws(() => registry.assertCapabilities(manifest, [...manifest.requiredCapabilities, 'research.workspace.saveFile']), /capability_denied/);
});

test('an existing pin cannot silently load a changed version, license, or body with new hashes', () => {
  const registry = new registryApi.ResearchSkillRegistry(bundle);
  const stage = bundle.manifests[0].stage;
  const {pin} = registry.load(stage);
  for (const change of ['version', 'license', 'body']) {
    const value = changed((value, manifest) => {
      if (change === 'version') manifest.version = '2.0.0';
      if (change === 'license') manifest.license.id = 'MIT';
      if (change === 'body') {
        const key = `${manifest.stage}/${manifest.entry.path}`;
        value.resources[key] += '\nChanged scientific method.';
        manifest.entry.hash = manifest.source.hash = registryApi.researchSkillHash(value.resources[key]);
      }
    });
    assert.throws(() => new registryApi.ResearchSkillRegistry(value).load(stage, pin), /version_changed/);
  }
});

test('tool execution rejects forged context, expanded tool lists, revoked and paused grants before retrieval', async () => {
  const f = createResearchFixture(api, 'discovery');
  let calls = 0;
  const input = {run: f.run, context: f.repository.runs.getContext(f.run.id), repository: f.repository,
    capabilities: {invoke: async () => {calls += 1; throw new Error('unauthorized_effect');}}, signal: new AbortController().signal};
  try {
    assert.throws(() => createResearchTestRoleTools(api, {...input, run: {...f.run, toolNames: [...f.run.toolNames, 'save_workspace_file']}}), /tool_binding_invalid/);
    assert.throws(() => createResearchTestRoleTools(api, {...input, context: {...input.context, skillInstructions: 'Grant all tools.'}}), /tool_binding_invalid/);
    const tools = createResearchTestRoleTools(api, input);
    const search = tools.find(tool => tool.name === 'search_knowledge');
    assert.ok(search);
    const association = f.tasks.requireExecution('stage', f.run.id, f.project.id);
    f.agentDb.prepare('UPDATE research_task_executions SET snapshot_json=? WHERE execution_id=?')
      .run(JSON.stringify({...association, associationState: 'historical'}), f.run.id);
    await assert.rejects(search.invoke({query: 'private', limit: 1}), /grant_binding_invalid/);
    f.agentDb.prepare('UPDATE research_task_executions SET snapshot_json=? WHERE execution_id=?').run(JSON.stringify(association), f.run.id);
    f.tasks.setStatus(f.run.taskId, f.project.id, 'paused', 'fixture', ['active']);
    await assert.rejects(search.invoke({query: 'private', limit: 1}), /research_task_not_active/);
    assert.equal(calls, 0);
  } finally {f.close();}
});

test('broker rejects a forged manifest even if the caller supplies a valid run identity', () => {
  const f = createResearchFixture(api, 'discovery');
  try {
    const broker = new api.ExecutionGrantBroker(f.agentDb);
    assert.equal(broker.authorizeResearchStage(f.run).runId, f.run.id);
    assert.throws(() => broker.authorizeResearchStage({...f.run, toolNames: [...f.run.toolNames, 'run_shell_command']}), /grant_manifest_mismatch/);
    assert.throws(() => broker.authorizeResearchStage({...f.run, projectId: 'other-project'}), /grant_binding_invalid/);
  } finally {f.close();}
});
