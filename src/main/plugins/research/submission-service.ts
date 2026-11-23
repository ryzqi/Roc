import {constants, linkSync} from 'node:fs';
import {copyFile, mkdir, mkdtemp, rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {basename, dirname, join, relative} from 'node:path';
import type {Database} from 'better-sqlite3';
import {PDFDocument, PDFName} from 'pdf-lib';
import {
  researchSubmissionPrepareSchema, researchSubmissionGetSchema, researchSubmissionListSchema,
  researchSubmissionDeliverSchema, researchSubmissionRecordSchema, researchSubmissionReceiptSchema,
  researchSubmissionDeliverySchema, isSubmissionExtraPath, type ResearchSubmissionPrepare, type ResearchSubmissionGet,
  type ResearchSubmissionList, type ResearchSubmissionReceipt, type ResearchSubmissionRecord,
  type ResearchSubmissionDeliver, type ResearchSubmissionDelivery
} from '../../../shared/schemas/research-submission';
import type {ResearchExportExecution, ResearchExportSources} from '../../../shared/schemas/research-exports';
import {requireResearchHuman} from '../../services/research-human-context';
import type {ResearchRepository} from './repository';
import type {ResearchExportService} from './export-service';
import type {ResearchToolchain} from './toolchain';
import {ResearchExportFiles, exportStorage, exportFileLimit, hashExportArchive} from './export-files';
import {createExportZipArchive} from './export-archive';
import {createResearchDirectory, readResearchFile, researchContentHash, researchWorkspace} from './research-files';
import {ResearchJobSession} from './research-job-session';
import {defaultExportEntry, renderExportBody} from './export-sources';
import {escapeLatex} from './latex-source';
import {writeBibliography} from './bibliography';
import {compileLatex} from './latex-service';
import {checkJournalCompliance} from './journal-compliance-checks';
import {inspectSubmissionPreflight} from './submission-preflight';

type Tools = Pick<ResearchToolchain, 'compile' | 'identity' | 'status'>;
type Row = {id: string; project_id: string; request_json: string; request_hash: string; actor_json: string;
  root_path: string; record_json: string; record_hash: string};
const digest = (value: unknown): string => researchContentHash(JSON.stringify(value));
const activeKey = (projectId: string, requestId: string): string => JSON.stringify([projectId, requestId]);

/** Private identity instructions produce a new minimal bundle; the approved parent is never rewritten. */
export class ResearchSubmissionService {
  private readonly session = new ResearchJobSession('research_submission_closed');
  private readonly active = new Map<string, Promise<ResearchSubmissionReceipt>>();

  constructor(private readonly db: Database, private readonly research: ResearchRepository,
    private readonly exports: Pick<ResearchExportService, 'inspect'>, private readonly tools: Tools,
    private readonly rootPath: string | null, private readonly now: () => string = () => new Date().toISOString()) {}

  recover(): void {
    const rows = this.db.prepare('SELECT * FROM research_submissions').all() as Row[];
    for (const row of rows) {
      const {record} = this.receipt(row);
      if (record.status === 'preparing') this.save({...record, status: 'interrupted', error: 'research_submission_interrupted', endedAt: this.now()});
    }
  }

  async prepare(input: ResearchSubmissionPrepare): Promise<ResearchSubmissionReceipt> {
    const request = researchSubmissionPrepareSchema.parse(input);
    const actor = requireResearchHuman('research.submissions.prepare', request.projectId);
    const key = activeKey(request.projectId, request.requestId);
    const existing = this.existing(request, actor);
    if (existing !== null) return this.active.get(key) ?? existing;
    const pending = this.session.run(async signal => {
      const parent = await this.parent(request);
      const profile = this.research.submissionProfiles.get({projectId: request.projectId, ...request.profile});
      if (profile.snapshot.request.requirements.anonymous !== (request.mode === 'anonymous')) throw new Error('research_submission_mode_mismatch');
      const storage = await exportStorage(this.rootPath);
      signal.throwIfAborted();
      const created = this.db.transaction(() => {
        const repeated = this.existing(request, actor);
        if (repeated !== null) return {created: false, receipt: repeated};
        this.requireProject(request.projectId);
        const id = `submission_${randomUUID()}`;
        const record: ResearchSubmissionRecord = {id, projectId: request.projectId, exportId: request.exportId,
          sourceHash: request.expectedSourceHash, profile: request.profile, mode: request.mode, status: 'preparing',
          files: [], archive: null, preflight: null, manualReviewRequired: request.mode === 'anonymous', journalChecks: [],
          error: null, createdAt: this.now(), endedAt: null};
        this.db.prepare(`INSERT INTO research_submissions
          (id,project_id,request_id,request_json,request_hash,actor_json,root_path,record_json,record_hash) VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(id, request.projectId, request.requestId, JSON.stringify(request), digest(request), JSON.stringify(actor), join(storage, id), JSON.stringify(record), digest(record));
        return {created: true, receipt: {record, recordHash: digest(record)}};
      })();
      if (!created.created) return created.receipt;
      return this.build(request, parent, created.receipt.record, signal);
    });
    this.active.set(key, pending);
    try {return await pending;}
    finally {if (this.active.get(key) === pending) this.active.delete(key);}
  }

  get(input: ResearchSubmissionGet): ResearchSubmissionReceipt {
    const request = researchSubmissionGetSchema.parse(input);
    this.research.getProject(request.projectId);
    return this.receipt(this.row(request.projectId, request.submissionId));
  }

  list(input: ResearchSubmissionList): {items: ResearchSubmissionReceipt[]; total: number} {
    const request = researchSubmissionListSchema.parse(input);
    this.research.getProject(request.projectId);
    const rows = this.db.prepare('SELECT * FROM research_submissions WHERE project_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?')
      .all(request.projectId, request.limit, request.offset) as Row[];
    const total = this.db.prepare('SELECT count(*) FROM research_submissions WHERE project_id=?').pluck().get(request.projectId) as number;
    return {items: rows.map(row => this.receipt(row)), total};
  }

  async deliver(input: ResearchSubmissionDeliver): Promise<ResearchSubmissionDelivery> {
    const request = researchSubmissionDeliverSchema.parse(input);
    const actor = requireResearchHuman('research.submissions.deliver', request.projectId);
    return this.session.run(async signal => {
      const row = this.row(request.projectId, request.submissionId), receipt = this.receipt(row), {record} = receipt;
      if (receipt.recordHash !== request.expectedHash || record.status !== 'ready' || record.archive === null || record.preflight === null) {
        throw new Error('research_submission_not_ready');
      }
      if (record.preflight.status === 'fail' || record.journalChecks.some(check => check.status === 'fail')) throw new Error('research_submission_preflight_failed');
      if (record.manualReviewRequired && request.manualReviewNote === null) throw new Error('research_submission_manual_review_required');
      const original = researchSubmissionPrepareSchema.parse(JSON.parse(row.request_json));
      await this.parent(original);
      this.research.submissionProfiles.get({projectId: request.projectId, ...record.profile});
      await this.verifyFiles(row.root_path, record, signal);
      const parent = await researchWorkspace(dirname(request.destinationPath));
      const destinationPath = join(parent, basename(request.destinationPath));
      const temporary = await mkdtemp(join(parent, '.roc-submission-'));
      try {
        await copyFile(join(row.root_path, record.archive.path), join(temporary, 'submission.zip'), constants.COPYFILE_EXCL);
        await hashExportArchive(temporary, {...record.archive, path: 'submission.zip'}, signal);
        await this.parent(original);
        signal.throwIfAborted();
        this.requireProject(request.projectId);
        if (this.get({projectId: request.projectId, submissionId: record.id}).recordHash !== request.expectedHash) throw new Error('research_submission_changed');
        try {linkSync(join(temporary, 'submission.zip'), destinationPath);}
        catch (error) {if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('research_submission_destination_exists'); throw error;}
        const result = researchSubmissionDeliverySchema.parse({submissionId: record.id, projectId: request.projectId,
          destinationPath, sha256: record.archive.sha256, size: record.archive.size, createdAt: this.now()});
        this.db.prepare(`INSERT INTO research_submission_deliveries
          (id,project_id,submission_id,request_json,actor_json,receipt_json,created_at) VALUES (?,?,?,?,?,?,?)`)
          .run(randomUUID(), request.projectId, record.id, JSON.stringify(request), JSON.stringify(actor), JSON.stringify(result), result.createdAt);
        return result;
      } finally {await rm(temporary, {recursive: true, force: true});}
    });
  }

  async shutdown(): Promise<void> {await this.session.shutdown();}

  private async build(request: ResearchSubmissionPrepare, parent: ResearchExportExecution, original: ResearchSubmissionRecord,
    signal: AbortSignal): Promise<ResearchSubmissionReceipt> {
    const root = this.row(request.projectId, original.id).root_path;
    let record = original;
    let scratch: string | null = null;
    try {
      await mkdir(root, {mode: 0o700});
      const writer = new ResearchExportFiles(await createResearchDirectory(root, 'bundle'));
      scratch = await createResearchDirectory(root, 'scratch');
      const toolchain = await this.tools.status();
      if (!toolchain.available) throw new Error('research_submission_toolchain_unavailable');
      const toolchainHash = await this.tools.identity();
      if (toolchainHash !== parent.toolchainHash) throw new Error('research_submission_toolchain_changed');
      const profile = this.research.submissionProfiles.get({projectId: request.projectId, ...request.profile});
      const current = parent.sources!;
      const transform = replacementTransform(request.replacements);
      const sources = transformSources(current, request.mode === 'anonymous' ? transform : value => value,
        request.mode === 'anonymous' ? replacementTransform(request.replacements, true) : value => value);
      const title = request.mode === 'anonymous' ? transform(request.title) : request.title;
      const authors=request.mode==='named'?parent.request.publicationReview.publication.authors.map(author=>author.name):[];
      const entry = defaultExportEntry(title, this.research.getProject(request.projectId).language)
        .replace('roc-manuscript.tex', 'manuscript.tex').replace('{roc-references}', '{references}')
        .replace('\\date{}',`\\author{${authors.map(escapeLatex).join(' \\and ')}}\n\\date{}`);
      await writer.write('source/main.tex', entry);
      await writer.write('source/manuscript.tex', renderExportBody(sources).replace(/^%[^\n]*\n/gmu, ''));
      await writer.write('source/references.bib', writeBibliography(sources.bibliography, 'bibtex'));
      const sourceRoot = join(this.research.exports.root(request.projectId, parent.id), 'bundle');
      for (const [index, figure] of current.figures.entries()) {
        for (const extension of ['pdf', 'png']) {
          const path = `source/${current.template === null ? '' : `${dirname(current.template.entryPath)}/`}figures/${figure.id}.${extension}`.replace('/./', '/');
          const file = parent.files.find(file => file.path === path);
          if (file === undefined) throw new Error('research_submission_figure_missing');
          await writer.copy(sourceRoot, file, `source/figures/figure-${index + 1}.${extension}`);
        }
      }
      const extras = [];
      for (const path of request.supplementPaths) {
        if (!isSubmissionExtraPath(path)) {
          throw new Error('research_submission_extra_not_allowed');
        }
        const file = parent.files.find(file => file.path === path);
        if (file === undefined) throw new Error('research_submission_extra_missing');
        extras.push({...await writer.copy(sourceRoot, file, `extras/${path}`), logicalPath: path});
      }
      const compiled = await compileLatex({rootPath: join(writer.root, 'source'), entryPath: 'main.tex', outputDir: join(scratch, 'compiled'), jobDir: scratch,
        signal, runner: async input => {
          const result = await this.tools.compile({...input, admission: {projectId: request.projectId, priority: 'user'}});
          if (/^warning:\s+errors were issued by BibTeX,\s+but were ignored\b/mu.test(result.stderr)) throw new Error('research_submission_bibliography_failed');
          return result;
        }});
      if (compiled.status !== 'ready' || compiled.pdfPath === null || compiled.pdfHash === null) throw new Error('research_submission_compile_failed');
      const bytes = await readResearchFile(scratch, relative(scratch, compiled.pdfPath), exportFileLimit);
      if (researchContentHash(bytes) !== compiled.pdfHash) throw new Error('research_submission_changed');
      const pdf = await PDFDocument.load(bytes, {updateMetadata: false});
      pdf.setTitle(title); pdf.setAuthor(authors.join('; ')); pdf.setSubject(''); pdf.setKeywords([]); pdf.setCreator('Roc'); pdf.setProducer('Roc');
      pdf.catalog.delete(PDFName.of('Metadata'));
      const cleanPdf = Buffer.from(await pdf.save());
      await writer.write('paper.pdf', cleanPdf);
      const selection = {profile: profile.snapshot.request.profile, figureIds: current.figures.map(figure => figure.id),
        supplementPaths: extras.flatMap(file => [file.logicalPath, file.path]), manualReviews: []};
      const facts = this.research.journalCompliance.captureFacts(request.projectId, current.manuscriptArtifact.id, selection);
      if (facts.manuscript.contentHash !== current.manuscript.contentHash || facts.manuscript.claimsHash !== current.manuscript.claimsHash ||
          facts.figures.some(figure => !current.figures.some(original => original.id === figure.id && original.manifestHash === figure.manifestHash))) {
        throw new Error('research_submission_parent_changed');
      }
      const checks = checkJournalCompliance(selection, {...facts,
        manuscript: {...facts.manuscript, sections: sources.manuscript.sections},
        claims: facts.claims.map(claim => sources.claims.find(candidate => candidate.id === claim.id) ?? claim),
        supplements: extras.flatMap(({path, logicalPath, sha256, size}) => [{path: logicalPath, sha256, size}, {path, sha256, size}])});
      const logicalPaths = new Map(extras.map(file => [file.path, file.logicalPath]));
      const files = await Promise.all(writer.list().map(async file => ({path: file.path, logicalPath: logicalPaths.get(file.path),
        bytes: new Uint8Array(await readResearchFile(writer.root, file.path, exportFileLimit))})));
      const preflight = await inspectSubmissionPreflight({profile, pdf: cleanPdf, files, journalChecks: checks,
        privateIdentityTokens: request.replacements.map(rule => rule.find), signal});
      const manualReviewRequired = preflight.status === 'manual' || checks.some(check => check.status === 'manual') ||
        request.mode === 'anonymous' && (current.figures.length > 0 || extras.length > 0);
      if (preflight.status === 'fail' || checks.some(check => check.status === 'fail')) {
        record = {...record, status: 'failed', preflight, manualReviewRequired,
          journalChecks: checks.map(({ruleId, status}) => ({ruleId, status})), error: 'research_submission_preflight_failed', endedAt: this.now()};
        await rm(writer.root, {recursive: true, force: true});
        return this.save(record);
      }
      await writer.write('manifest.json', `${JSON.stringify({schemaVersion: 1, mode: request.mode, sourceExportHash: request.expectedSourceHash,
        profileHash: request.profile.expectedHash, toolchainHash, files: writer.list()})}\n`);
      const archive = {path: 'submission.zip', ...await createExportZipArchive(writer.root, join(root, 'submission.zip'), writer.list(), signal)};
      await this.parent(request);
      this.research.submissionProfiles.get({projectId: request.projectId, ...request.profile});
      if (await this.tools.identity() !== toolchainHash) throw new Error('research_submission_toolchain_changed');
      signal.throwIfAborted();
      record = {...record, status: 'ready', files: writer.list(), archive, preflight, manualReviewRequired,
        journalChecks: checks.map(({ruleId, status}) => ({ruleId, status})), error: null, endedAt: this.now()};
    } catch (error) {
      record = {...record, status: signal.aborted ? 'interrupted' : 'failed', error: submissionError(error), endedAt: this.now()};
      await rm(join(root, 'bundle'), {recursive: true, force: true});
      await rm(join(root, 'submission.zip'), {force: true});
    } finally {if (scratch !== null) await rm(scratch, {recursive: true, force: true});}
    return this.save(record);
  }

  private async parent(request: ResearchSubmissionPrepare): Promise<ResearchExportExecution> {
    this.requireProject(request.projectId);
    const parent = await this.exports.inspect(request.projectId, request.exportId);
    if (parent.approval !== 'approved' || parent.status !== 'ready' || parent.sourceHash !== request.expectedSourceHash || parent.sources === null) {
      throw new Error('research_submission_parent_changed');
    }
    return parent;
  }

  private async verifyFiles(root: string, record: ResearchSubmissionRecord, signal: AbortSignal): Promise<void> {
    for (const file of record.files) {
      signal.throwIfAborted();
      const bytes = await readResearchFile(join(root, 'bundle'), file.path, exportFileLimit);
      if (bytes.length !== file.size || researchContentHash(bytes) !== file.sha256) throw new Error('research_submission_changed');
    }
    await hashExportArchive(root, record.archive!, signal);
  }

  private existing(request: ResearchSubmissionPrepare, actor: unknown): ResearchSubmissionReceipt | null {
    const row = this.db.prepare('SELECT * FROM research_submissions WHERE project_id=? AND request_id=?').get(request.projectId, request.requestId) as Row | undefined;
    if (row === undefined) return null;
    if (row.request_hash !== digest(request) || row.actor_json !== JSON.stringify(actor)) throw new Error('research_submission_request_conflict');
    return this.receipt(row);
  }

  private row(projectId: string, id: string): Row {
    const row = this.db.prepare('SELECT * FROM research_submissions WHERE id=?').get(id) as Row | undefined;
    if (row === undefined) throw new Error('research_submission_not_found');
    if (row.project_id !== projectId) throw new Error('research_submission_project_mismatch');
    return row;
  }

  private receipt(row: Row): ResearchSubmissionReceipt {
    const record = researchSubmissionRecordSchema.parse(JSON.parse(row.record_json));
    if (record.id !== row.id || record.projectId !== row.project_id || digest(record) !== row.record_hash ||
        researchContentHash(row.request_json) !== row.request_hash) throw new Error('research_submission_snapshot_invalid');
    return researchSubmissionReceiptSchema.parse({record, recordHash: row.record_hash});
  }

  private save(input: ResearchSubmissionRecord): ResearchSubmissionReceipt {
    const record = researchSubmissionRecordSchema.parse(input), recordHash = digest(record);
    this.db.prepare('UPDATE research_submissions SET record_json=?,record_hash=? WHERE id=?')
      .run(JSON.stringify(record), recordHash, record.id);
    return {record, recordHash};
  }

  private requireProject(projectId: string): void {
    if (this.research.getProject(projectId).status === 'archived') throw new Error('research_project_archived');
  }
}

function replacementTransform(replacements: ResearchSubmissionPrepare['replacements'], encoded = false): (text: string) => string {
  const rules = replacements.map(rule => encoded ? {find: escapeLatex(rule.find), replace: escapeLatex(rule.replace)} : rule)
    .sort((left, right) => right.find.length - left.find.length);
  return text => {
    if (rules.length === 0) return text;
    const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const lookup = new Map(rules.map(rule => [rule.find, rule.replace]));
    return text.replace(new RegExp(`(?<![\\p{L}\\p{N}_])(?:${rules.map(rule => escape(rule.find)).join('|')})(?![\\p{L}\\p{N}_])`, 'gu'), match => lookup.get(match)!);
  };
}

function transformSources(original: ResearchExportSources, transform: (text: string) => string, transformTex: (text: string) => string): ResearchExportSources {
  const sources = structuredClone(original);
  const keys = new Map(sources.bibliography.map((entry, index) => [entry.citationKey, `reference-${index + 1}`]));
  sources.citationKeys = Object.fromEntries(Object.entries(sources.citationKeys).map(([id, key]) => [id, keys.get(key)!]));
  sources.claims = sources.claims.map(claim => ({...claim, content: transform(claim.content)}));
  sources.manuscript.sections = sources.manuscript.sections.map(section => ({...section, title: transform(section.title)}));
  sources.figures = sources.figures.map((figure, index) => ({...figure, id: `figure-${index + 1}`}));
  for (const entry of sources.bibliography) {
    entry.citationKey = keys.get(entry.citationKey)!;
    entry.fields = Object.fromEntries(Object.entries(entry.fields).map(([key, value]) => [key,
      key === 'crossref' ? keys.get(value) ?? value : transformTex(value)]));
    // New files are compiled from their explicit fields; source preambles can contain arbitrary executable TeX.
    if (entry.preambles.length > 0) throw new Error('research_submission_bibliography_preamble_unsupported');
  }
  return sources;
}

function submissionError(error: unknown): string {
  if (error instanceof Error && /^research_[a-z0-9_]+$/u.test(error.message)) return error.message;
  return 'research_submission_failed';
}
