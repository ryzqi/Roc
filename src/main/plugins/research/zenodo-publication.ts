import {z} from 'zod';
import {zenodoCredentialSchema, zenodoCredentialReadSchema, zenodoStartSchema, zenodoOperationReadSchema,
  zenodoOperationActionSchema, zenodoPublicationApproveSchema, zenodoPublishSchema,
  type ZenodoOperation, type ZenodoRemoteSnapshot, type ZenodoPublicationApproval} from '../../../shared/schemas/research-zenodo-remote';
import {zenodoMetadataSchema, type ZenodoPrepared} from '../../../shared/schemas/research-zenodo';
import type {RocPluginContext} from '../../kernel/types';
import type {ResearchRepository} from './repository';
import type {ZenodoPreparationService} from './zenodo-preparation';
import type {ZenodoOperationRepository} from './zenodo-operation-repository';
import type {ResearchExportService} from './export-service';
import {ZenodoTransport, ZenodoTransportError, readZenodoDeposition, zenodoBucket} from './zenodo-transport';
import {ResearchJobSession} from './research-job-session';
import {requireResearchHuman} from '../../services/research-human-context';

type Cursor = {current: ZenodoOperation; signal: AbortSignal; mutation: 'none' | 'create' | 'upload' | 'publish'};
type Patch = Parameters<ZenodoOperationRepository['update']>[1];
const markerSchema = z.array(z.object({identifier: z.string(), relation: z.string()}));

export class ZenodoPublicationService {
  private readonly session = new ResearchJobSession('research_zenodo_closed');
  private readonly busy = new Map<string, {controller: AbortController; projectId: string}>();
  constructor(private readonly research: ResearchRepository, private readonly preparations: ZenodoPreparationService,
    private readonly repository: ZenodoOperationRepository, private readonly transport: ZenodoTransport,
    private readonly secrets: RocPluginContext['secrets'],
    private readonly upload: ResearchExportService['uploadPublicationFile']) {}

