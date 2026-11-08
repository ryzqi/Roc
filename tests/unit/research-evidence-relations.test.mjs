import {applyOfflineResearchSchema} from './fixtures/offline-migration.mjs';
import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import Database from 'better-sqlite3';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';

let api;
before(async()=>{api=await loadResearchTestApi();});
after(()=>api?.dispose());
const hash=value=>createHash('sha256').update(value).digest('hex');
const user={kind:'user',id:'synthetic-local-reviewer'};

function scene() {
  const f=createResearchFixture(api,'reading');
  f.repository.knowledge.upsertFromSource({id:'relation-source',projectId:f.project.id,sourceType:'experiment',
    sourceId:'synthetic-measurement',title:'Measured synthetic result',content:'Group A mean is 2.',
    chunks:[{content:'Group A mean is 2.',locator:'results.csv:group:A'}],embeddingPolicy:'none'});
  f.evidence=f.repository.evidence.capture({projectId:f.project.id,chunkId:'relation-source:chunk:0'});
  f.artifact=f.repository.createArtifact({projectId:f.project.id,stage:'reading',kind:'reading_notes',
    title:'Relation hypothesis',path:null});
  f.claim=f.repository.evidence.createClaim({projectId:f.project.id,artifactId:f.artifact.id,
    subjectType:'claim',content:'A synthetic claim about the group.',status:'hypothesis',evidenceIds:[f.evidence.id]});
  f.relations=f.repository.evidence.relations;
  f.request={projectId:f.project.id,claimId:f.claim.id,expectedClaimVersion:f.claim.version,
    evidenceId:f.evidence.id,expectedSourceDigest:api.relationSourceDigest(f.repository.evidence.inspectEvidence(f.evidence.id,f.project.id)),
    kind:'supports',condition:null,supersedesRelationId:null};
  f.propose=(overrides={})=>f.relations.propose({...f.request,...overrides},{kind:'agent',id:f.run.id});
  f.review=(relation,overrides={})=>f.relations.review({projectId:f.project.id,relationId:relation.id,
    expectedVersion:relation.version,expectedClaimVersion:relation.claimVersion,expectedSourceDigest:relation.sourceDigest,
    decision:'confirm',note:'Synthetic human-review test seam.',...overrides},user);
  return f;
}

test('agent can only propose exact versions; explicit human confirm records identity and history without promoting the claim',()=>{
  const f=scene();
  try {
    const originalSnapshot=f.repository.inspectArtifact({projectId:f.project.id,artifactId:f.artifact.id,expectedVersion:null});
    const proposed=f.propose();
    const proposedSnapshot=f.repository.inspectArtifact({projectId:f.project.id,artifactId:f.artifact.id,expectedVersion:originalSnapshot.snapshot.version});
    assert.equal(proposedSnapshot.status,'stale');
    assert.deepEqual(proposedSnapshot.snapshot.relations,[proposed]);
    assert.equal(proposedSnapshot.snapshot.artifact.updatedAt,originalSnapshot.snapshot.artifact.updatedAt);
    assert.equal(proposed.status,'proposed');assert.equal(proposed.reviewer,null);
    assert.deepEqual(proposed.proposer,{kind:'agent',id:f.run.id});
    assert.equal(proposed.source.evidence.excerpt,'Group A mean is 2.');
    assert.equal(proposed.source.sourceLocator,null);
    assert.throws(()=>f.relations.review({projectId:f.project.id,relationId:proposed.id,expectedVersion:1,
      expectedClaimVersion:1,expectedSourceDigest:proposed.sourceDigest,decision:'confirm',note:null},
      {kind:'agent',id:f.run.id}));
    assert.equal(f.relations.get(proposed.id,f.project.id).status,'proposed');
    const confirmed=f.review(proposed);
    assert.equal(f.repository.inspectArtifact({projectId:f.project.id,artifactId:f.artifact.id,
      expectedVersion:proposedSnapshot.snapshot.version}).status,'stale');
    assert.equal(confirmed.status,'confirmed');assert.equal(confirmed.version,2);
    assert.deepEqual(confirmed.reviewer,user);assert.ok(confirmed.reviewedAt);
    assert.equal(f.repository.evidence.getClaim(f.claim.id).status,'hypothesis');
    assert.deepEqual(f.relations.history(proposed.id,f.project.id).map(revision=>revision.event),['proposed','confirmed']);
    const before=f.db.prepare('SELECT total_changes()').pluck().get();
    assert.deepEqual(f.relations.list({projectId:f.project.id,claimId:f.claim.id}),[confirmed]);
    f.relations.assertCurrent(confirmed);
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),before);
    assert.throws(()=>f.review(proposed),/research_relation_version_conflict/u);
    assert.deepEqual(f.repository.runs.flushTaskEvents(),{pending:0,failed:0});
    const semantic=f.tasks.events({projectId:f.project.id,taskId:f.run.taskId,afterSequence:0,limit:200}).events.filter(event=>event.eventType==='claim_reviewed');
    assert.equal(semantic.length,1);assert.equal(semantic[0].payload.detail.status,'confirmed');
  }finally{f.close();}
});

