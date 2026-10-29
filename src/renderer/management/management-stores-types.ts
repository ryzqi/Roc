import type { DrawerSectionId } from '../../shared/surfaces';
import type { BackgroundTasksStore } from './use-background-tasks';
import type { McpStore } from './use-mcp';
import type { MemoryFilesStore } from './use-memory';
import type { SkillsStore } from './use-skills';
import type { StoreApi } from 'zustand/vanilla';

export type ManagementTabId = DrawerSectionId;

export type ManagementStores = {
  memory: MemoryFilesStore;
  skills: SkillsStore;
  mcp: McpStore;
  tasks: BackgroundTasksStore;
  summaries: Record<ManagementTabId, string>;
};

export type ManagementStoresSnapshot = ManagementStores | null;
export type ManagementStoresApi = StoreApi<ManagementStoresSnapshot>;