  recover(): void {this.repository.recover();}
  async saveCredential(input: z.infer<typeof zenodoCredentialSchema>): Promise<{stored: boolean}> {
    const request = zenodoCredentialSchema.parse(input);
    requireResearchHuman('research.zenodo.saveCredential', request.projectId); this.writable(request.projectId);
    try {await this.secrets.set(`zenodo-${request.environment}`, request.plaintext);}
    catch {throw new Error('research_zenodo_credential_storage_failed');}
    return {stored: true};
  }
  async credentialStatus(input: z.infer<typeof zenodoCredentialReadSchema>): Promise<{stored: boolean}> {
    const request = zenodoCredentialReadSchema.parse(input); this.research.getProject(request.projectId);
    try {return {stored: (await this.secrets.get(`zenodo-${request.environment}`)) !== null};}
    catch {throw new Error('research_zenodo_credential_storage_failed');}
  }
  clearCredential(input: z.infer<typeof zenodoCredentialReadSchema>): {stored: boolean} {
    const request = zenodoCredentialReadSchema.parse(input);
    requireResearchHuman('research.zenodo.clearCredential', request.projectId); this.writable(request.projectId);
    try {this.secrets.clear(`zenodo-${request.environment}`);}
    catch {throw new Error('research_zenodo_credential_storage_failed');}
    return {stored: false};
  }
  get(input: z.infer<typeof zenodoOperationReadSchema>): ZenodoOperation {
    const request = zenodoOperationReadSchema.parse(input);
    return this.repository.get(request.projectId, request.operationId);
  }
  async start(input: z.infer<typeof zenodoStartSchema>): Promise<ZenodoOperation> {
    const request = zenodoStartSchema.parse(input);
    requireResearchHuman('research.zenodo.start', request.projectId); this.writable(request.projectId);
    this.session.requireOpen();
    const previous = this.repository.find(request);
    if (previous !== null) return previous;
    const preparation = this.preparations.get(request.projectId, request.preparationId);
    if (preparation.contentHash !== request.expectedPreparationHash) throw new Error('research_zenodo_preparation_changed');
    await this.preparations.assertCurrent(preparation);
    await this.transport.credential(preparation.request.environment);
    const concurrent = this.repository.find(request);
    if (concurrent !== null) return concurrent;
    const operation = this.repository.create(request, preparation);
    return this.attempt(operation, async cursor => {
      await this.currentPreparation(cursor);
      cursor.mutation = 'create';
      const raw = await this.transport.request(operation.environment, 'deposit/depositions', 'POST', 201, cursor.signal,
        JSON.stringify({metadata: {...preparation.request.metadata,
          related_identifiers: [{identifier: operation.marker, relation: 'isAlternateIdentifier'}]}}));
      const remoteId = z.object({id: z.number().int().positive()}).parse(raw).id;
      this.update(cursor, {remoteId});
      const remote = readZenodoDeposition(raw, operation.environment);
      this.identity(cursor.current, remote);
      this.update(cursor, {remote, status: 'draft', error: null});
      cursor.mutation = 'none';
      await this.uploadMissing(cursor, preparation);
    });
  }
  async refresh(input: z.infer<typeof zenodoOperationReadSchema>): Promise<ZenodoOperation> {
    const operation = this.get(input);
    return this.attempt(operation, async cursor => {
      if (cursor.current.remoteId === null) {
        if (cursor.current.status !== 'create_unknown') throw new Error('research_zenodo_query_required');
        const matches: ZenodoRemoteSnapshot[] = [];
        let complete = false;
        for (let page = 1; page <= 10; page++) {
          const raw = await this.transport.request(operation.environment,
            `deposit/depositions?size=100&page=${page}&all_versions=1`, 'GET', 200, cursor.signal);
          const rows = z.array(z.unknown()).max(100).parse(raw);
          for (const row of rows) {
            const item = z.object({metadata: z.object({related_identifiers: markerSchema.optional()})}).parse(row);
            if (item.metadata.related_identifiers?.some(value => value.identifier === operation.marker &&
              value.relation === 'isAlternateIdentifier')) matches.push(readZenodoDeposition(row, operation.environment));
          }
          if (rows.length < 100) {complete = true; break;}
        }
        const match = matches[0];
        if (!complete || matches.length !== 1 || match === undefined) throw new Error('research_zenodo_create_unresolved');
        this.update(cursor, {remoteId: match.id, remote: match});
      }
      await this.observe(cursor);
    });
  }
  async resume(input: z.infer<typeof zenodoOperationActionSchema>): Promise<ZenodoOperation> {
    const request = zenodoOperationActionSchema.parse(input);
    requireResearchHuman('research.zenodo.resume', request.projectId); this.writable(request.projectId);
    const operation = this.repository.get(request.projectId, request.operationId);
    this.revision(operation, request.expectedRevision);
    if (operation.remoteId === null || ['publish_requested', 'publish_unknown', 'published'].includes(operation.status)) {
      throw new Error('research_zenodo_query_required');
    }
    return this.attempt(operation, async cursor => {
      const preparation = await this.currentPreparation(cursor);
      await this.observe(cursor);
      await this.uploadMissing(cursor, preparation);
    });
  }
  async approve(input: z.infer<typeof zenodoPublicationApproveSchema>): Promise<ZenodoPublicationApproval> {
    const request = zenodoPublicationApproveSchema.parse(input);
    requireResearchHuman('research.zenodo.approvePublication', request.projectId); this.writable(request.projectId);
    const previous = this.repository.findApproval(request);
    if (previous !== null) return previous;
    const operation = this.repository.get(request.projectId, request.operationId);
    this.revision(operation, request.expectedRevision);
    return this.exclusive(operation, async cursor => {
      await this.currentPreparation(cursor);
      await this.observe(cursor);
      await this.currentPreparation(cursor);
      return this.repository.approve(request);
    });
  }
  async publish(input: z.infer<typeof zenodoPublishSchema>): Promise<ZenodoOperation> {
    const request = zenodoPublishSchema.parse(input);
    requireResearchHuman('research.zenodo.publish', request.projectId); this.writable(request.projectId);
    const operation = this.repository.get(request.projectId, request.operationId);
    const approval = this.repository.approval(request.projectId, operation.id, request.approvalId);
    if (operation.approval?.id !== approval.id) throw new Error('research_zenodo_publication_review_changed');
    if (['publish_requested', 'publish_unknown', 'published'].includes(operation.status)) return operation;
    this.revision(operation, request.expectedRevision);
    return this.attempt(operation, async cursor => {
      const preparation = await this.currentPreparation(cursor);
      await this.observe(cursor);
      await this.currentPreparation(cursor);
      if (cursor.current.status !== 'ready' || cursor.current.remote?.contentHash !== approval.request.expectedRemoteHash ||
        preparation.contentHash !== approval.request.expectedPreparationHash) throw new Error('research_zenodo_publication_review_changed');
      this.update(cursor, {status: 'publish_requested', error: null});
      cursor.mutation = 'publish';
      const raw = await this.transport.request(operation.environment, `deposit/depositions/${cursor.current.remoteId}/actions/publish`,
        'POST', 202, cursor.signal);
      const remote = readZenodoDeposition(raw, operation.environment);
      this.identity(cursor.current, remote);
      this.saveObservation(cursor, preparation, remote);
    });
  }
  cancel(input: z.infer<typeof zenodoOperationReadSchema>): ZenodoOperation {
    const operation = this.get(input); requireResearchHuman('research.zenodo.cancel', operation.projectId);
    this.busy.get(operation.id)?.controller.abort();
    return this.repository.get(operation.projectId, operation.id);
  }
  releaseProject(projectId: string): void {
    for (const job of this.busy.values()) if (job.projectId === projectId) job.controller.abort();
  }
  projectChanged(projectId: string): void {
    if (this.research.getProject(projectId).status === 'archived') this.releaseProject(projectId);
  }
  async shutdown(): Promise<void> {await this.session.shutdown();}

