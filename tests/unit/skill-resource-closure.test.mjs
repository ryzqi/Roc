import assert from 'node:assert/strict';
import {after, before, test} from 'node:test';
import {mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {build} from 'esbuild';

let api, directory;
before(async () => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), 'roc-skill-resources-')));
  symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
  const outfile = join(directory, 'api.mjs');
  await build({stdin: {contents: `
    export {FilesystemBackend} from 'deepagents';
    export {SelectedSkillsFilesystemBackend} from './src/main/services/deep-agent/skill-backend';
    export {readSkillRevision,hashSkillBytes} from './src/main/services/skill-revision';
    export {defaultBuiltinSkillSources} from './src/main/services/builtin-skills/catalog';
    export {installBuiltinSnapshot} from './src/main/services/builtin-skills/snapshot';
    export {extractTarGz} from './src/main/services/builtin-skills/archive';
    export {compileRunCapabilityManifest} from './src/main/plugins/agent/run-capability-manifest';
  `, resolveDir: process.cwd()}, outfile, platform: 'node', bundle: true, packages: 'external', format: 'esm', logLevel: 'silent'});
  api = await import(outfile);
});
after(() => rmSync(directory, {recursive: true, force: true}));
function write(path, text) {mkdirSync(dirname(path), {recursive:true}); writeFileSync(path,text);}
function fixture() {
  const root = mkdtempSync(join(directory, 'fixture-')), snapshotDir = join(root,'snapshot'), skillsDir = join(root,'skills');
  const spec = api.defaultBuiltinSkillSources.find(source => source.id === 'academic-research-skills');
  write(join(snapshotDir,'skills/writer/SKILL.md'), '---\nname: writer\ndescription: original test\n---\nRead `shared/protocol.md`. [Sibling](../other/SKILL.md).\n');
  write(join(snapshotDir,'skills/other/SKILL.md'), '---\nname: other\ndescription: other\n---\nDO_NOT_EXPOSE sibling\n');
  write(join(snapshotDir,'support/shared/protocol.md'), 'Frozen protocol [method](method.md).\n');
  write(join(snapshotDir,'support/shared/method.md'), 'Fixed method 7.5\n');
  write(join(snapshotDir,'support/shared/unselected.md'), 'DO_NOT_EXPOSE support\n');
  api.installBuiltinSnapshot({skillsDir,snapshotDir,spec,commit:'fixture-source-commit'});
  const path=join(skillsDir,'writer');
  const skill={id:'writer',name:'writer',description:'original test',path,enabled:true,status:'ready',lastError:null,
    origin:'builtin',sourceId:spec.id,upstreamRepo:spec.repo,upstreamCommit:'fixture-source-commit'};
  const input={mode:'chat',deleteFileApprovalMode:'default',mcpApprovalMode:'default',mcpServers:[],skills:[skill],workflowHint:null,
    requestedCapabilities:{mcpServers:[],skills:['writer']}};
  const compile=()=>api.compileRunCapabilityManifest(input).manifest;
  const freeze=manifest=>new api.SelectedSkillsFilesystemBackend(new api.FilesystemBackend({rootDir:skillsDir,virtualMode:true}),skillsDir,manifest.skills);
  return {root,skillsDir,path,input,compile,freeze,spec,resource:`_bundles/${spec.id}/shared/method.md`};
}

test('explicit same-source support closure freezes content and license without selecting sibling instructions or new tools', async () => {
  const f=fixture();
  try {
    const manifest=f.compile(), skill=manifest.skills[0];
    assert.deepEqual(skill.resources.map(resource=>resource.path), [f.resource,`_bundles/${f.spec.id}/shared/protocol.md`]);
    assert.ok(skill.resources.every(resource=>resource.license===f.spec.license && resource.licenseHash===api.hashSkillBytes(f.spec.license)));
    assert.deepEqual(manifest.resolvedCapabilities.skills,['writer']);
    const without=api.compileRunCapabilityManifest({...f.input,requestedCapabilities:{mcpServers:[],skills:[]}}).manifest;
    assert.deepEqual(manifest.tools,without.tools);
    const backend=f.freeze(manifest);
    assert.equal((await backend.readRaw(`/${f.resource}`)).data.content,'Fixed method 7.5\n');
    assert.ok((await backend.readRaw('/other/SKILL.md')).error);
    assert.ok((await backend.readRaw(`/_bundles/${f.spec.id}/shared/unselected.md`)).error);
    assert.ok((await backend.readRaw(`/writer/../${f.resource}`)).error);
    const list=await backend.ls(`/_bundles/${f.spec.id}/shared/`);
    assert.deepEqual(list.files.map(file=>file.path).sort(),[`/${f.resource}`,`/_bundles/${f.spec.id}/shared/protocol.md`].sort());
    const visible=(await backend.glob('**/*')).files.map(file=>file.path);
    assert.ok(visible.includes(`/${f.resource}`));
    assert.ok(visible.every(path=>!path.includes('/other/')&&!path.includes('unselected.md')));
    assert.equal((await backend.grep('DO_NOT_EXPOSE')).matches.length,0);
    assert.ok((await backend.grep('Fixed method')).matches.some(match=>match.path===`/${f.resource}`));
    const downloads=await backend.downloadFiles([`/${f.resource}`,'/other/SKILL.md']);
    assert.equal(new TextDecoder().decode(downloads[0].content),'Fixed method 7.5\n');
    assert.equal(downloads[1].error,'permission_denied');
    assert.ok((await backend.write(`/${f.resource}`,'modified')).error);
  } finally {rmSync(f.root,{recursive:true,force:true});}
});

