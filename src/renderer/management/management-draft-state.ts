import type { ManagementStores } from './management-stores-types';

/** Drawer and canvas share the same authored drafts and operation boundaries. */
export function managementDraftState(stores: ManagementStores | null): { busy: boolean; sections: string[] } {
  if (stores === null) return { busy: false, sections: [] };
  const { memory, mcp, tasks } = stores;
  return {
    busy: memory.isBusy() || mcp.isBusy() || tasks.isBusy(),
    sections: [
      ...(memory.dirtyCount > 0 ? [`记忆文件 ${memory.dirtyCount} 份`] : []),
      ...(mcp.dirty ? ['MCP 配置'] : []),
      ...(tasks.dirty ? ['后台任务'] : [])
    ]
  };
}

export function discardManagementDrafts(stores: ManagementStores | null): void {
  if (stores === null || managementDraftState(stores).busy) return;
  stores.memory.discardAll();
  stores.mcp.cancelEdit();
  stores.tasks.cancelEdit();
}
