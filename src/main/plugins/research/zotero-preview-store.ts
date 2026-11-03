import {createHash, randomUUID} from 'node:crypto';
import type {Database} from 'better-sqlite3';
import type {z} from 'zod';
import {zoteroPreviewBodySchema, zoteroPreviewSchema, zoteroPreviewReadSchema,
  type zoteroItemsRequestSchema, type zoteroItemsPageSchema, type ZoteroPreview, type ZoteroPreviewPage
} from '../../../shared/schemas/research-zotero';
import type {LiteratureExecutionContext} from '../../services/literature-context';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Immutable user-review inputs. Preview reads do not re-fetch or change the literature library. */
export class ZoteroPreviewStore {
  constructor(private readonly db: Database, private readonly now: () => string) {}

  capture(context: LiteratureExecutionContext, request: z.infer<typeof zoteroItemsRequestSchema>,
    sourcePage: z.infer<typeof zoteroItemsPageSchema>): ZoteroPreviewPage {
    const createdAt = this.now();
    const body = zoteroPreviewBodySchema.parse({schemaVersion: 1, previewId: `zotero_preview_${randomUUID()}`,
      request, sourcePage, createdAt, expiresAt: new Date(Date.parse(createdAt) + 7 * 86400_000).toISOString()});
    const snapshot = {...body, contentHash: hash(body)};
    this.db.prepare(`INSERT INTO research_zotero_previews(id,owner,project_id,run_id,created_at,expires_at,snapshot_json)
      VALUES (?,?,?,?,?,?,?)`).run(body.previewId, context.owner, context.projectId, context.runId ?? null,
        createdAt, body.expiresAt, JSON.stringify(snapshot));
    return this.slice(snapshot, 0, 20);
  }

  read(context: LiteratureExecutionContext, input: unknown): ZoteroPreviewPage {
    const request = zoteroPreviewReadSchema.parse(input);
    return this.slice(this.load(context, request.previewId), request.offset, request.limit);
  }

  load(context: LiteratureExecutionContext, previewId: string): ZoteroPreview {
    const row = this.db.prepare(`SELECT snapshot_json FROM research_zotero_previews
      WHERE id=? AND owner=? AND project_id IS ?`).get(previewId, context.owner, context.projectId) as
        {snapshot_json: string} | undefined;
    if (row === undefined) throw new Error('zotero_preview_not_found');
    let snapshot: ZoteroPreview;
    try { snapshot = zoteroPreviewSchema.parse(JSON.parse(row.snapshot_json)); }
    catch (cause) { throw new Error('zotero_preview_storage_invalid', {cause}); }
    const {contentHash, ...body} = snapshot;
    if (body.previewId !== previewId || hash(body) !== contentHash) throw new Error('zotero_preview_integrity_invalid');
    if (snapshot.expiresAt <= this.now()) throw new Error('zotero_preview_expired');
    return snapshot;
  }

  private slice(snapshot: ZoteroPreview, offset: number, limit: number): ZoteroPreviewPage {
    const capturedTotal = snapshot.sourcePage.records.length;
    return {...snapshot, sourcePage: {...snapshot.sourcePage, records: snapshot.sourcePage.records.slice(offset, offset + limit)},
      capturedTotal, nextPreviewOffset: offset + limit < capturedTotal ? offset + limit : null};
  }
}
