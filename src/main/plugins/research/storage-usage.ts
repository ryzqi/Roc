import {createHash} from 'node:crypto';
import {lstat, readdir, realpath} from 'node:fs/promises';
import {isAbsolute, join, relative, sep} from 'node:path';
import type {Database} from 'better-sqlite3';
import {researchStorageRequestSchema, researchStorageUsageSchema, type ResearchStorageUsage} from '../../../shared/schemas/research-storage';
import type {ResearchRepository} from './repository';
import {researchRelativePath} from './research-files';
import type {RocPluginContext} from '../../kernel/types';

type RootKind = ResearchStorageUsage['roots'][number]['kind'];
type Group = ResearchStorageUsage['groups'][number];
type Binding = Pick<Group, 'type' | 'retention' | 'scope'> & {foreign: boolean};
export type ResearchStorageRoots = Record<RootKind, string | null>;
export const researchStorageCapability = {name: 'research.storage.usage', version: '1.0.0',
  inputSchema: researchStorageRequestSchema, outputSchema: researchStorageUsageSchema};
export function registerResearchStorageCapability(context: RocPluginContext, service: ResearchStorageUsageService): void {
  context.capabilities.register(context.pluginId, researchStorageCapability, input => service.get(researchStorageRequestSchema.parse(input)));
}