test('contradiction and conditional qualification retain scientific meaning and rejection is an explicit reviewed fact',()=>{
  const f=scene();
  try {
    const contradicts=f.propose({kind:'contradicts'});
    const rejected=f.review(contradicts,{decision:'reject',note:'The synthetic excerpt does not contradict this claim.'});
    assert.equal(rejected.kind,'contradicts');assert.equal(rejected.status,'rejected');
    const qualifies=f.propose({kind:'qualifies',condition:'Only for the captured synthetic sample.'});
    assert.equal(f.review(qualifies).condition,'Only for the captured synthetic sample.');
    assert.throws(()=>f.propose({kind:'qualifies'}));
    assert.equal(f.propose({kind:'depends_on'}).status,'proposed');
  }finally{f.close();}
});

test('artifact inspection includes relation endpoints beyond the old claim evidenceIds with current invalidation and no writes',()=>{
  const f=scene();
  try {
    f.repository.knowledge.upsertFromSource({id:'additional-relation-source',projectId:f.project.id,
      sourceType:'experiment',sourceId:'synthetic-additional-source',title:'Additional synthetic source',
      content:'An additional source.',chunks:[{content:'An additional source.',locator:'extra.csv:row:1'}],embeddingPolicy:'none'});
    const evidence=f.repository.evidence.capture({projectId:f.project.id,chunkId:'additional-relation-source:chunk:0'});
    const relation=f.propose({evidenceId:evidence.id,
      expectedSourceDigest:api.relationSourceDigest(f.repository.evidence.inspectEvidence(evidence.id,f.project.id))});
    f.review(relation);
    const before=f.db.prepare('SELECT total_changes()').pluck().get();
    const first=f.repository.inspectArtifact({projectId:f.project.id,artifactId:f.artifact.id,expectedVersion:null});
    assert.deepEqual(first.snapshot.evidence.map(source=>source.evidence.id),[f.evidence.id,evidence.id]);
    assert.deepEqual(first.snapshot.claims[0].evidenceIds,[f.evidence.id]);
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),before);
    f.repository.evidence.invalidateChunksOf('additional-relation-source');
    const after=f.db.prepare('SELECT total_changes()').pluck().get();
    const changed=f.repository.inspectArtifact({projectId:f.project.id,artifactId:f.artifact.id,expectedVersion:first.snapshot.version});
    assert.equal(changed.status,'stale');
    assert.equal(changed.snapshot.evidence[1].referenceStatus,'superseded');
    assert.equal(changed.snapshot.relations[0].status,'invalidated');
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),after);
    assert.deepEqual(f.repository.runs.flushTaskEvents(),{pending:0,failed:0});
    const semantic=f.tasks.events({projectId:f.project.id,taskId:f.run.taskId,afterSequence:0,limit:200}).events;
    assert.equal(semantic.filter(event=>event.eventType==='source_invalidated').length,1);
  }finally{f.close();}
});

test('waiting at the original gate permits only human relation metadata, keeps body editing locked and refuses inactive immutable drafts',()=>{
  const f=scene();
  try {
    f.db.prepare("UPDATE research_stage_states SET status='waiting_approval' WHERE project_id=? AND stage='reading'").run(f.project.id);
    assert.throws(()=>f.repository.evidence.updateClaim({id:f.claim.id,expectedVersion:1,content:'Should remain locked.',
      status:'hypothesis',evidenceIds:[f.evidence.id]}),/research_stage_not_editable/u);
    assert.throws(()=>f.propose(),/research_stage_not_editable/u);
    const proposed=f.relations.propose(f.request,user);
    const confirmed=f.review(proposed);
    assert.equal(confirmed.status,'confirmed');
    assert.equal(f.repository.evidence.getClaim(f.claim.id).content,f.claim.content);
    assert.equal(f.repository.getArtifact(f.artifact.id).status,'draft');
    const pending=f.relations.propose({...f.request,kind:'contradicts'},user);
    f.db.prepare("UPDATE research_projects SET current_stage='ideation' WHERE id=?").run(f.project.id);
    assert.throws(()=>f.review(pending),/research_artifact_stage_inactive/u);
    f.db.prepare("UPDATE research_projects SET current_stage='reading',status='archived' WHERE id=?").run(f.project.id);
    assert.throws(()=>f.review(pending),/research_project_archived/u);
    f.db.prepare("UPDATE research_projects SET status='active' WHERE id=?").run(f.project.id);
    f.db.prepare("UPDATE research_artifacts SET status='approved' WHERE id=?").run(f.artifact.id);
    assert.throws(()=>f.review(pending),/research_artifact_immutable/u);
  }finally{f.close();}
});

