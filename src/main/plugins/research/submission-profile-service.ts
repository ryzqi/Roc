import {randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import {
  researchSubmissionProfileSaveSchema, researchSubmissionProfileGetSchema, researchSubmissionProfileListSchema, researchSubmissionProfileCompareSchema,
  researchSubmissionProfileReceiptSchema, type ResearchSubmissionProfileSave, type ResearchSubmissionProfileGet,
  type ResearchSubmissionProfileList, type ResearchSubmissionProfileListResult, type ResearchSubmissionProfileReceipt,
  type ResearchSubmissionProfileCompare, type ResearchSubmissionProfileDifference
} from '../../../shared/schemas/research-submission-profile';
import type {ResearchRepository} from './repository';
import {researchContentHash} from './research-files';
import {requireResearchHuman} from '../../services/research-human-context';

type Row = {id: string; project_id: string; profile_id: string; version: number; request_id: string; snapshot_json: string; snapshot_hash: string};
const digest = (value: unknown): string => researchContentHash(JSON.stringify(value));

export class ResearchSubmissionProfileService {
  constructor(private readonly db: Database, private readonly research: ResearchRepository, private readonly now: () => string) {}

  validateDraft(input: ResearchSubmissionProfileSave): string | null {
    const request = researchSubmissionProfileSaveSchema.parse(input);
    if (this.research.getProject(request.projectId).status === 'archived') throw new Error('research_project_archived');
    if (request.profileId === null) return null;
    const latest = this.db.prepare('SELECT * FROM research_submission_profiles WHERE profile_id=? ORDER BY version DESC LIMIT 1')
      .get(request.profileId) as Row | undefined;
    if (latest === undefined) throw new Error('research_submission_profile_not_found');
    const saved = this.read(latest);
    if (saved.snapshot.request.projectId !== request.projectId) throw new Error('research_submission_profile_project_mismatch');
    if (request.parent?.versionId !== saved.snapshot.id || request.parent.versionHash !== saved.snapshotHash) {
      throw new Error('research_submission_profile_parent_changed');
    }
    return saved.snapshotHash;
  }

  save(input: ResearchSubmissionProfileSave): ResearchSubmissionProfileReceipt {
    const request = researchSubmissionProfileSaveSchema.parse(input);
    const actor = requireResearchHuman('research.submissionProfiles.save', request.projectId);
    return this.db.transaction(() => {
      if (this.research.getProject(request.projectId).status === 'archived') throw new Error('research_project_archived');
      const previous = this.db.prepare('SELECT * FROM research_submission_profiles WHERE project_id=? AND request_id=?')
        .get(request.projectId, request.requestId) as Row | undefined;
      if (previous !== undefined) {
        const saved = this.read(previous);
        if (saved.snapshot.requestHash !== digest(request) || saved.snapshot.actor.id !== actor.id) throw new Error('research_submission_profile_request_conflict');
        return saved;
      }
      this.validateDraft(request);
      const parent = request.parent === null ? null : this.get({projectId: request.projectId,
        versionId: request.parent.versionId, expectedHash: request.parent.versionHash});
      const snapshot = researchSubmissionProfileReceiptSchema.shape.snapshot.parse({schemaVersion: 1,
        id: `submission_profile_version_${randomUUID()}`, profileId: request.profileId ?? `submission_profile_${randomUUID()}`,
        version: parent === null ? 1 : parent.snapshot.version + 1, request, requestHash: digest(request), actor, recordedAt: this.now()});
      const json = JSON.stringify(snapshot), snapshotHash = researchContentHash(json);
      this.db.prepare(`INSERT INTO research_submission_profiles(id,project_id,profile_id,version,request_id,snapshot_json,snapshot_hash)
        VALUES (?,?,?,?,?,?,?)`).run(snapshot.id, request.projectId, snapshot.profileId, snapshot.version, request.requestId, json, snapshotHash);
      return {snapshot, snapshotHash};
    })();
  }

  get(input: ResearchSubmissionProfileGet): ResearchSubmissionProfileReceipt {
    const request = researchSubmissionProfileGetSchema.parse(input);
    this.research.getProject(request.projectId);
    const row = this.db.prepare('SELECT * FROM research_submission_profiles WHERE id=?').get(request.versionId) as Row | undefined;
    if (row === undefined) throw new Error('research_submission_profile_not_found');
    if (row.project_id !== request.projectId) throw new Error('research_submission_profile_project_mismatch');
    const saved = this.read(row);
    if (saved.snapshotHash !== request.expectedHash) throw new Error('research_submission_profile_hash_mismatch');
    return saved;
  }

  list(input: ResearchSubmissionProfileList): ResearchSubmissionProfileListResult {
    const request = researchSubmissionProfileListSchema.parse(input);
    this.research.getProject(request.projectId);
    const filter = `s.project_id=? AND NOT EXISTS (SELECT 1 FROM research_submission_profiles n
      WHERE n.profile_id=s.profile_id AND n.version>s.version)`;
    const rows = this.db.prepare(`SELECT * FROM research_submission_profiles s WHERE ${filter} ORDER BY rowid DESC LIMIT ? OFFSET ?`)
      .all(request.projectId, request.limit, request.offset) as Row[];
    const total = this.db.prepare(`SELECT count(*) FROM research_submission_profiles s WHERE ${filter}`).pluck().get(request.projectId) as number;
    return {items: rows.map(row => this.read(row)), total};
  }

  compare(input: ResearchSubmissionProfileCompare): ResearchSubmissionProfileDifference {
    const {projectId, left, right} = researchSubmissionProfileCompareSchema.parse(input);
    const before = this.get({projectId, ...left}).snapshot.request, after = this.get({projectId, ...right}).snapshot.request;
    const a = new Map(before.profile.rules.map(rule => [rule.id, rule])), b = new Map(after.profile.rules.map(rule => [rule.id, rule]));
    const keys = Object.keys(before.requirements) as ResearchSubmissionProfileDifference['changedRequirementKeys'];
    return {addedRuleIds: [...b.keys()].filter(id => !a.has(id)), removedRuleIds: [...a.keys()].filter(id => !b.has(id)),
      changedRuleIds: [...b.keys()].filter(id => a.has(id) && digest(a.get(id)) !== digest(b.get(id))),
      changedRequirementKeys: keys.filter(key => digest(before.requirements[key]) !== digest(after.requirements[key]))};
  }

  private read(row: Row): ResearchSubmissionProfileReceipt {
    const snapshot = researchSubmissionProfileReceiptSchema.shape.snapshot.parse(JSON.parse(row.snapshot_json));
    if (JSON.stringify(snapshot) !== row.snapshot_json || researchContentHash(row.snapshot_json) !== row.snapshot_hash ||
        snapshot.id !== row.id || snapshot.request.projectId !== row.project_id || snapshot.profileId !== row.profile_id ||
        snapshot.version !== row.version || snapshot.request.requestId !== row.request_id || snapshot.requestHash !== digest(snapshot.request) ||
        snapshot.version > 1 && snapshot.request.profileId !== snapshot.profileId) throw new Error('research_submission_profile_snapshot_invalid');
    const parent = snapshot.request.parent;
    if (parent === null) {
      if (snapshot.version !== 1) throw new Error('research_submission_profile_snapshot_invalid');
    } else {
      const before = this.db.prepare('SELECT * FROM research_submission_profiles WHERE id=?').get(parent.versionId) as Row | undefined;
      if (before === undefined || before.project_id !== row.project_id || before.profile_id !== row.profile_id ||
          before.version !== row.version - 1 || before.snapshot_hash !== parent.versionHash ||
          researchContentHash(before.snapshot_json) !== parent.versionHash) throw new Error('research_submission_profile_snapshot_invalid');
    }
    return {snapshot, snapshotHash: row.snapshot_hash};
  }
}
