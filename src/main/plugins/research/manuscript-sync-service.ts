import {lstat, open, unlink} from 'node:fs/promises';
import {dirname, relative} from 'node:path';
import type {Database} from 'better-sqlite3';
import {z} from 'zod';
import {
  researchManuscriptSyncApplySchema, researchManuscriptSyncAttachSchema, researchManuscriptSyncInspectSchema,
  researchManuscriptSyncInspectionSchema, type ResearchManuscriptSyncApply, type ResearchManuscriptSyncAttach,
  type ResearchManuscriptSyncInspect, type ResearchManuscriptSyncInspection
} from '../../../shared/schemas/research-manuscript-sync';
import {unknownExperiment} from '../../../shared/schemas/research-claim-comparison';
import type {ResearchArtifact, ResearchClaim, ResearchEvidence, ResearchExportBundle} from '../../../shared/types';
import {requireResearchHuman} from '../../services/research-human-context';
import {readBibtex, writeBibliography} from './bibliography';
import {manuscriptBibliographyEntry} from './manuscript-bibliography';
import type {BibliographyEntry} from './library-repository';
import {parseManuscriptWorkFile, renderManuscriptWorkFile} from './manuscript-sync-tex';
import {readResearchFile, researchAbsolutePath, researchContentHash, researchPath, researchRelativePath, researchWorkspace} from './research-files';
import type {ResearchRepository} from './repository';

const fileLimit = 1024 * 1024;
const layoutSchema = z.strictObject({
  anchored: z.boolean(), anchors: z.record(z.string(), z.string())
});
type Layout = z.infer<typeof layoutSchema>;
type Paths = NonNullable<ResearchManuscriptSyncInspection['binding']>;
type Change = ResearchManuscriptSyncInspection['changes'][number];
type Binding = Paths & {workspacePath: string; layout: Layout; parentArtifactId: string | null};
type Files = {tex: string; bib: string; hash: string};
type Receipt = {request_hash: string; actor_id: string; result_artifact_id: string};

const digest = (value: unknown): string => researchContentHash(JSON.stringify(value));
const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Workspace bytes are only applied through the structured manuscript and its existing claim history. */
export class ResearchManuscriptSyncService {
  constructor(private readonly db: Database, private readonly research: ResearchRepository, private readonly now: () => string) {}

  async inspect(input: ResearchManuscriptSyncInspect): Promise<ResearchManuscriptSyncInspection> {
    const scope = researchManuscriptSyncInspectSchema.parse(input);
    const {artifact} = this.scope(scope);
    const binding = this.binding(artifact.id);
    if (binding === null) return this.preview(scope, null, null);
    let files: Files;
    try {files = await this.read(scope.projectId, binding);}
    catch (error) {return this.preview(scope, binding, null, [message(error)]);}
    return this.preview(scope, binding, files);
  }

