import type { ResearchTemplate, ResearchTemplateFile, ResearchTemplateFileContent } from '../../../shared/types';
import { unwrap } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { createProjectionController } from './research-projection';

export type ResearchTemplateAdapter = {
  list(request: { projectId: string }): Promise<ResearchTemplate[]>;
  files(request: { projectId: string; templateId: string }): Promise<ResearchTemplateFile[]>;
  importTemplate(request: { projectId: string; sourcePath: string }): Promise<ResearchTemplate>;
  readFile(request: { projectId: string; templateId: string; path: string }): Promise<ResearchTemplateFileContent>;
  saveFile(request: { projectId: string; templateId: string; path: string; content: string; expectedHash: string }): Promise<ResearchTemplateFileContent>;
  compile(request: { projectId: string; templateId: string }): Promise<unknown>;
  selectFile(): Promise<string | null>;
};

export type ResearchTemplateSnapshot = {
  templates: ResearchTemplate[];
  files: ResearchTemplateFile[];
  selectedTemplateId: string | null;
  openFile: ResearchTemplateFileContent | null;
  working: boolean;
  error: string | null;
};

export type ResearchTemplateProjection = {
  getSnapshot(): ResearchTemplateSnapshot;
  subscribe(listener: (snapshot: ResearchTemplateSnapshot) => void): () => void;
  setProject(projectId: string | null): void;
  setOpenContent(value: string): void;
  select(templateId: string): Promise<void>;
  load(): Promise<void>;
  importTemplate(): Promise<void>;
  openFile(path: string): Promise<void>;
  save(): Promise<void>;
  compile(): Promise<void>;
  clearError(): void;
};

const emptySnapshot = (): ResearchTemplateSnapshot => ({
  templates: [],
  files: [],
  selectedTemplateId: null,
  openFile: null,
  working: false,
  error: null
});

export function createResearchTemplateProjection(adapter: ResearchTemplateAdapter): ResearchTemplateProjection {
  const projection = createProjectionController<ResearchTemplateSnapshot>({
    empty: emptySnapshot,
    copy(value) {
      return { ...value, templates: [...value.templates], files: [...value.files] };
    }
  });
  let projectId: string | null = null;

  async function load(token: number, templateId = projection.peek().selectedTemplateId): Promise<void> {
    if (projectId === null) {
      projection.assign({ templates: [], files: [], selectedTemplateId: null, openFile: null });
      return;
    }
    const listed = await adapter.list({ projectId });
    if (!projection.isCurrent(token)) return;
    const selected = listed.find((item) => item.id === templateId) ?? listed[0] ?? null;
    if (selected === null) {
      projection.assign({ templates: listed, selectedTemplateId: null, files: [], openFile: null });
      return;
    }
    const files = await adapter.files({ projectId, templateId: selected.id });
    if (!projection.isCurrent(token)) return;
    projection.assign({ templates: listed, selectedTemplateId: selected.id, files });
  }

  return {
    getSnapshot() { return projection.getSnapshot(); },
    subscribe(listener) { return projection.subscribe(listener); },
    setProject(next) { projectId = next; },
    setOpenContent(value) {
      const openFile = projection.peek().openFile;
      if (openFile === null) return;
      projection.assign({ openFile: { ...openFile, content: value } });
    },
    async select(templateId) {
      projection.assign({ selectedTemplateId: templateId, openFile: null });
      await projection.runExclusive(async (token) => {
        await load(token, templateId);
      }, { busy: '当前命令仍在进行。', failed: '模板加载失败。' });
    },
    async load() {
      await projection.runExclusive(async (token) => { await load(token); }, { busy: '当前命令仍在进行。', failed: '模板加载失败。' });
    },
    async importTemplate() {
      if (projectId === null) return;
      const currentProjectId = projectId;
      const sourcePath = await adapter.selectFile();
      if (sourcePath === null) return;
      await projection.runExclusive(async (token) => {
        const imported = await adapter.importTemplate({ projectId: currentProjectId, sourcePath });
        if (!projection.isCurrent(token)) return;
        projection.assign({ selectedTemplateId: imported.id, openFile: null });
        await load(token, imported.id);
      }, { busy: '当前命令仍在进行。', failed: '导入模板失败。' });
    },
    async openFile(path) {
      if (projectId === null || projection.peek().selectedTemplateId === null) return;
      const currentProjectId = projectId;
      const selectedTemplateId = projection.peek().selectedTemplateId;
      if (selectedTemplateId === null) return;
      await projection.runExclusive(async (token) => {
        const openFile = await adapter.readFile({
          projectId: currentProjectId,
          templateId: selectedTemplateId,
          path
        });
        if (!projection.isCurrent(token)) return;
        projection.assign({ openFile });
      }, { busy: '当前命令仍在进行。', failed: '读取模板文件失败。' });
    },
    async save() {
      const openFile = projection.peek().openFile;
      const selectedTemplateId = projection.peek().selectedTemplateId;
      if (projectId === null || selectedTemplateId === null || openFile === null) return;
      const currentProjectId = projectId;
      await projection.runExclusive(async (token) => {
        const saved = await adapter.saveFile({
          projectId: currentProjectId,
          templateId: selectedTemplateId,
          path: openFile.path,
          content: openFile.content,
          expectedHash: openFile.sha256
        });
        if (!projection.isCurrent(token)) return;
        projection.assign({ openFile: saved });
        await load(token, selectedTemplateId);
      }, { busy: '当前命令仍在进行。', failed: '保存模板文件失败。' });
    },
    async compile() {
      const selectedTemplateId = projection.peek().selectedTemplateId;
      if (projectId === null || selectedTemplateId === null) return;
      const currentProjectId = projectId;
      await projection.runExclusive(async (token) => {
        await adapter.compile({ projectId: currentProjectId, templateId: selectedTemplateId });
        if (!projection.isCurrent(token)) return;
        await load(token, selectedTemplateId);
      }, { busy: '当前命令仍在进行。', failed: '编译模板失败。' });
    },
    clearError() { projection.clearError(); }
  };
}

export function createResearchTemplateAdapter(client: RocClient): ResearchTemplateAdapter {
  const research = client.api.research;
  return {
    async list(request) { return unwrap('模板', await research.listTemplates(request)); },
    async files(request) { return unwrap('模板文件', await research.getTemplateFiles(request)); },
    async importTemplate(request) { return unwrap('导入模板', await research.importTemplate(request)); },
    async readFile(request) { return unwrap('读取模板文件', await research.readTemplateFile(request)); },
    async saveFile(request) { return unwrap('保存模板文件', await research.saveTemplateFile(request)); },
    async compile(request) { return unwrap('编译模板', await research.compileTemplate(request)); },
    async selectFile() {
      const selection = unwrap('选择模板', await client.api.files.selectFromDialog());
      return selection?.filePaths[0] ?? null;
    }
  };
}