  private async currentPreparation(cursor: Cursor): Promise<ZenodoPrepared> {
    this.writable(cursor.current.projectId);
    cursor.signal.throwIfAborted();
    const preparation = this.preparations.get(cursor.current.projectId, cursor.current.preparationId);
    await this.preparations.assertCurrent(preparation, cursor.signal);
    cursor.signal.throwIfAborted();
    return preparation;
  }
  private async observe(cursor: Cursor): Promise<void> {
    const operation = cursor.current;
    if (operation.remoteId === null) throw new Error('research_zenodo_query_required');
    const raw = await this.transport.request(operation.environment, `deposit/depositions/${operation.remoteId}`,
      'GET', 200, cursor.signal);
    const remote = readZenodoDeposition(raw, operation.environment);
    this.identity(operation, remote);
    const preparation = this.preparations.get(operation.projectId, operation.preparationId);
    this.saveObservation(cursor, preparation, remote);
  }
  private saveObservation(cursor: Cursor, preparation: ZenodoPrepared, remote: ZenodoRemoteSnapshot): void {
    const review = this.review(preparation, remote);
    const published = remote.state === 'done' && remote.submitted;
    const receiptMissing = published && (remote.doi === null || remote.recordId === null || remote.recordUrl === null);
    const stateInvalid = remote.state === 'done' && !remote.submitted;
    const status = published && !receiptMissing ? 'published' : remote.state === 'error' ? 'remote_error' :
      remote.submitted || ['publish_requested', 'publish_unknown'].includes(cursor.current.status) ? 'publish_unknown' :
      stateInvalid ? 'remote_error' :
      review.error === null && review.complete ? 'ready' : 'draft';
    const error = receiptMissing ? 'research_zenodo_publication_receipt_incomplete' :
      stateInvalid ? 'research_zenodo_remote_state_invalid' : review.error;
    if (remote.contentHash === cursor.current.remote?.contentHash && status === cursor.current.status &&
      error === cursor.current.error) return;
    this.update(cursor, {remote, status, error});
  }
  private async uploadMissing(cursor: Cursor, preparation: ZenodoPrepared): Promise<void> {
    const remote = cursor.current.remote;
    if (remote === null || remote.submitted || remote.state !== 'inprogress') throw new Error('research_zenodo_draft_required');
    const review = this.review(preparation, remote);
    if (review.error !== null) throw new Error(review.error);
    for (const file of preparation.inputs.files) {
      const currentRemote = cursor.current.remote;
      if (currentRemote === null) throw new Error('research_zenodo_query_required');
      if (currentRemote.files.some(value => value.name === file.name)) continue;
      const bucket = currentRemote.bucket;
      if (bucket === null) throw new Error('research_zenodo_bucket_required');
      await this.currentPreparation(cursor);
      this.update(cursor, {status: 'uploading', error: null});
      const raw = await this.upload(preparation, file.name, cursor.signal, async (stream, size) => {
        await this.currentPreparation(cursor);
        cursor.mutation = 'upload';
        return this.transport.request(cursor.current.environment,
          `${zenodoBucket(bucket, cursor.current.environment)}/${file.name}`, 'PUT', 200, cursor.signal, stream, size);
      });
      const receipt = z.object({key: z.string(), checksum: z.string(), size: z.number().int().nonnegative()}).parse(raw);
      if (receipt.key !== file.name || receipt.checksum !== `md5:${file.md5}` || receipt.size !== file.size) {
        throw new Error('research_zenodo_upload_checksum_changed');
      }
      await this.observe(cursor);
      cursor.mutation = 'none';
      if (cursor.current.error !== null) throw new Error(cursor.current.error);
    }
    await this.currentPreparation(cursor);
  }
  private review(preparation: ZenodoPrepared, remote: ZenodoRemoteSnapshot): {complete: boolean; error: string | null} {
    const picked = Object.fromEntries(Object.keys(zenodoMetadataSchema.shape).map(key => [key, remote.metadata[key]]));
    const metadata = zenodoMetadataSchema.safeParse(picked);
    if (!metadata.success || JSON.stringify(metadata.data) !== JSON.stringify(preparation.request.metadata)) {
      return {complete: false, error: 'research_zenodo_remote_metadata_changed'};
    }
    for (const file of remote.files) {
      const expected = preparation.inputs.files.find(value => value.name === file.name);
      if (expected === undefined || expected.size !== file.size || expected.md5 !== file.md5) {
        return {complete: false, error: 'research_zenodo_remote_files_changed'};
      }
    }
    return {complete: remote.files.length === preparation.inputs.files.length, error: null};
  }
  private identity(operation: ZenodoOperation, remote: ZenodoRemoteSnapshot): void {
    const related = markerSchema.parse(remote.metadata.related_identifiers);
    if (operation.remoteId !== remote.id || (operation.remote !== null && operation.remote.owner !== remote.owner) ||
      !related.some(value => value.identifier === operation.marker && value.relation === 'isAlternateIdentifier')) {
      throw new Error('research_zenodo_remote_identity_changed');
    }
  }
  private update(cursor: Cursor, patch: Patch): void {cursor.current = this.repository.update(cursor.current, patch);}
  private attempt(operation: ZenodoOperation, work: (cursor: Cursor) => Promise<void>): Promise<ZenodoOperation> {
    return this.exclusive(operation, async cursor => {
      try {await work(cursor);}
      catch (error) {
        const attempted = !(error instanceof ZenodoTransportError) || error.attempted;
        const status = cursor.current.status === 'publish_requested' ? 'publish_unknown' :
          cursor.mutation === 'create' && cursor.current.remoteId === null ? attempted ? 'create_unknown' : 'remote_error' :
          cursor.current.status === 'creating' ? 'remote_error' :
          cursor.mutation === 'upload' && attempted ? 'upload_unknown' :
          cursor.current.status === 'uploading' ? 'draft' : cursor.current.status;
        try {this.update(cursor, {status, error: cursor.signal.aborted ? 'research_zenodo_cancelled' : this.code(error)});}
        catch (recordError) {throw new AggregateError([error, recordError], 'research_zenodo_record_failed');}
      }
      return cursor.current;
    });
  }
  private exclusive<T>(operation: ZenodoOperation, run: (cursor: Cursor) => Promise<T>): Promise<T> {
    this.session.requireOpen();
    if (this.busy.has(operation.id)) throw new Error('research_zenodo_operation_busy');
    const controller = new AbortController();
    this.busy.set(operation.id, {controller, projectId: operation.projectId});
    return this.session.run(signal => run({current: operation, signal: AbortSignal.any([signal, controller.signal]),
      mutation: 'none'})).finally(() => this.busy.delete(operation.id));
  }
  private revision(operation: ZenodoOperation, revision: number): void {
    if (operation.revision !== revision) throw new Error('research_zenodo_operation_changed');
  }
  private writable(projectId: string): void {
    if (this.research.getProject(projectId).status === 'archived') throw new Error('research_project_archived');
  }
  private code(error: unknown): string {
    if (error instanceof ZenodoTransportError) return error.code;
    if (error instanceof Error && /^research_[a-z0-9_]+$/u.test(error.message)) return error.message;
    return 'research_zenodo_contract_failed';
  }
}