test('missing explicit resources fail preflight and changed bytes, origin, or resource lists refuse frozen resume', async () => {
  const f=fixture();
  try {
    const manifest=f.compile(), resource=join(f.skillsDir,f.resource), backend=f.freeze(manifest);
    write(resource,'Changed method 99\n');
    assert.equal((await backend.read(`/${f.resource}`)).error,'skill_revision_changed');
    assert.equal((await backend.grep('Fixed method',`/_bundles/${f.spec.id}/shared/`)).error,'skill_revision_changed');
    await assert.rejects(backend.downloadFiles([`/${f.resource}`]),/skill_revision_changed/u);
    assert.throws(()=>f.freeze(manifest),/skill_revision_changed/u);
    write(resource,'Fixed method 7.5\n');
    const forged=structuredClone(manifest); forged.skills[0].resources=[];
    assert.throws(()=>f.freeze(forged),/skill_revision_changed/u);
    const state=join(f.path,'roc.skill.json'), original=readFileSync(state,'utf8');
    write(state,original.replace('fixture-source-commit','different-commit'));
    assert.throws(()=>f.freeze(manifest),/skill_revision_changed/u);
    write(state,original);
    unlinkSync(resource);
    assert.throws(()=>f.compile(),/skill_resource_missing/u);
    const outside=join(f.root,'outside.md'); write(outside,'Fixed method 7.5\n');
    symlinkSync(outside,resource);
    assert.throws(()=>f.compile(),/symlink/u);
    assert.equal((await backend.readRaw(`/${f.resource}`)).error,'skill_revision_symlink');
  } finally {rmSync(f.root,{recursive:true,force:true});}
});

test('cross-source declarations never grant access even when the destination file exists', () => {
  const f=fixture();
  try {
    write(join(f.path,'SKILL.md'),'---\nname: writer\ndescription: original test\n---\nRead `../_bundles/nature-skills/shared/attack.md`.\n');
    write(join(f.skillsDir,'_bundles/nature-skills/shared/attack.md'),'not this source');
    const statePath=join(f.path,'roc.skill.json'), state=JSON.parse(readFileSync(statePath,'utf8'));
    state.readonlyResources.push('_bundles/nature-skills/shared/attack.md');
    write(statePath,JSON.stringify(state));
    assert.throws(()=>f.compile(),/skill_resource_source_denied/u);
  } finally {rmSync(f.root,{recursive:true,force:true});}
});

test('bundled Nature references load through their pinned directory allowlist while sibling instructions and scripts stay hidden', async () => {
  const root=mkdtempSync(join(directory,'nature-')), skillsDir=join(root,'skills');
  try {
    const spec=api.defaultBuiltinSkillSources.find(source=>source.id==='nature-skills'), snapshotDir=join(root,'snapshot');
    await api.extractTarGz(readFileSync('resources/builtin-skills/nature-skills.tar.gz'),snapshotDir);
    const installed=api.installBuiltinSnapshot({skillsDir,snapshotDir,spec,commit:'bundled-nature-fixture'});
    const selected=installed.installedSkillIds.filter(id=>id!=='nature-shared').find(id=>api.readSkillRevision(join(skillsDir,id)).resources.length>0);
    assert.ok(selected,'the bundled Nature skills must have real resolvable declared core references');
    const revision=api.readSkillRevision(join(skillsDir,selected));
    const frozen={canonicalIdentity:`skill:${selected}`,name:selected,sourcePath:join(skillsDir,selected),description:'Bundled fixture',
      contentHash:revision.contentHash,license:revision.license,licenseHash:revision.licenseHash,
      sourceRevision:'bundled-nature-fixture',resources:revision.resources};
    const backend=new api.SelectedSkillsFilesystemBackend(new api.FilesystemBackend({rootDir:skillsDir,virtualMode:true}),skillsDir,[frozen]);
    assert.ok(revision.resources.every(resource=>resource.path.startsWith('nature-shared/core/')||resource.path.startsWith('nature-shared/journal-formats/')));
    assert.ok((await backend.readRaw(`/${revision.resources[0].path}`)).data);
    assert.ok((await backend.readRaw('/nature-shared/SKILL.md')).error);
    assert.ok((await backend.readRaw('/nature-shared/scripts/check_consistency.py')).error);
    assert.equal((await backend.grep('not present', '/nature-shared/scripts/')).error,'Roc 当前回合未启用这个 skill。');
  } finally {rmSync(root,{recursive:true,force:true});}
});