test('foreign missing stale source and unbound agent proposals refuse before any relation or review write',()=>{
  const f=scene();
  try {
    const other=f.repository.createProject({title:'Other relation project',description:'Isolation',workspacePath:'/tmp/other-relation-project'});
    assert.throws(()=>f.propose({projectId:other.id}),/research_relation_project_mismatch/u);
    assert.throws(()=>f.propose({expectedClaimVersion:2}),/research_relation_claim_changed/u);
    assert.throws(()=>f.propose({expectedSourceDigest:hash('other version')}),/research_relation_source_changed/u);
    assert.throws(()=>f.propose({evidenceId:'missing'}),/research_evidence_not_found/u);
    assert.throws(()=>f.relations.propose(f.request,{kind:'agent',id:'missing-run'}),/research_relation_proposer_invalid/u);
    assert.deepEqual(f.relations.list({projectId:f.project.id,claimId:null}),[]);
    const proposed=f.propose();
    assert.throws(()=>f.relations.get(proposed.id,other.id),/research_relation_project_mismatch/u);
    assert.throws(()=>f.review(proposed,{expectedSourceDigest:hash('stale review')}),/research_relation_source_changed/u);
    assert.equal(f.relations.get(proposed.id,f.project.id).status,'proposed');
  }finally{f.close();}
});

test('claim edit invalidates active relation decisions transactionally and preserves the originally reviewed claim source and reviewer',()=>{
  const f=scene();
  try {
    const confirmed=f.review(f.propose());
    const rejected=f.review(f.propose({kind:'contradicts'}),{decision:'reject'});
    const updated=f.repository.evidence.updateClaim({id:f.claim.id,expectedVersion:1,content:'A revised scientific hypothesis.',
      status:'hypothesis',evidenceIds:[f.evidence.id]});
    assert.equal(updated.version,2);
    const invalid=f.relations.get(confirmed.id,f.project.id);
    assert.equal(invalid.status,'invalidated');assert.equal(invalid.invalidatedReason,'claim_changed');
    assert.deepEqual(invalid.reviewer,user);assert.equal(invalid.claimVersion,1);
    assert.equal(invalid.claimHash,api.relationClaimHash(f.claim));
    assert.equal(f.relations.get(rejected.id,f.project.id).status,'rejected');
    assert.throws(()=>f.relations.assertCurrent(invalid),/research_relation_claim_changed/u);
    assert.equal(f.relations.history(confirmed.id,f.project.id).at(-1).actor.kind,'system');
  }finally{f.close();}
});

test('same-version underlying content or source changes refuse the captured review, and damaged saved snapshots remain errors',()=>{
  const f=scene();
  try {
    const proposed=f.propose();
    f.db.prepare('UPDATE research_claims SET content=? WHERE id=?').run('Changed without a version increment.',f.claim.id);
    assert.throws(()=>f.review(proposed),/research_relation_claim_changed/u);
    f.db.prepare('UPDATE research_claims SET content=? WHERE id=?').run(f.claim.content,f.claim.id);
    f.db.prepare('UPDATE research_evidence SET source_version=? WHERE id=?').run('changed-source-version',f.evidence.id);
    assert.throws(()=>f.review(proposed),/research_relation_source_changed/u);
    assert.equal(f.relations.get(proposed.id,f.project.id).status,'proposed');
    f.db.prepare(`UPDATE research_evidence_relations
      SET snapshot_json=json_set(snapshot_json,'$.source.evidence.excerpt','Corrupted saved excerpt') WHERE id=?`).run(proposed.id);
    assert.throws(()=>f.relations.get(proposed.id,f.project.id),/research_relation_snapshot_invalid/u);
    assert.throws(()=>f.relations.list({projectId:f.project.id,claimId:f.claim.id}),/research_relation_snapshot_invalid/u);
  }finally{f.close();}
});

