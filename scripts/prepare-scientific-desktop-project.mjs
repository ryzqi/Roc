import assert from 'node:assert/strict';
import {constants, copyFileSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname, join, relative, resolve} from 'node:path';
import Database from 'better-sqlite3';

const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const root = resolve(process.argv[2]), pinned = json('evaluation/results/scientific-rollout-rehearsal.json');
assert.equal(hash(pinned.report.path), pinned.report.sha256);
assert.equal(hash(pinned.verification.path), pinned.verification.sha256);
const report = json(pinned.report.path), run = json(join(report.root, 'run.json'));
assert.equal(run.observations.length, 45);
// A new destination is mandatory. Never replace an existing project or database.
mkdirSync(root, {mode:0o700});
const dataRoot = join(root, 'data'), libraryRoot = join(dataRoot, 'research-library');
const workspace = join(root, 'project'), foreignWorkspace = join(root, 'non-member-project');
const databases = join(dataRoot, 'plugin-data/data/plugins/@roc');
for (const dir of [libraryRoot, workspace, foreignWorkspace, databases]) mkdirSync(dir, {recursive:true});
const copies = [];
function copy(source, target, expected) {
  const sha256 = hash(source), mtimeNs = statSync(source, {bigint:true}).mtimeNs.toString();
  if (expected) assert.equal(sha256, expected, source);
  mkdirSync(dirname(target), {recursive:true});
  copyFileSync(source, target, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
  assert.equal(hash(target), sha256);
  copies.push({source, target, sha256, mtimeNs});
}
for (const file of report.outputs.filter(f => ['research.db','agent.db'].some(n => f.path === join(report.root,n)))) {
  copy(file.path, join(databases, file.path.endsWith('/research.db') ? 'plugin-research.db' : 'plugin-agent.db'), file.sha256);
}
for (const file of report.copies) {
  const path = relative(report.root, file.path);
  assert.ok(!path.startsWith('..') && !path.startsWith('/'));
  copy(file.path, join(libraryRoot, path), file.derivedSha256 ?? file.sha256);
}
for (const item of run.observations) copy(join(report.root,item.paperIR.path), join(libraryRoot,item.paperIR.path),item.paperIR.sha256);
const database = join(databases, 'plugin-research.db'), db = new Database(database);
try {
  db.transaction(() => {
    assert.equal(db.prepare('UPDATE research_projects SET workspace_path=?, title=?, description=? WHERE id=?')
      .run(workspace,'公开论文 RAG 验收（45 篇）','公开论文工程测试；科研质量指标未验收。',run.projectId).changes,1);
    assert.equal(db.prepare('UPDATE research_projects SET workspace_path=? WHERE id=?').run(foreignWorkspace,run.foreignProjectId).changes,1);
    // Index scopes follow the copied project; all document, IR and history identities stay intact.
    db.prepare('UPDATE research_index_projects SET root_path=? WHERE project_id=?').run(workspace,run.projectId);
    db.prepare('UPDATE research_index_projects SET root_path=? WHERE project_id=?').run(foreignWorkspace,run.foreignProjectId);
  })();
  assert.deepEqual(db.pragma('integrity_check'), [{integrity_check:'ok'}]);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
} finally { db.close(); }
copy(database,join(root,'prepared.db'));
const executable = createRequire(import.meta.url)('electron'), entry = resolve('dist/main/index.js');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const launcher = join(root,'打开测试项目.command');
writeFileSync(launcher, '#!/bin/sh\nexec /usr/bin/env -u ELECTRON_RUN_AS_NODE -u ELECTRON_RENDERER_URL -u ROC_SMOKE -u ROC_SMOKE_API_KEY ROC_DATA_ROOT=' +
  quote(dataRoot) + ' ' + quote(executable) + ' ' + quote(entry) + ' ' + quote('--user-data-dir='+join(root,'chromium')) + '\n', {flag:'wx',mode:0o700});
writeFileSync(join(root,'README.md'), '# 公开论文 RAG 测试项目\n\n双击 `打开测试项目.command`，在 Roc 门户选择“公开论文 RAG 验收（45 篇）”。\n\n'+
  '包含 45 篇公开 PDF、429 页、45 个 Evidence 和 45 个 Wiki 历史版本；原始 PDF 位于 `data/research-library/sources/`。\n\n'+
  '数据和 Chromium 配置保存在本目录，使用当前仓库的 Electron 构建。原来的 Roc 数据库没有迁移。\n\n'+
  '复用已验证的解析结果，不重复 OCR。科研向量为受控工程数据。请先运行仓库的 verify-scientific-desktop.mjs；它只在本副本内安装公开的测试凭据，并以不可达的 fixture.invalid 端点验证关键词降级。准备步骤本身不安装凭据，直接检索会报告配置缺失。\n\n'+
  '完成验收后可通过启动入口浏览与检索。测试数据不能用于宣称语义检索或科研问答质量提升。\n', {flag:'wx'});
writeFileSync(join(workspace,'README.md'),'# 公开论文 RAG 验收\n\n请在 Roc 文献库浏览 45 篇公开论文。数据说明与启动入口位于上级目录。\n',{flag:'wx'});
for (const item of copies.filter(p => p.source.startsWith(report.root+'/'))) {
  assert.equal(hash(item.source),item.sha256);
  assert.equal(statSync(item.source,{bigint:true}).mtimeNs.toString(),item.mtimeNs);
}
const receipt = {version:1,root:realpathSync(root),dataRoot,libraryRoot,workspace,database,projectId:run.projectId,
  foreignProjectId:run.foreignProjectId,sourceReport:pinned.report,sourceRun:{path:join(report.root,'run.json'),sha256:hash(join(report.root,'run.json'))},
  copies,preparedHash:hash(join(root,'prepared.db')),launcher:{path:launcher,sha256:hash(launcher)},
  quality:{recall:null,answerCorrectness:null,realProjectAcceptance:null},createdAt:new Date().toISOString()};
writeFileSync(join(root,'project-receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({root,projectId:run.projectId,files:copies.length}));
