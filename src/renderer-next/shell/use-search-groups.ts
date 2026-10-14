import { useMemo } from 'react';
import type { RocClient } from '../shared/roc-client';
import { useFileSearchGroups } from '../workspace/use-file-search';
import type { SearchGroup } from './SearchPaletteModal';

/**
 * ⌘K search groups (P3/T3.4).
 *
 * P1 shipped the palette with every group declared `unavailable` and a reason,
 * because a group that silently disappears reads as "no matches". P3 makes the
 * two **file** groups real — name and content are different backend queries, so
 * they are different groups — and leaves the rest explicitly unavailable with
 * the phase that owns them, which is honest rather than empty.
 *
 * There is deliberately no "search everything at once" call here: when a group's
 * query fails it fails alone, and the palette renders its own warning.
 */

export type SearchGroupSources = {
  client: RocClient;
  query: string;
  /** Bound workspace path, or null when the project has none. */
  workspacePath: string | null;
  openFile: (relativePath: string) => void;
};

const UNAVAILABLE_GROUPS: Array<{ id: string; label: string; reason: string }> = [
  { id: 'projects', label: '项目', reason: '项目搜索面板尚未接入（P5 统一接线，门户已支持筛选）' },
  { id: 'literature', label: '文献', reason: 'P5 接入 research.library.list' },
  { id: 'sessions', label: '会话', reason: 'P4 接入 agent.sessions.search' },
  { id: 'skills', label: '技能', reason: 'P9 接入 skills.list' },
  { id: 'concepts', label: '概念', reason: 'P5 接入派生 wiki' },
  { id: 'artifacts', label: '产物', reason: 'P6 接入 research.artifacts.list' }
];

function previewLine(preview: string): string {
  const trimmed = preview.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 119)}…` : trimmed;
}

export function useSearchGroups({ client, query, workspacePath, openFile }: SearchGroupSources): SearchGroup[] {
  const files = useFileSearchGroups(client, workspacePath, query);

  return useMemo(() => {
    const fileGroups: SearchGroup[] = [
      {
        id: 'file-names',
        label: '文件名',
        status:
          workspacePath === null
            ? 'unavailable'
            : files.namesError !== null
              ? 'unavailable'
              : files.loading && files.names === null
                ? 'loading'
                : 'ready',
        unavailableReason:
          workspacePath === null ? '项目未绑定工作目录' : (files.namesError ?? undefined),
        emptyLabel: '没有匹配的文件名',
        items: (files.names?.matches ?? []).map((match) => ({
          id: `name:${match.relativePath}`,
          title: match.name,
          subtitle: match.relativePath,
          onOpen: () => openFile(match.relativePath)
        }))
      },
      {
        id: 'file-contents',
        label: '文件内容',
        status:
          workspacePath === null
            ? 'unavailable'
            : files.contentsError !== null
              ? 'unavailable'
              : files.loading && files.contents === null
                ? 'loading'
                : 'ready',
        unavailableReason:
          workspacePath === null ? '项目未绑定工作目录' : (files.contentsError ?? undefined),
        emptyLabel: '没有匹配的文件内容',
        items: (files.contents?.matches ?? []).map((match) => ({
          id: `content:${match.relativePath}:${match.line}:${match.column}`,
          title: `${match.relativePath}:${match.line}`,
          subtitle: previewLine(match.preview),
          onOpen: () => openFile(match.relativePath)
        }))
      }
    ];

    const unavailable = UNAVAILABLE_GROUPS.map<SearchGroup>((group) => ({
      id: group.id,
      label: group.label,
      status: 'unavailable',
      items: [],
      unavailableReason: group.reason
    }));

    // Order mirrors the P1 palette: project-ish first, then files, then the
    // later phases. Inserting at a fixed index keeps the order stable even when
    // a group is unavailable.
    const [projects, ...rest] = unavailable;
    return [projects!, ...fileGroups, ...rest];
  }, [files, openFile, workspacePath]);
}