test('source invalidation withdraws active review while retaining its excerpt and every previous revision',()=>{
  const f=scene();
  try {
    const confirmed=f.review(f.propose());
    assert.equal(f.repository.evidence.invalidateChunksOf('relation-source'),1);
    const invalid=f.relations.get(confirmed.id,f.project.id);
    assert.equal(invalid.status,'invalidated');assert.equal(invalid.invalidatedReason,'evidence_invalidated');
    assert.equal(invalid.source.referenceStatus,'recorded');
    assert.equal(invalid.source.evidence.excerpt,'Group A mean is 2.');
    assert.throws(()=>f.propose(),/research_relation_source_invalidated/u);
    assert.throws(()=>f.relations.assertCurrent(invalid),/research_relation_source_invalidated/u);
    assert.equal(f.relations.history(confirmed.id,f.project.id).length,3);
    assert.throws(()=>f.relations.invalidateEvidence(f.evidence.id),/research_relation_transaction_required/u);
  }finally{f.close();}
});

test('a superseding proposal changes no previous decision until explicit confirmation; replacement and history share one commit',()=>{
  const f=scene();
  try {
    const original=f.review(f.propose());
    const replacement=f.propose({kind:'supersedes',supersedesRelationId:original.id});
    assert.equal(f.relations.get(original.id,f.project.id).status,'confirmed');
    const accepted=f.review(replacement);
    assert.equal(accepted.kind,'supersedes');assert.equal(accepted.status,'confirmed');
    assert.equal(f.relations.get(original.id,f.project.id).invalidatedReason,'superseded');
    assert.deepEqual(f.relations.history(original.id,f.project.id).map(revision=>revision.event),['proposed','confirmed','invalidated']);
    assert.throws(()=>f.propose({kind:'supersedes',supersedesRelationId:original.id}),/research_relation_supersedes_invalid/u);
  }finally{f.close();}
});

test('history insertion failure rolls back the decision and a claim/source invalidation together with its writer',()=>{
  const f=scene();
  try {
    const proposal=f.propose();
    f.db.exec(`CREATE TRIGGER reject_relation_revision BEFORE INSERT ON research_evidence_relation_revisions
      WHEN NEW.version>1 BEGIN SELECT RAISE(ABORT,'synthetic_relation_history_failure'); END`);
    assert.throws(()=>f.review(proposal),/synthetic_relation_history_failure/u);
    assert.equal(f.relations.get(proposal.id,f.project.id).status,'proposed');
    assert.throws(()=>f.repository.evidence.updateClaim({id:f.claim.id,expectedVersion:1,
      content:'Would fail to preserve history.',status:'hypothesis',evidenceIds:[f.evidence.id]}),/synthetic_relation_history_failure/u);
    assert.equal(f.repository.evidence.getClaim(f.claim.id).version,1);
    assert.throws(()=>f.repository.evidence.invalidateChunksOf('relation-source'),/synthetic_relation_history_failure/u);
    assert.equal(f.repository.evidence.inspectEvidence(f.evidence.id,f.project.id).referenceStatus,'recorded');
    assert.equal(f.relations.history(proposal.id,f.project.id).length,1);
  }finally{f.close();}
});

test('20 to 21 preserves raw claim state and creates only explicitly unreviewed historical associations',()=>{
  const db=new Database(':memory:');db.pragma('foreign_keys=ON');
  const agentDb=new Database(':memory:');
  try {
    api.applyDatabaseMigrations(db,{dbName:'plugin:@roc/plugin-research',migrations:api.researchMigrations.filter(m=>m.version<=20)});
    api.applyDatabaseMigrations(agentDb,{dbName:'agent',migrations:api.agentMigrations});
    const timestamp='2026-11-04T00:00:00.000Z',repository=new api.ResearchRepository(db,new api.ResearchTaskRepository(agentDb,()=>timestamp),()=>timestamp);
    const project=repository.createProject({title:'Historical relation',description:'Migration fixture',workspacePath:'/tmp/historical-relation'});
    const artifact=repository.createArtifact({projectId:project.id,stage:'discovery',kind:'search_strategy',title:'Historical artifact',path:null});
    db.prepare(`INSERT INTO research_evidence (id,project_id,document_id,chunk_id,source_type,source_id,source_version,title,locator,excerpt,content_hash,created_at)
      VALUES ('historical-source',?,'historical-doc','historical:chunk:0','file','recorded-file','v1','Old result','p1',?,?,?)`)
      .run(project.id,'Old retained result.',hash('Old retained result.'),timestamp);
    db.prepare(`INSERT INTO research_claims (id,project_id,artifact_id,subject_type,content,status,evidence_ids_json,version,created_at,updated_at)
      VALUES ('historical-claim',?,?,'claim','Saved old status','supported','[\"historical-source\"]',3,?,?)`)
      .run(project.id,artifact.id,timestamp,timestamp);
    const claimsBefore=db.prepare('SELECT * FROM research_claims').all();
    applyOfflineResearchSchema(api, db,()=>timestamp);
    assert.deepEqual(db.prepare('SELECT * FROM research_claims').all(),claimsBefore);
    const [historical]=repository.evidence.relations.list({projectId:project.id,claimId:'historical-claim'});
    assert.equal(historical.kind,'historical');assert.equal(historical.status,'historical');assert.equal(historical.claimVersion,3);
    assert.equal(historical.proposer,null);assert.equal(historical.reviewer,null);assert.equal(historical.reviewedAt,null);
    assert.equal(repository.evidence.relations.history(historical.id,project.id)[0].actor,null);
    const changes=db.prepare('SELECT total_changes()').pluck().get();
    assert.throws(()=>repository.evidence.assertReviewedSupport(repository.evidence.getClaim('historical-claim')),
      error=>error.code==='research_relation_review_required');
    assert.equal(db.prepare('SELECT total_changes()').pluck().get(),changes);
    const before=db.prepare('SELECT total_changes()').pluck().get();applyOfflineResearchSchema(api, db,()=>timestamp);
    assert.equal(db.prepare('SELECT total_changes()').pluck().get(),before);
  }finally{db.close();agentDb.close();}
});