  async attach(input: ResearchManuscriptSyncAttach): Promise<ResearchManuscriptSyncInspection> {
    const request = researchManuscriptSyncAttachSchema.parse(input);
    const {projectId, artifactId, texPath, bibPath, expectedArtifactVersion, mode} = request;
    requireResearchHuman('research.manuscriptSync.attach', projectId);
    const scope = {projectId, artifactId};
    const {artifact, workspacePath} = this.scope(scope, true);
    if (workspacePath === null) throw new Error('research_project_workspace_required');
    this.assertUnbound(scope, expectedArtifactVersion, workspacePath);
    const bundle = this.research.manuscripts.inspectBundle(scope);
    const bibliographyName = bibName({texPath, bibPath});
    const layout: Layout = {anchored: true, anchors: Object.fromEntries(bundle.claims.map(claim => [claim.id, claim.id]))};
    const binding: Binding = {workspacePath, texPath, bibPath, layout, parentArtifactId: null};
    const root = await researchWorkspace(workspacePath);
    if (mode === 'existing') {
      const files = await this.read(projectId, binding);
      const source = parseManuscriptWorkFile(files.tex, bibliographyName);
      const anchors = source.flatMap(section => section.paragraphs.map(paragraph => paragraph.anchor));
      layout.anchored = anchors.some(value => value !== null);
      if (!layout.anchored && source.some((section, index) => section.title !== bundle.manuscript.sections[index]?.title)) {
        throw new Error('research_manuscript_sync_initial_sections_mismatch');
      }
      this.verifyShape(bundle, binding, source);
      return this.db.transaction(() => {
        this.assertUnbound(scope, expectedArtifactVersion, workspacePath);
        this.insertBinding(artifact.id, binding);
        return this.preview(scope, binding, files);
      })();
    }
    const entries = this.entries(bundle.evidence);
    const claims = new Map(bundle.claims.map(claim => [claim.id, claim]));
    const tex = renderManuscriptWorkFile(bundle.manuscript.sections.map(section => ({
      title: section.title, paragraphs: section.claimIds.map(claimId => {
        const claim = claims.get(claimId)!;
        return {anchor: claim.id, text: claim.content, citationKeys: this.citationKeys(claim.evidenceIds, bundle.projectId)};
      })
    })), bibliographyName);
    const bib = writeBibliography([...entries.values()], 'bibtex');
    const files = snapshotFiles(Buffer.from(tex), Buffer.from(bib));
    if (this.preview(scope, binding, files).status !== 'current') throw new Error('research_manuscript_sync_checkout_unsupported');
    const created: Array<{path: string; device: number; inode: number; hash: string | null}> = [];
    let result: ResearchManuscriptSyncInspection;
    try {
      for (const [path, text] of [[bibPath, bib], [texPath, tex]]) {
        if (dirname(path) !== '.') await researchPath(root, dirname(path));
        const handle = await open(researchAbsolutePath(root, path), 'wx', 0o600);
        try {
          const stat = await handle.stat();
          const file = {path, device: stat.dev, inode: stat.ino, hash: null as string | null};
          created.push(file);
          await handle.writeFile(text, 'utf8');
          await handle.sync();
          file.hash = researchContentHash(text);
        }
        finally {await handle.close();}
      }
      const written = await this.read(projectId, binding);
      if (written.hash !== files.hash) throw new Error('research_manuscript_sync_workspace_changed');
      result = this.db.transaction(() => {
        this.assertUnbound(scope, expectedArtifactVersion, workspacePath);
        this.insertBinding(artifact.id, binding);
        return this.preview(scope, binding, written);
      })();
    } catch (error) {
      for (const file of created) {
        try {
          const path = await researchPath(root, file.path);
          const stat = await lstat(path);
          if (stat.dev === file.device && stat.ino === file.inode && (file.hash === null ||
            researchContentHash(await readResearchFile(root, file.path, fileLimit)) === file.hash)) await unlink(path);
        } catch (cleanup) {if ((cleanup as NodeJS.ErrnoException).code !== 'ENOENT') throw cleanup;}
      }
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('research_manuscript_sync_path_exists');
      throw error;
    }
    return result;
  }

  async apply(input: ResearchManuscriptSyncApply): Promise<ResearchManuscriptSyncInspection> {
    const request = researchManuscriptSyncApplySchema.parse(input);
    const {projectId, artifactId, requestId} = request;
    const actor = requireResearchHuman('research.manuscriptSync.apply', projectId);
    const scope = {projectId, artifactId};
    this.scope(scope, true);
    const requestHash = digest(request);
    const replay = (): string | null => {
      const row = this.db.prepare(`SELECT request_hash,actor_id,result_artifact_id FROM research_manuscript_sync_applies
        WHERE project_id=? AND request_id=?`).get(projectId, requestId) as Receipt | undefined;
      if (row === undefined) return null;
      if (row.request_hash !== requestHash || row.actor_id !== actor.id) throw new Error('research_manuscript_sync_request_conflict');
      return row.result_artifact_id;
    };
    const previous = replay();
    if (previous !== null) return this.inspect({projectId, artifactId: previous});
    const binding = this.binding(artifactId);
    if (binding === null) throw new Error('research_manuscript_sync_binding_required');
    const files = await this.read(projectId, binding);
    const artifact = this.db.transaction(() => {
      const previous = replay();
      if (previous !== null) return previous;
      if (this.scope(scope, true).workspacePath !== binding.workspacePath || digest(this.binding(artifactId)) !== digest(binding)) {
        throw new Error('research_manuscript_sync_conflict');
      }
      const current = this.preview(scope, binding, files);
      if (current.previewHash !== request.expectedPreviewHash || !current.canApply) throw new Error('research_manuscript_sync_conflict');
      const bundle = this.research.manuscripts.inspectBundle(scope);
      const patches = new Map(current.changes.map(change => [change.id, change]));
      const selected = new Map<string, {patch: Change; evidenceIds: string[]}>();
      for (const choice of request.changes) {
        const patch = patches.get(choice.id);
        if (patch === undefined) throw new Error('research_manuscript_sync_patch_invalid');
        if (patch.kind === 'claim') this.assertCitations(choice.evidenceIds, patch.citationKeys, projectId);
        else if (choice.evidenceIds.length !== 0) throw new Error('research_manuscript_sync_patch_invalid');
        selected.set(patch.id, {patch, evidenceIds: choice.evidenceIds});
      }
      const result = this.applySelected(bundle, binding, selected);
      this.db.prepare(`INSERT INTO research_manuscript_sync_applies
        (project_id,request_id,source_artifact_id,result_artifact_id,request_hash,actor_id,source_hash,recorded_at)
        VALUES (?,?,?,?,?,?,?,?)`).run(projectId, requestId, artifactId, result, requestHash, actor.id, files.hash, this.now());
      return result;
    })();
    return this.inspect({projectId, artifactId: artifact});
  }

