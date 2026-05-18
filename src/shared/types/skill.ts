export type SkillSnapshot = {
  id: string;
  name: string;
  enabled: boolean;
  path: string;
  description: string;
  status: 'ready' | 'invalid';
  lastError?: string | null;
};

export type SkillFileEntry = {
  name: string;
  relativePath: string;
  type: 'file' | 'directory';
  size: number;
  updatedAt: string;
};

export type SkillFileTreeRequest = {
  id: string;
  relativePath: string;
};

export type SkillFileTreeResult = {
  id: string;
  rootPath: string;
  relativePath: string;
  entries: SkillFileEntry[];
  truncated: boolean;
};

export type SkillFilePreviewRequest = {
  id: string;
  relativePath: string;
  maxBytes?: number;
};

export type SkillFilePreviewResult = {
  id: string;
  relativePath: string;
  kind: 'text' | 'image' | 'binary';
  content: string;
  truncated: boolean;
  sizeBytes: number;
  mediaType?: string;
};

export type SkillImportRequest = {
  sourcePath: string;
  id?: string;
};