test('a dangling historical association aborts the migration and keeps the original DB20 data and ledger',()=>{
  const db=new Database(':memory:');db.pragma('foreign_keys=ON');
  const agentDb=new Database(':memory:');
  try {
    api.applyDatabaseMigrations(db,{dbName:'plugin:@roc/plugin-research',migrations:api.researchMigrations.filter(m=>m.version<=20)});
    api.applyDatabaseMigrations(agentDb,{dbName:'agent',migrations:api.agentMigrations});
    const timestamp='2026-11-04T00:00:00.000Z',repository=new api.ResearchRepository(db,new api.ResearchTaskRepository(agentDb,()=>timestamp),()=>timestamp);
    const project=repository.createProject({title:'Missing historical source',description:'Migration refusal',workspacePath:'/tmp/dangling-relation'});
    const artifact=repository.createArtifact({projectId:project.id,stage:'discovery',kind:'search_strategy',title:'Historical artifact',path:null});
    db.prepare(`INSERT INTO research_claims (id,project_id,artifact_id,subject_type,content,status,evidence_ids_json,version,created_at,updated_at)
      VALUES ('dangling-claim',?,?,'claim','Retained original claim','pending','[\"missing-evidence\"]',1,?,?)`)
      .run(project.id,artifact.id,timestamp,timestamp);
    const before=db.prepare('SELECT * FROM research_claims').all();
    assert.throws(()=>applyOfflineResearchSchema(api, db,()=>timestamp),/research_relation_historical_endpoint_missing/u);
    assert.deepEqual(db.prepare('SELECT * FROM research_claims').all(),before);
    assert.equal(db.prepare('SELECT current_version FROM schema_metadata').pluck().get(),20);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='research_evidence_relations'").get(),undefined);
  }finally{db.close();agentDb.close();}
});

test('Wiki snapshot carries current source and relation review without promoting a claim or writing on read',()=>{
  const f=scene();
  try {
    const supported=f.repository.evidence.updateClaim({id:f.claim.id,expectedVersion:1,content:f.claim.content,
      status:'supported',evidenceIds:[f.evidence.id]});
    f.request.expectedClaimVersion=supported.version;
    const snapshot=()=>f.repository.evidence.wikiSnapshot(f.project.id);
    assert.equal(snapshot().claims[0].status,'supported');
    assert.deepEqual(snapshot().relations,[]);
    const proposed=f.propose();
    assert.equal(snapshot().relations[0].status,'proposed');
    f.review(proposed);
    assert.equal(snapshot().relations[0].status,'confirmed');
    f.repository.evidence.invalidateChunksOf('relation-source');
    const before=f.db.prepare('SELECT total_changes()').pluck().get();
    const stale=snapshot();
    assert.equal(stale.claims[0].status,'supported');
    assert.equal(stale.sources[0].referenceStatus,'superseded');
    assert.equal(stale.sources[0].evidence.excerpt,f.evidence.excerpt);
    assert.equal(stale.relations[0].status,'invalidated');
    assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(),before);
    f.db.prepare('UPDATE research_evidence SET excerpt=? WHERE id=?').run('Corrupted',f.evidence.id);
    assert.throws(snapshot,/research_evidence_integrity_invalid/u);
  } finally {f.close();}
});