  async assertCurrent(projectId: string, artifactId: string): Promise<void> {
    this.scope({projectId, artifactId});
    if (this.binding(artifactId) === null) return;
    const current = await this.inspect({projectId, artifactId});
    if (current.status !== 'current') throw new Error('research_manuscript_sync_workspace_changed');
  }

  private preview(scope: ResearchManuscriptSyncInspect, binding: Binding | null, files: Files | null,
    issues: string[] = []): ResearchManuscriptSyncInspection {
    const {artifact} = this.scope(scope);
    const artifactVersion = this.research.inspectArtifact({...scope, expectedVersion: null}).snapshot.version;
    const changes: Change[] = [];
    if (binding !== null && files !== null) {
      try {changes.push(...this.diff(this.research.manuscripts.inspectBundle(scope), binding, files));}
      catch (error) {issues.push(message(error));}
    }
    const status = binding === null ? 'unbound' : issues.length > 0 ? 'conflict' : changes.length > 0 ? 'changed' : 'current';
    const canApply = status === 'changed' && this.canApply(artifact);
    return researchManuscriptSyncInspectionSchema.parse({...scope, artifactVersion, status, canApply,
      binding: binding === null ? null : {texPath: binding.texPath, bibPath: binding.bibPath}, changes, issues,
      previewHash: digest([scope, artifactVersion, binding, files?.hash ?? null, changes, issues, canApply])});
  }

  private diff(bundle: ResearchExportBundle, binding: Binding, files: Files): Change[] {
    const source = parseManuscriptWorkFile(files.tex, bibName(binding));
    this.verifyShape(bundle, binding, source);
    this.verifyBibliography(bundle, files.bib, source.flatMap(section => section.paragraphs.flatMap(paragraph => paragraph.citationKeys)));
    const claims = new Map(bundle.claims.map(claim => [claim.id, claim]));
    const changes: Change[] = [];
    for (const [index, section] of bundle.manuscript.sections.entries()) {
      const after = source[index];
      if (section.title !== after.title) changes.push({id: `section:${index}`, kind: 'section', label: section.title,
        before: section.title, after: after.title, claimId: null, evidenceIds: [], citationKeys: []});
      for (const [paragraphIndex, claimId] of section.claimIds.entries()) {
        const claim = claims.get(claimId)!;
        const paragraph = after.paragraphs[paragraphIndex];
        const material = claim.evidenceIds.map(id => ({id, key: manuscriptBibliographyEntry(this.research.evidence.getEvidence(id, bundle.projectId), this.research.library).citationKey}));
        const keys = [...new Set(material.map(item => item.key))];
        if (claim.content !== paragraph.text || !sameKeys(keys, paragraph.citationKeys)) {
          changes.push({id: `claim:${claimId}`, kind: 'claim', label: `${after.title} 第 ${paragraphIndex + 1} 段`,
            before: claim.content, after: paragraph.text, claimId, citationKeys: paragraph.citationKeys,
            evidenceIds: material.filter(item => paragraph.citationKeys.includes(item.key)).map(item => item.id)});
        }
      }
    }
    return changes;
  }

  private verifyShape(bundle: ResearchExportBundle, binding: Binding, source: ReturnType<typeof parseManuscriptWorkFile>): void {
    if (source.length !== bundle.manuscript.sections.length || bundle.manuscript.sections.some((section, index) =>
      source[index].paragraphs.length !== section.claimIds.length || source[index].paragraphs.some((paragraph, position) =>
        paragraph.anchor !== (binding.layout.anchored ? binding.layout.anchors[section.claimIds[position]] : null)))) {
      throw new Error('工作稿的小节、段落或锚点已变动，请在现有结构内修订。');
    }
  }

