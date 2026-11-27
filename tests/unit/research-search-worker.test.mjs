import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {statSync} from 'node:fs';
import {performance} from 'node:perf_hooks';
import Database from 'better-sqlite3';
import {loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api, workerUrl;
before(async () => {
  api = await loadResearchTestApi();
  const directory = dirname(api.modulePath);
  // This unit bundles current worker source into the fixture only. Production dist stays untouched.
  const outfile = join(directory, 'research-query-worker.js');
  await build({entryPoints:['src/main/workers/research-query-worker.ts'],outfile,bundle:true,
    format:'esm',platform:'node',packages:'external',loader:{'.c':'text'},logLevel:'silent'});
  await writeFile(join(directory, 'package.json'), JSON.stringify({type:'module'}));
  workerUrl = pathToFileURL(outfile);
});
after(() => api?.dispose());

test('source-built readonly Worker and Main share tolerant lexical results, boundaries and original receipt identities', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'roc-source-search-worker-'));
  const path = join(directory, 'research.sqlite'), db = new Database(path);
  const now = () => '2026-11-24T00:00:00.000Z';
  let client;
  try {
    db.pragma('foreign_keys=ON'); db.pragma('journal_mode=WAL');
    api.applyResearchDatabaseSchema(db);
    api.loadResearchVectorExtension(db);
    for (const id of ['a','b']) db.prepare(`INSERT INTO research_projects
      (id,title,description,status,current_stage,created_at,updated_at) VALUES (?,?,'','active','reading',?,?)`).run(id,id,now(),now());
    const knowledge = new api.ResearchKnowledgeRepository(db, () => {}, now);
    for (let index = 0; index < 1200; index++) {
      const id = `source-${index}`, content = `Original filler ${index} 中文方法`;
      knowledge.upsertFromSource({id,projectId:index % 2 ? 'a' : null,sourceType:'file',sourceId:`${id}.md`,title:`Original ${index}`,
        content,chunks:[{content,locator:`original:page:${index}`}],embeddingPolicy:'none'});
    }
    const original = 'Multi‑Agent 注意力機制与重慶绿色网络。';
    const source = {id:'tolerant',projectId:'a',sourceType:'file',sourceId:'original.md',title:'Original tolerant source',
      content:original,chunks:[{content:original,locator:'original:page:8'}],embeddingPolicy:'none'};
    knowledge.upsertFromSource(source);
    knowledge.upsertFromSource({...source,id:'foreign-tolerant',projectId:'b'});
    const file = statSync(path,{bigint:true});
    client = new api.ResearchQueryClient({database:{path,device:String(file.dev),inode:String(file.ino),
      schema:Number(db.pragma('schema_version',{simple:true}))},workerUrl,now,idleMs:10_000});
    const beforeChanges = Number(db.prepare('SELECT total_changes()').pluck().get());
    const started = performance.now();
    for (const query of ['multiagent', '注意力机制', 'zhu yi li', 'chongqing']) {
      const input = {request:{query,projectId:'a',limit:10,candidateLimit:50,rerank:'none',embeddingConfigId:null},vector:null};
      const expected = knowledge.searchKnowledge(input), actual = await client.search(input);
      assert.equal(JSON.stringify(actual), JSON.stringify(expected), query);
      assert.ok(actual.hits.some(hit => hit.documentId === 'tolerant' && hit.content === original && hit.locator === 'original:page:8'), query);
      assert.ok(actual.hits.every(hit => hit.documentId !== 'foreign-tolerant'), query);
      knowledge.assertSearchCurrent(actual);
    }
    assert.equal(client.snapshot().starts, 1);
    assert.equal(Number(db.prepare('SELECT total_changes()').pluck().get()), beforeChanges);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 10_000, `1202-source Main/Worker tolerance took ${elapsed.toFixed(1)}ms`);
    t.diagnostic(`1202 original sources; four current-source Main/readonly Worker pairs: ${elapsed.toFixed(1)}ms`);
  } finally {
    await client?.shutdown(); db.close(); await rm(directory,{recursive:true,force:true});
  }
});
