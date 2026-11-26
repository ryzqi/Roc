import {after, afterEach, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';

let directory, drafts, projectStore, sessionStore;
const projects = ['draft-test', 'draft-other'];
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-composer-draft-'));
  const outfile = join(directory, 'drafts.mjs');
  await build({stdin: {contents: `
    export * as drafts from './src/renderer/assistant/composer-draft';
    export * as projectStore from './src/renderer/project/project-store';
    export * as sessionStore from './src/renderer/assistant/session-store';
  `, resolveDir: process.cwd(), loader: 'ts'}, outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent'});
  ({drafts, projectStore, sessionStore} = await import(outfile));
});
afterEach(() => projects.forEach(project => drafts.clearProjectAssistantComposerDrafts(project)));
after(async () => {if (directory) await rm(directory, {recursive: true, force: true});});

function write(project, thread, draft) {
  drafts.updateAssistantComposerDraft(project, thread, () => draft);
}
function read(project, thread) {
  let value;
  drafts.updateAssistantComposerDraft(project, thread, current => {value = current; return current;});
  return value;
}

test('draft count limit preserves unsent input and permits edits, deletion and migration', () => {
  for (let index = 0; index < drafts.assistantComposerDraftLimits.count; index++) {
    write(projects[0], `thread-${index}`, {text: `unsent-${index}`, attachments: []});
  }
  assert.throws(() => write(projects[0], 'overflow', {text: 'new', attachments: []}), /assistant_composer_draft_capacity/u);
  assert.equal(read(projects[0], 'thread-0').text, 'unsent-0');
  write(projects[0], 'thread-0', {text: 'still editable', attachments: []});
  drafts.migrateAssistantComposerDraft(projects[0], 'thread-0', 'migrated');
  assert.equal(read(projects[0], 'migrated').text, 'still editable');
  assert.equal(read(projects[0], 'thread-0').text, '');
  drafts.migrateAssistantComposerDraft(projects[0], 'migrated', 'thread-1');
  assert.equal(read(projects[0], 'migrated').text, 'still editable');
  assert.equal(read(projects[0], 'thread-1').text, 'unsent-1');
  drafts.clearAssistantComposerDraft(projects[0], 'migrated');
  write(projects[0], 'overflow', {text: 'now fits', attachments: []});
});

test('aggregate budget includes image payload and preview; failed growth keeps original object', () => {
  const data = 'a'.repeat(drafts.assistantComposerDraftLimits.bytes / 8);
  const attachment = {kind: 'image', source: 'clipboard', name: 'image.png', mediaType: 'image/png', sizeBytes: 1, data, previewUrl: data};
  const original = {text: 'keep text and image', attachments: [attachment]};
  write(projects[0], 'large', original);
  assert.throws(() => write(projects[1], 'large', original), /assistant_composer_draft_capacity/u);
  assert.strictEqual(read(projects[0], 'large'), original);
  assert.throws(() => write(projects[0], 'large', {...original, attachments: [attachment, attachment]}), /assistant_composer_draft_capacity/u);
  assert.strictEqual(read(projects[0], 'large'), original);
  drafts.clearAssistantComposerDraft(projects[0], 'large', {...original});
  assert.strictEqual(read(projects[0], 'large'), original);
  write(projects[0], 'large', {text: 'keep text', attachments: []});
  write(projects[1], 'large', original);
  assert.equal(read(projects[0], 'large').text, 'keep text');
});

test('successful project and global thread deletes release all matching drafts; failures preserve them', async () => {
  let ok = false;
  const client = {api: {research: {deleteProject: async ({id}) => ({ok, data: {deleted: true, id}})},
    tasks: {deleteThread: async () => ({ok, data: null})}}};
  for (const project of projects) {
    write(project, 'shared-thread', {text: project, attachments: []});
    write(project, null, {text: 'new thread', attachments: []});
  }
  await sessionStore.deleteThread(client, 'shared-thread');
  await projectStore.deleteProject(client, projects[0]);
  assert.equal(read(projects[0], 'shared-thread').text, projects[0]);
  assert.equal(read(projects[0], null).text, 'new thread');
  ok = true;
  await sessionStore.deleteThread(client, 'shared-thread');
  for (const project of projects) assert.equal(read(project, 'shared-thread').text, '');
  await projectStore.deleteProject(client, projects[0]);
  assert.equal(read(projects[0], null).text, '');
  assert.equal(read(projects[1], null).text, 'new thread');
});