/** Observational inventory only. It never opens user workspaces or mutates managed storage. */
export class ResearchStorageUsageService {
  constructor(private readonly db: Database, private readonly research: ResearchRepository, private readonly paths: ResearchStorageRoots) {}
  async get(input: {projectId: string}): Promise<ResearchStorageUsage> {
    const {projectId} = researchStorageRequestSchema.parse(input); this.research.getProject(projectId);
    const bindings = this.bindings(projectId), roots: ResearchStorageUsage['roots'] = [], groups = new Map<string, Group>();
    const seen = new Map<string, Set<string>>(), resolvedRoots: string[] = []; let entries = 0;
    for (const kind of Object.keys(this.paths) as RootKind[]) {
      const path = this.paths[kind];
      if (path === null) {roots.push({kind, state: 'unconfigured'}); continue;}
      if (!isAbsolute(path)) throw new Error('research_storage_root_invalid');
      let info;
      try {info = await lstat(path);} catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        roots.push({kind, state: 'missing'}); continue;
      }
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('research_storage_root_invalid');
      const root = await realpath(path);
      if (resolvedRoots.some(other => {const a = relative(other, root), b = relative(root, other);
        return a === '' || !a.startsWith(`..${sep}`) && a !== '..' && !isAbsolute(a) || !b.startsWith(`..${sep}`) && b !== '..' && !isAbsolute(b);})) {
        throw new Error('research_storage_roots_overlap');
      }
      resolvedRoots.push(root); roots.push({kind, state: 'scanned'});
      const stack = [''];
      while (stack.length > 0) {
        const directory = stack.pop()!;
        for (const name of await readdir(join(root, directory))) {
          if (++entries > 1_000_000) throw new Error('research_storage_entry_limit');
          const path = directory === '' ? name : `${directory}/${name}`; const file = await lstat(join(root, path));
          if (file.isSymbolicLink() || !file.isDirectory() && !file.isFile()) throw new Error('research_storage_entry_invalid');
          if (file.isDirectory()) {stack.push(path); continue;}
          const binding = (() => {
            let prefix = path;
            while (prefix !== '') {const found = bindings[kind].get(prefix); if (found !== undefined) return found;
              const slash = prefix.lastIndexOf('/'); prefix = slash < 0 ? '' : prefix.slice(0, slash);}
            return undefined;
          })();
          // Known foreign data is omitted; unknown records stay explicit and cannot become deletable cache.
          const type = binding?.type ?? (kind === 'model' ? 'model' : 'other');
          const retention = binding?.retention ?? (kind === 'model' ? 'cache' : 'unclassified');
          const scope = binding?.scope ?? (kind === 'model' ? 'shared' : 'unattributed');
          if (binding?.foreign) continue;
          const key = JSON.stringify([type, retention, scope]); const inode = `${file.dev}:${file.ino}`;
          const inodes = seen.get(key) ?? new Set<string>(); if (inodes.has(inode)) continue;
          inodes.add(inode); seen.set(key, inodes);
          const group = groups.get(key) ?? {type, retention, scope, files: 0, bytes: 0, allocatedBytes: 0};
          group.files++; group.bytes += file.size; group.allocatedBytes += file.blocks * 512; groups.set(key, group);
        }
      }
    }
    const logicalIndex = this.db.prepare(`SELECT COUNT(*) chunks, COALESCE(SUM(length(CAST(c.content AS BLOB))),0) contentBytes,
      COALESCE(SUM((SELECT SUM(length(e.vector_blob)) FROM research_knowledge_embeddings e WHERE e.chunk_id=c.id)),0) embeddingBytes
      FROM research_knowledge_chunks c JOIN research_knowledge_documents d ON d.id=c.document_id
      WHERE c.project_id=? AND d.project_id=?`).get(projectId, projectId);
    this.research.getProject(projectId);
    return researchStorageUsageSchema.parse({contractVersion: 1, projectId, observedAt: new Date().toISOString(), roots,
      groups: [...groups.values()], logicalIndex,
      accounting: 'unique_inode_per_group; shared_project_references_are_not_additive; stat_blocks_not_exclusive_APFS_usage', deletion: 'none'});
  }
  private bindings(projectId: string): Record<RootKind, Map<string, Binding>> {
    const result: Record<RootKind, Map<string, Binding>> = {library: new Map(), index: new Map(), experiment: new Map(), export: new Map(), model: new Map(), resource: new Map()};
    const add = (kind: RootKind, prefix: string, type: Group['type'], retention: Group['retention'], projectIds: string[]) => {
      researchRelativePath(prefix);
      // Foreign references are encoded separately so the scanner can omit them without exposing identities.
      const scope: Group['scope'] = projectIds.length === 1 ? 'project' : 'shared';
      result[kind].set(prefix, {type, retention, scope, foreign: projectIds.length > 0 && !projectIds.includes(projectId)});
    };
    const documents = this.db.prepare('SELECT id,library_item_id,source_path FROM research_documents').all() as {id: string; library_item_id: string; source_path: string}[];
    for (const document of documents) {
      const ids = (this.db.prepare('SELECT project_id FROM research_library_projects WHERE item_id=?').all(document.library_item_id) as {project_id: string}[]).map(r => r.project_id);
      add('library', document.source_path, 'source', 'traceable_source', ids);
      add('library', `documents/${document.id}/runs`, 'ocr', 'retained_record', ids);
      add('library', `documents/${document.id}`, 'other', 'retained_record', ids);
    }
    const projects = this.research.listProjects();
    for (const project of projects) add('index', `sources/${project.id}`, 'source', 'traceable_source', [project.id]);
    const indexRows = this.db.prepare("SELECT project_id,json_extract(payload_json,'$.artifactPath') path FROM research_index_files WHERE payload_json IS NOT NULL AND json_extract(payload_json,'$.artifactPath') IS NOT NULL").all() as {project_id: string; path: string}[];
    const indexOwners = new Map<string, Set<string>>();
    for (const row of indexRows) {const owners = indexOwners.get(row.path) ?? new Set<string>(); owners.add(row.project_id); indexOwners.set(row.path, owners);}
    for (const [path, owners] of indexOwners) add('index', path, 'ocr', 'retained_record', [...owners]);
    for (const [kind, table, idKey, type] of [['experiment', 'research_experiment_executions', 'run_id', 'experiment'],
      ['experiment', 'research_figure_runs', 'run_id', 'figure'], ['export', 'research_export_executions', 'id', 'export']] as const) {
      const rows = this.db.prepare(`SELECT ${idKey} id,project_id,root_path FROM ${table}`).all() as {id: string; project_id: string; root_path: string}[];
      const configured = this.paths[kind];
      if (configured === null && rows.length > 0) throw new Error('research_storage_root_required');
      for (const row of rows) {
        const run = type === 'experiment' ? this.research.experiments.get(row.project_id, row.id) : type === 'figure' ? this.research.figureRuns.get(row.project_id, row.id) : this.research.exports.get(row.project_id, row.id);
        const prefix = researchRelativePath(relative(configured!, row.root_path));
        add(kind, `${prefix}/input`, 'source', 'traceable_source', [row.project_id]);
        const approved = run.artifactId !== null && this.research.getArtifact(run.artifactId).status === 'approved';
        add(kind, `${prefix}/output`, type, approved ? 'approved_artifact' : 'retained_record', [row.project_id]);
        add(kind, `${prefix}/log`, type, 'retained_record', [row.project_id]);
        add(kind, `${prefix}/scratch`, type, 'cache', [row.project_id]);
        add(kind, prefix, type, approved ? 'approved_artifact' : 'retained_record', [row.project_id]);
      }
    }
    for (const project of projects) add('resource', createHash('sha256').update(project.id).digest('hex'), 'model', 'traceable_source', [project.id]);
    return result;
  }
}
