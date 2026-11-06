import {z} from 'zod';
import {
  openReviewQuerySchema, openReviewNoteSchema, openReviewEditSchema, openReviewPageSchema,
  type OpenReviewQuery, type OpenReviewPage, type OpenReviewEntry
} from '../../../shared/schemas/research-openreview';
import {resourceContentHash} from './resource-repository';

const groups = z.array(z.string().min(1).max(2048)).max(256);
const date = z.number().int().min(0).max(9999999999999).nullish();
const common = {
  readers: groups, nonreaders: groups.optional(), signatures: groups, domain: z.string().nullish(),
  tcdate: date, tmdate: date, cdate: date, mdate: date, ddate: date
};
const note = z.object({
  id: z.string(), forum: z.string(), replyto: z.string().nullish(), invitations: groups, ...common,
  pdate: date, odate: date, license: z.string().nullish(),
  content: z.record(z.string(), z.object({value: z.json(), readers: groups.optional()}))
});
const edit = z.object({
  id: z.string(), invitation: z.string(), ...common, replacement: z.boolean().nullish(),
  content: z.record(z.string(), z.json()).nullish(),
  note: z.record(z.string(), z.json())
});
export function openReviewEndpoint(input: OpenReviewQuery): string {
  const query = openReviewQuerySchema.parse(input);
  const url = new URL(query.kind === 'edits' ? 'https://api2.openreview.net/notes/edits' : 'https://api2.openreview.net/notes');
  url.searchParams.set(query.kind === 'note' ? 'id' : query.kind === 'edits' ? 'note.id' : query.kind, query.target);
  url.searchParams.set('sort', 'id:asc');
  url.searchParams.set('limit', String(query.limit));
  url.searchParams.set('count', 'true');
  if (query.after !== null) url.searchParams.set('after', query.after);
  return url.href;
}
function dates(value: z.infer<typeof note> | z.infer<typeof edit>) {
  return {domain: value.domain ?? null, readers: value.readers, nonreaders: value.nonreaders ?? [], signatures: value.signatures,
    tcdate: value.tcdate ?? null, tmdate: value.tmdate ?? null, cdate: value.cdate ?? null,
    mdate: value.mdate ?? null, ddate: value.ddate ?? null};
}
export function verifyOpenReviewPage(query: OpenReviewQuery, page: OpenReviewPage): void {
  const ids = page.entries.map(entry => entry.kind === 'note' ? entry.note.id : entry.edit.id);
  if (ids.length > query.limit || ids.some((id, index) => index === 0 ? query.after !== null && id <= query.after : id <= ids[index - 1]!) ||
    page.nextAfter !== (query.kind !== 'note' && ids.length === query.limit ? ids.at(-1)! : null))
    throw new Error('literature_provider_response_invalid');
  for (const entry of page.entries) {
    if (entry.kind === 'edit') {
      if (query.kind !== 'edits' || entry.edit.note.id !== query.target || resourceContentHash(entry.edit) !== entry.sourceHash)
        throw new Error('literature_provider_response_invalid');
    } else {
      const value = entry.note;
      if (query.kind === 'edits' || query.kind === 'note' && value.id !== query.target ||
        query.kind === 'forum' && value.forum !== query.target ||
        query.kind === 'invitation' && !value.invitations.includes(query.target) || resourceContentHash(value) !== entry.sourceHash)
        throw new Error('literature_provider_response_invalid');
    }
  }
}
export function readOpenReviewPage(input: OpenReviewQuery, payload: unknown): OpenReviewPage {
  const query = openReviewQuerySchema.parse(input);
  let entries: OpenReviewEntry[], count: number | undefined;
  if (query.kind === 'edits') {
    const value = z.object({edits: z.array(edit).max(query.limit), count: z.number().int().nonnegative().optional()}).parse(payload);
    count = value.count;
    entries = value.edits.map(value => {
      const normalized = openReviewEditSchema.parse({...dates(value), id: value.id, invitation: value.invitation,
        replacement: value.replacement ?? null, content: value.content ?? null, note: value.note});
      return {kind: 'edit', edit: normalized, sourceHash: resourceContentHash(normalized)};
    });
  } else {
    const value = z.object({notes: z.array(note).max(query.limit), count: z.number().int().nonnegative().optional()}).parse(payload);
    count = value.count;
    entries = value.notes.map(value => {
      const normalized = openReviewNoteSchema.parse({...dates(value), id: value.id, forum: value.forum, replyto: value.replyto ?? null,
        invitations: value.invitations, pdate: value.pdate ?? null, odate: value.odate ?? null, license: value.license ?? null,
        content: Object.fromEntries(Object.entries(value.content).map(([key, field]) => [key, {value: field.value, readers: field.readers ?? null}]))});
      return {kind: 'note', note: normalized, sourceHash: resourceContentHash(normalized)};
    });
  }
  const last = entries.at(-1);
  const page = openReviewPageSchema.parse({entries, providerTotal: count ?? null,
    nextAfter: query.kind !== 'note' && entries.length === query.limit && last !== undefined ?
      last.kind === 'note' ? last.note.id : last.edit.id : null});
  verifyOpenReviewPage(query, page);
  return page;
}