  private verifyBibliography(bundle: ResearchExportBundle, text: string, keys: string[]): void {
    const expected = this.entries(bundle.evidence);
    const entries = readBibtex(text);
    if (new Set(entries.map(entry => entry.citationKey)).size !== entries.length) throw new Error('工作稿的 BibTeX 文件包含重复引用键。');
    const observed = new Set(entries.map(entry => entry.citationKey));
    for (const key of keys) if (!observed.has(key)) throw new Error(`BibTeX 文件缺少引用键 ${key}。`);
    const canonicalEntries: BibliographyEntry[] = [];
    for (const entry of entries) {
      const key = entry.citationKey;
      let canonical = expected.get(key);
      if (canonical === undefined) {
        try {
          const record = key.startsWith('evidence_') ? this.research.evidence.getEvidence(key, bundle.projectId) : null;
          canonical = record === null ? this.research.library.resolveCitationKey(bundle.projectId, key).bibliography : manuscriptBibliographyEntry(record, this.research.library);
        } catch {throw new Error(`引用键 ${key} 没有可核对的项目书目。`);}
      }
      if (bibliographyIdentity(entry) !== bibliographyIdentity(canonical)) {
        throw new Error(`引用键 ${key} 的 BibTeX 内容与资料库不一致，请先核对来源。`);
      }
      canonicalEntries.push(canonical);
    }
    if (entries[0].preambles.length || canonicalEntries.some(entry => entry.preambles.length)) {
      const canonicalPreambles = readBibtex(writeBibliography(canonicalEntries, 'bibtex'))[0].preambles;
      if (digest(entries[0].preambles) !== digest(canonicalPreambles)) throw new Error('工作稿的 BibTeX 前导定义与资料库不一致。');
    }
  }

  private applySelected(bundle: ResearchExportBundle, binding: Binding,
    selected: Map<string, {patch: Change; evidenceIds: string[]}>): string {
    const old = this.research.getArtifact(bundle.artifactId);
    const fork = old.status === 'approved';
    const target = fork ? this.research.createArtifact({projectId: old.projectId, stage: 'revision', kind: 'manuscript',
      title: old.title, path: null}) : old;
    const claims = new Map(bundle.claims.map(claim => [claim.id, claim]));
    const anchors: Layout['anchors'] = {};
    const sections = bundle.manuscript.sections.map((section, index) => ({
      title: selected.get(`section:${index}`)?.patch.after ?? section.title,
      claimIds: section.claimIds.map(id => {
        const before = claims.get(id)!;
        const change = selected.get(`claim:${id}`);
        const after = this.applyClaim(before, target, change);
        anchors[after.id] = binding.layout.anchors[id];
        return after.id;
      })
    }));
    this.research.manuscripts.saveManuscript({artifactId: target.id, sections});
    if (fork) this.insertBinding(target.id, {...binding, layout: {...binding.layout, anchors}, parentArtifactId: old.id});
    return target.id;
  }

  private applyClaim(before: ResearchClaim, target: ResearchArtifact, change?: {patch: Change; evidenceIds: string[]}): ResearchClaim {
    if (before.artifactId === target.id && change === undefined) return before;
    const fields = {content: change?.patch.after ?? before.content, status: before.status,
      evidenceIds: change?.evidenceIds ?? before.evidenceIds, experiment: change === undefined ? before.experiment : unknownExperiment};
    if (before.artifactId === target.id) {
      return this.research.evidence.updateClaim({id: before.id, expectedVersion: before.version, ...fields});
    }
    return this.research.evidence.createClaim({projectId: target.projectId, artifactId: target.id, subjectType: before.subjectType, ...fields});
  }

  private assertCitations(ids: string[], keys: string[], projectId: string): void {
    if (!ids.length || !sameKeys(this.citationKeys(ids, projectId), keys)) throw new Error('research_manuscript_sync_evidence_mismatch');
  }

  private citationKeys(ids: string[], projectId: string): string[] {
    return [...new Set(ids.map(id => manuscriptBibliographyEntry(this.research.evidence.getEvidence(id, projectId), this.research.library).citationKey))];
  }

  private entries(evidence: ResearchEvidence[]): Map<string, BibliographyEntry> {
    const entries = new Map<string, BibliographyEntry>();
    for (const source of evidence) {
      const entry = manuscriptBibliographyEntry(source, this.research.library);
      const previous = entries.get(entry.citationKey);
      if (previous !== undefined && bibliographyIdentity(previous) !== bibliographyIdentity(entry)) throw new Error('research_manuscript_sync_bibliography_conflict');
      entries.set(entry.citationKey, entry);
    }
    return entries;
  }

