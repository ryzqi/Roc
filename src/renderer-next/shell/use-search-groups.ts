import { useMemo } from 'react';
import type { ResearchLibraryItem } from '../../shared/types';
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
  /** Current project, used for the literature and concept groups (P5). */
  projectId: string | null;
  /** Library hits from the shared literature store (already fetched for the panel). */
  libraryItems: ResearchLibraryItem[];
  /** Derived concept→claim ids, computed from the same real data as the wiki view. */
  concepts: Array<{ id: string; label: string; subtitle: string }>;
  /**
   * True once the project's claims + evidence have loaded.
   *
   * The concept group must distinguish "no concept pages" from "not loaded yet":
   * the store fetches them for the pages that need them, so an eager `ready` group
   * with an empty label would claim there are none when nobody has looked.
   */
  conceptsLoaded: boolean;
  onOpenLiterature: (libraryItemId: string) => void;
  onOpenConcept: (claimId: string) => void;
};

const UNAVAILABLE_GROUPS: Array<{ id: string; label: string; reason: string }> = [
  { id: 'projects', label: '项目', reason: '项目搜索面板尚未接入（P5 统一接线，门户已支持筛选）' },
  { id: 'sessions', label: '会话', reason: 'P4 接入 agent.sessions.search' },
  { id: 'skills', label: '技能', reason: 'P9 接入 skills.list' },
  { id: 'artifacts', label: '产物', reason: 'P6 接入 research.artifacts.list' }
];

function previewLine(preview: string): string {
  const trimmed = preview.trim();
  return trimmed.length > 120 ? `${trimmed.slice(0, 119)}…` : trimmed;
}

export function useSearchGroups({
  client,
  query,
  workspacePath,
  openFile,
  projectId,
  libraryItems,
  concepts,
  conceptsLoaded,
  onOpenLiterature,
  onOpenConcept
}: SearchGroupSources): SearchGroup[] {
  const files = useFileSearchGroups(client, workspacePath, query);

  return useMemo(() => {
    /**
     * Literature and concept groups are filtered from the store's own snapshot.
     *
     * Deliberately **not** a second `library.list` call: the palette opens on top
     * of the hub, which already holds the server-side query result for the same
     * project, and firing a second query on every keystroke would double the IPC
     * traffic to answer something already on screen. The consequence is stated in
     * the group's reason line: this matches the currently loaded page.
     */
    const trimmed = query.trim().toLowerCase();
    const literatureGroup: SearchGroup =
      projectId === null
        ? { id: 'literature', label: '文献', status: 'unavailable', items: [], unavailableReason: '尚未进入项目' }
        : {
            id: 'literature',
            label: '文献',
            status: 'ready',
            emptyLabel: '当前加载的文献里没有匹配',
            items:
              trimmed.length === 0
                ? []
                : libraryItems
                    .filter((item) => {
                      const title = item.metadata.title.toLowerCase();
                      const authors = item.metadata.authors.join(' ').toLowerCase();
                      return title.includes(trimmed) || authors.includes(trimmed) || item.bibliography.citationKey.toLowerCase().includes(trimmed);
                    })
                    .slice(0, 8)
                    .map((item) => ({
                      id: `library:${item.id}`,
                      title: item.metadata.title.trim().length > 0 ? item.metadata.title : item.bibliography.title,
                      subtitle: item.metadata.authors.slice(0, 2).join(' · '),
                      onOpen: () => onOpenLiterature(item.id)
                    }))
          };

    const conceptGroup: SearchGroup =
      projectId === null
        ? { id: 'concepts', label: '概念', status: 'unavailable', items: [], unavailableReason: '尚未进入项目' }
        : !conceptsLoaded
          ? {
              id: 'concepts',
              label: '概念',
              status: 'loading',
              items: [],
              unavailableReason: '概念页按需加载（打开「知识库」或「图谱」后可用）'
            }
          : {
              id: 'concepts',
              label: '概念',
              status: 'ready',
              emptyLabel: '尚无概念页（先捕获证据并建立主张）',
              items:
                trimmed.length === 0
                  ? []
                  : concepts
                      .filter((concept) => concept.label.toLowerCase().includes(trimmed))
                      .slice(0, 8)
                      .map((concept) => ({
                        id: `concept:${concept.id}`,
                        title: concept.label,
                        subtitle: concept.subtitle,
                        onOpen: () => onOpenConcept(concept.id)
                      }))
            };

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

    // Order mirrors the P1 palette: project-ish first, then the domain groups,
    // then files, then the later phases. Inserting at fixed positions keeps the
    // order stable even when a group is unavailable.
    const [projects, ...rest] = unavailable;
    return [projects!, literatureGroup, conceptGroup, ...fileGroups, ...rest];
  }, [concepts, conceptsLoaded, files, libraryItems, onOpenConcept, onOpenLiterature, openFile, projectId, query, workspacePath]);
}
