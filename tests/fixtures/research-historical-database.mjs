import Database from 'better-sqlite3';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {resolve} from 'node:path';
import {historicalSchema} from '../../scripts/database/research-migration-lib.mjs';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
const {initializeDatabaseSchema} = await importTypeScriptModule('src/main/infrastructure/database-schema.ts',
  {platform:'node', external:['better-sqlite3'], tempDir:resolve('.runtime/tmp')});

export function seedHistoricalResearch(path, version) {
  const db = new Database(path);
  initializeDatabaseSchema(db, {dbName: 'plugin:@roc/plugin-research', schema: historicalSchema(version)});
  db.exec(`INSERT INTO research_projects(id,title,description,status,current_stage,created_at,updated_at)
    VALUES('p','历史科研项目','原始描述','paused','reading','old','old');
    INSERT INTO research_index_projects VALUES('p',
      '{"kinds":["markdown","latex","bibliography","csv","pdf","image"],"include":["**/*"],"exclude":[],"watch":false,"paused":true,"embeddingConfigId":null}',
      1,1,NULL,NULL,0,'idle',NULL,NULL,NULL,'none',0,0,0);
    INSERT INTO research_artifacts VALUES('a','p','writing','draft','历史稿件',NULL,'draft','old','old');
    INSERT INTO research_knowledge_documents VALUES('d','p','file','source.pdf','historicaltoken','原始正文',
      '{"type":"project-index","fileId":"f","sourceHash":"original","parserKey":"old"}','hash','old');
    INSERT INTO research_knowledge_chunks(rowid,id,document_id,project_id,chunk_index,content,locator,content_hash,created_at)
      VALUES(987654321,'c','d','p',0,'historicaltoken 原始证据','page:3','hash','old');
    INSERT INTO research_knowledge_embeddings VALUES('c','old-space',2,X'0000803F00000040','old');
    INSERT INTO research_knowledge_keywords(rowid,content,title) VALUES(987654321,'historicaltoken','historicaltoken');
    INSERT INTO research_evidence VALUES('e','p','d','c','file','source.pdf','old-source','历史证据',
      'page:3','原文摘录','hash','old',NULL);
    INSERT INTO research_evidence_source_metadata VALUES('e','{"fileId":"f","parseId":"old-parse"}');
    INSERT INTO research_evidence_source_locators VALUES('e','{"page":3,"bbox":[1,2,3,4]}','old');
    INSERT INTO research_claims VALUES('claim','p','a','claim','保留假设','hypothesis','["e"]','{}',2,'old','old');
    INSERT INTO research_claim_revisions VALUES('claim',1,'{"content":"初始假设"}');
    INSERT INTO research_evidence_relations VALUES('relation','p','claim','e',2,'qualifies','confirmed',3,
      '{"condition":"原始条件"}','old','old');
    INSERT INTO research_evidence_relation_revisions VALUES('relation',2,'{"status":"proposed"}');
    INSERT INTO research_paper_cards VALUES('d','d','v1','{"raw":"旧卡片"}','generation','ready',NULL);
    INSERT INTO research_wiki_pages VALUES('wiki','p','topic','历史Wiki',NULL,'{}',2,'old');
    INSERT INTO research_wiki_revisions VALUES('wiki',1,'{"body":"第一版 不可变原文"}');
    INSERT INTO research_wiki_revisions VALUES('wiki',2,'{"body":"第二版 原始证据"}');
    INSERT INTO research_wiki_sections VALUES(9007199254740993,'wiki',2,'section','historicaltoken',
      'historicaltoken 原文','输入','hash');
    INSERT INTO research_wiki_dependencies VALUES('wiki','evidence','e');
    INSERT INTO research_wiki_jobs VALUES('wiki','job-generation','failed','保留错误');`);
  return db;
}

export function seedHistoricalPaperAssets(db, root) {
  const pdf = readFileSync(new URL('../fixtures/research-workflow/source.pdf', import.meta.url));
  const pdfPath = join(root, 'project-files/source.pdf');
  const artifactPath = join(root, 'project-files/artifacts/structured.json');
  const artifact = Buffer.from('{"kind":"synthetic-paper-ir","source":"source.pdf","page":1}\n');
  mkdirSync(dirname(pdfPath), {recursive:true}); mkdirSync(dirname(artifactPath), {recursive:true});
  writeFileSync(pdfPath, pdf, {flag:'wx'}); writeFileSync(artifactPath, artifact, {flag:'wx'});
  const pdfHash = createHash('sha256').update(pdf).digest('hex');
  const artifactHash = createHash('sha256').update(artifact).digest('hex');
  db.exec(`INSERT INTO research_library(id,identity_key,metadata_json,bibliography_json,sources_json,revision,archived,created_at,updated_at)
    VALUES('historical-paper','fixture:synthetic-paper','{}','{}','{}',1,0,'old','old');
    INSERT INTO research_documents(id,library_item_id,filename,media_type,source_path,source_hash,size,status,
      current_parse_id,active_parse_id,error,created_at,updated_at)
      VALUES('d','historical-paper','source.pdf','application/pdf','project-files/source.pdf',
        '${pdfHash}',${pdf.length},'ready','old-parse',NULL,NULL,'old','old');
    INSERT INTO research_document_parses(id,document_id,status,data_json,error,created_at,finished_at,coordinate_snapshot_hash)
      VALUES('old-parse','d','ready',
        '{"outputPath":"project-files","artifacts":{"structuredContent":"artifacts/structured.json"}}',NULL,'old','old','coordinates-hash');
    INSERT INTO research_document_parse_coordinates(parse_id,document_id,snapshot_json,snapshot_hash,created_at)
      VALUES('old-parse','d','{"artifactPath":"artifacts/structured.json","page":1}',
        'coordinates-hash','old');
    INSERT INTO research_artifacts(id,project_id,stage,kind,title,path,status,created_at,updated_at)
      VALUES('parse-artifact','p','reading','parsed_pdf','Synthetic parsed PDF','project-files/artifacts/structured.json',
        'approved','old','old');
    UPDATE research_evidence_source_locators SET locator_json=
      '{"documentId":"d","parseId":"old-parse","page":3,"bbox":[1,2,3,4],"artifactPath":"project-files/artifacts/structured.json"}'
      WHERE evidence_id='e';`);
  return {pdfPath, pdfHash, pdfSize:pdf.length, artifactPath, artifactHash, artifactSize:artifact.length};
}