  private canApply(artifact: ResearchArtifact): boolean {
    const project = this.research.getProject(artifact.projectId);
    if (project.status === 'archived') return false;
    const stage = this.research.getWorkflow(project.id).stages.find(stage => stage.stage === project.currentStage);
    if (stage === undefined || stage.activeRunId !== null) return false;
    if (artifact.status === 'draft') {
      return project.currentStage === artifact.stage && stage.artifactIds.includes(artifact.id) &&
        ['ready', 'running', 'paused', 'blocked', 'failed', 'waiting_approval'].includes(stage.status);
    }
    if (artifact.status !== 'approved' || project.currentStage !== 'revision' || stage.artifactIds.length !== 0 ||
        !['ready', 'running', 'paused', 'blocked', 'failed'].includes(stage.status)) return false;
    try {return this.research.reviews.requireForStage(project.id, 'revision')?.manuscriptArtifactId === artifact.id;}
    catch {return false;}
  }

  private assertUnbound(scope: ResearchManuscriptSyncInspect, expectedVersion: string, workspacePath: string): void {
    if (this.scope(scope, true).workspacePath !== workspacePath ||
        this.research.inspectArtifact({...scope, expectedVersion}).status !== 'current') throw new Error('research_manuscript_sync_conflict');
    if (this.binding(scope.artifactId) !== null) throw new Error('research_manuscript_sync_already_bound');
  }

  private scope({projectId, artifactId}: ResearchManuscriptSyncInspect, writable = false) {
    const project = this.research.getProject(projectId), artifact = this.research.getArtifact(artifactId);
    if (artifact.projectId !== project.id) throw new Error('research_artifact_project_mismatch');
    if (artifact.kind !== 'manuscript') throw new Error('research_manuscript_artifact_required');
    if (writable && (project.status === 'archived' || artifact.status === 'superseded')) throw new Error('research_manuscript_sync_read_only');
    return {artifact, workspacePath: project.workspacePath};
  }

  private binding(artifactId: string): Binding | null {
    const row = this.db.prepare(`SELECT workspace_path AS workspacePath,tex_path AS texPath,bib_path AS bibPath,
      anchors_json,parent_artifact_id AS parentArtifactId FROM research_manuscript_sync_bindings WHERE artifact_id=?`)
      .get(artifactId) as (Omit<Binding, 'layout'> & {anchors_json: string}) | undefined;
    if (row === undefined) return null;
    const {anchors_json, ...paths} = row;
    return {...paths, layout: layoutSchema.parse(JSON.parse(anchors_json))};
  }

  private insertBinding(artifactId: string, binding: Binding): void {
    this.db.prepare(`INSERT INTO research_manuscript_sync_bindings
      (artifact_id,workspace_path,tex_path,bib_path,anchors_json,parent_artifact_id) VALUES (?,?,?,?,?,?)`)
      .run(artifactId, binding.workspacePath, binding.texPath, binding.bibPath, JSON.stringify(binding.layout), binding.parentArtifactId);
  }

  private async read(projectId: string, binding: Binding): Promise<Files> {
    const {workspacePath} = this.research.getProject(projectId);
    if (workspacePath !== binding.workspacePath) throw new Error('research_manuscript_sync_workspace_changed');
    const root = await researchWorkspace(workspacePath);
    const [tex, bib] = await Promise.all([
      readResearchFile(root, binding.texPath, fileLimit), readResearchFile(root, binding.bibPath, fileLimit)
    ]);
    return snapshotFiles(tex, bib);
  }
}

function bibName(paths: Paths): string {
  for (const path of [paths.texPath, paths.bibPath]) {
    if (researchRelativePath(path).split('/').some(part => part.startsWith('.'))) throw new Error('research_manuscript_sync_path_invalid');
  }
  const name = relative(dirname(paths.texPath), paths.bibPath).slice(0, -4);
  if (!/^[a-z0-9_./-]+$/iu.test(name) || name.split('/').some(part => part === '..')) throw new Error('research_manuscript_sync_bib_path_invalid');
  return name;
}

function snapshotFiles(tex: Buffer, bib: Buffer): Files {
  if (tex.byteLength > fileLimit || bib.byteLength > fileLimit) throw new Error('research_file_size_invalid');
  const decoder = new TextDecoder('utf-8', {fatal: true});
  return {tex: decoder.decode(tex), bib: decoder.decode(bib), hash: digest([researchContentHash(tex), researchContentHash(bib)])};
}

function sameKeys(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every(key => right.includes(key));
}

function bibliographyIdentity(entry: Pick<BibliographyEntry, 'entryType' | 'fields'>): string {
  const fields = {...entry.fields};
  if (fields.journal === undefined && fields.journaltitle !== undefined) fields.journal = fields.journaltitle;
  delete fields.journaltitle;
  return JSON.stringify([entry.entryType, Object.entries(fields).sort(([a], [b]) => a.localeCompare(b))]);
}
