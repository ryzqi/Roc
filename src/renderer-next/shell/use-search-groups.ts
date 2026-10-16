import { useMemo } from 'react';
import type { ResearchLibraryItem } from '../../shared/types';
import { useAsyncResource } from '../app/use-async-resource';
import { useDebouncedValue } from '../app/use-debounced-value';
import type { RocClient } from '../shared/roc-client';
import { useFileSearchGroups } from '../workspace/use-file-search';
import type { SearchGroup } from './SearchPaletteModal';

/**
 * ⌘K search groups (P3/T3.4, P5/T5.8).
 *
 * P1 shipped the palette with every group declared `unavailable` and a reason,
 * because a group that silently disappears reads as "no matches". P3 makes the
 * two **file** groups real — name and content are different backend queries, so
 * they are different groups. P5 adds the three project-scoped groups a user can
 * actually act on: 项目 (portal), 文献 (the shared library store) and 概念 (the same
 * `deriveWiki` projection the 知识库 panel renders), plus 会话 via
 * `agent.sessions.search`.
 *
 * The remaining declared-but-unavailable groups name the phase that owns them.
 * There is deliberately no "search everything at once" call: when a group's query
 * fails it fails alone, and the palette renders its own warning.
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
  /** Opens the project portal entry, or switches to it when it is already current. */
  onOpenProject: (projectId: string) => void;
  /** Opens the assistant panel on this thread. */
  onOpenSession: (threadId: string) => void;
  /**
   * Opens one management group as a canvas view (`?view=memory|skills|mcp|tasks`).
   *
   * The palette is where 「管理」 becomes reachable without the drawer: the three views exist in the
   * frozen route contract, and the skills group below is a real `skills.list` query rather than the
   * P1 placeholder that promised "P9 接入" (F24).
   */
  onOpenManagementView: (tab: 'memory' | 'skills' | 'mcp' | 'tasks') => void;
  /**
   * Bumped every time the palette opens.
   *
   * The project list has no server-side query to key on, so without this the
   * resource would fetch once at mount and keep that snapshot forever — 新建项目之后
   * ⌘K 永远搜不到它（同一个“读一次就不管”缺陷，P4 在会话列表上踩过一次）。
   */
  searchToken: number;
};

const UNAVAILABLE_GROUPS: Array<{ id: string; label: string; reason: string }> = [
  {
    // P6 lists artifacts inside the stage workspace (they hang off a stage artifact), and
    // `research.artifacts.list` needs a project + stage filter to be meaningful. A palette group
    // that ignores the stage would present another project's artifacts as search results, so this
    // one stays out on purpose instead of promising a phase.
    id: 'artifacts',
    label: '产物',
    reason: '产物按阶段列在阶段工作区里（P6）；⌘K 不做全局产物检索'
  }
];

/**
 * Debounce before the session query reaches the backend.
 *
 * Shorter than the file-name debounce would be wasteful here: `sessions.search`
 * runs an FTS query, and typing three characters used to cost three queries.
 */
const SESSION_SEARCH_DEBOUNCE_MS = 200;

/** Projects are listed once — there is no server-side project query to debounce. */
const PROJECT_GROUP_LIMIT = 8;
const SESSION_GROUP_LIMIT = 8;
const SKILL_GROUP_LIMIT = 8;

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
  onOpenConcept,
  onOpenProject,
  onOpenSession,
  onOpenManagementView,
  searchToken
}: SearchGroupSources): SearchGroup[] {
  const files = useFileSearchGroups(client, workspacePath, query);

  /**
   * Session search (`agent.sessions.search`).
   *
   * `workspaceScope: 'all'` on purpose: threads carry no project field at all
   * (`taskThreadSchema`, backend task B12), so a "current workspace" scope would
   * need a hash the palette cannot derive from the project. Searching everything
   * and labelling each hit with its own thread is the honest version of "find a
   * conversation you had".
   */
  const debouncedQuery = useDebouncedValue(query, SESSION_SEARCH_DEBOUNCE_MS);
  const sessionQuery = debouncedQuery.trim();
  const sessions = useAsyncResource(
    sessionQuery.length === 0 ? null : `session-search:${sessionQuery}`,
    () => client.api.sessions.search({ query: sessionQuery, workspaceScope: 'all', limit: SESSION_GROUP_LIMIT }),
    { label: '搜索会话' }
  );
  /** Projects come from the portal's own capability; the list is small and unfiltered by the backend. */
  const projectList = useAsyncResource(`search-projects:${searchToken}`, () => client.api.research.listProjects(), {
    label: '读取项目'
  });
  /**
   * Skills (`skills.list`, no arguments) — filtered here because the capability has no query.
   *
   * Keyed on `searchToken` so a skill imported while the palette was closed is findable on the next
   * open: the same "read once and never again" trap P4's session list and P5's project group hit.
   */
  const skillList = useAsyncResource(`search-skills:${searchToken}`, () => client.api.skills.list(), {
    label: '读取技能'
  });

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

    const projectsGroup = buildProjectGroup(projectList, trimmed, onOpenProject);
    const sessionGroup = buildSessionGroup(sessions, onOpenSession);

    // 「管理」 is a command group: the same three canvas views the drawer can open, reachable from ⌘K.
    const managementGroup: SearchGroup = {
      id: 'management',
      label: '管理',
      status: 'ready',
      emptyLabel: '没有匹配的管理入口',
      items: [
        { id: 'mgmt:memory', title: '记忆', subtitle: 'USER.md / AGENTS.md / MEMORY.md（markdown 内容）', onOpen: () => onOpenManagementView('memory') },
        { id: 'mgmt:skills', title: '技能', subtitle: '安装、启停、浏览技能文件', onOpen: () => onOpenManagementView('skills') },
        { id: 'mgmt:mcp', title: 'MCP', subtitle: '授权服务与工具装配预览', onOpen: () => onOpenManagementView('mcp') },
        { id: 'mgmt:tasks', title: '后台任务', subtitle: '定时任务与调度记录（打开任务是 P6 的任务看板）', onOpen: () => onOpenManagementView('tasks') }
      ].filter((item) => trimmed.length === 0 || item.title.toLowerCase().includes(trimmed) || (item.subtitle ?? '').toLowerCase().includes(trimmed))
    };

    const skillsGroup = buildSkillsGroup(skillList, trimmed, onOpenManagementView);

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
    return [projectsGroup, literatureGroup, conceptGroup, sessionGroup, skillsGroup, managementGroup, ...fileGroups, ...unavailable];
  }, [
    concepts,
    conceptsLoaded,
    files,
    onOpenManagementView,
    libraryItems,
    onOpenConcept,
    onOpenLiterature,
    onOpenProject,
    onOpenSession,
    openFile,
    projectId,
    projectList.data,
    projectList.error,
    projectList.status,
    skillList.data,
    skillList.error,
    skillList.status,
    query,
    searchToken,
    sessions.data,
    sessions.error,
    sessions.status,
    workspacePath
  ]);
}

/**
 * The 项目 group.
 *
 * `research.projects.list` takes no query, so the filter is applied here — the
 * opposite of the literature group's rule, and for the same reason: the backend
 * has no project search to push it down to. The list is a handful of rows, so
 * filtering it locally cannot hide a match behind a limit.
 */
/**
 * The skills group.
 *
 * `skills.list` has no query parameter, so the filter runs here — over the same fields the panel
 * shows (name and description). A hit opens the skills surface rather than deep-linking one skill:
 * the frozen route contract has no per-skill parameter (ADR-M05), and the panel's own selection is
 * what remembers which skill is on screen.
 */
function buildSkillsGroup(
  list: {
    status: 'idle' | 'loading' | 'ready' | 'error';
    data: Array<{ id: string; name: string; description: string; enabled: boolean; status: string }> | null;
    error: string | null;
  },
  trimmedQuery: string,
  onOpenManagementView: (tab: 'memory' | 'skills' | 'mcp' | 'tasks') => void
): SearchGroup {
  if (list.status === 'error') {
    return { id: 'skills', label: '技能', status: 'unavailable', items: [], unavailableReason: list.error ?? '读取技能失败' };
  }
  if (list.status !== 'ready') {
    return { id: 'skills', label: '技能', status: 'loading', items: [], unavailableReason: '正在读取技能' };
  }
  return {
    id: 'skills',
    label: '技能',
    status: 'ready',
    emptyLabel: '没有匹配的技能',
    items: (list.data ?? [])
      .filter((skill) => trimmedQuery.length > 0 && (skill.name.toLowerCase().includes(trimmedQuery) || skill.description.toLowerCase().includes(trimmedQuery)))
      .slice(0, SKILL_GROUP_LIMIT)
      .map((skill) => ({
        id: `skill:${skill.id}`,
        title: skill.name,
        subtitle: `${skill.enabled ? '已启用' : '已停用'} · ${skill.description}`,
        onOpen: () => onOpenManagementView('skills')
      }))
  };
}

function buildProjectGroup(
  list: {
    status: 'idle' | 'loading' | 'ready' | 'error';
    data: Array<{ id: string; title: string; status: string; workspacePath: string | null }> | null;
    error: string | null;
  },
  trimmedQuery: string,
  onOpenProject: (projectId: string) => void
): SearchGroup {
  if (list.status === 'error') {
    return { id: 'projects', label: '项目', status: 'unavailable', items: [], unavailableReason: list.error ?? '读取项目列表失败' };
  }
  if (list.status !== 'ready') {
    return { id: 'projects', label: '项目', status: 'loading', items: [], unavailableReason: '正在读取项目列表' };
  }
  return {
    id: 'projects',
    label: '项目',
    status: 'ready',
    emptyLabel: '没有匹配的项目',
    items: (list.data ?? [])
      .filter((project) => trimmedQuery.length > 0 && project.title.toLowerCase().includes(trimmedQuery))
      .slice(0, PROJECT_GROUP_LIMIT)
      .map((project) => ({
        id: `project:${project.id}`,
        title: project.title,
        subtitle: project.status === 'archived' ? '已归档' : (project.workspacePath ?? '未绑定工作目录'),
        onOpen: () => onOpenProject(project.id)
      }))
  };
}

/**
 * The 会话 group (`agent.sessions.search`).
 *
 * `idle` is a real state and not an error: the palette only queries sessions once
 * there is something to search for, so an empty query must read as "type to
 * search" rather than as "you have no conversations".
 */
function buildSessionGroup(
  search: {
    status: 'idle' | 'loading' | 'ready' | 'error';
    data: {
      items: Array<{
        id: string;
        threadId: string;
        threadTitle: string | null;
        role: string;
        content: string;
        snippet: string;
      }>;
    } | null;
    error: string | null;
  },
  onOpenSession: (threadId: string) => void
): SearchGroup {
  if (search.status === 'idle') {
    return { id: 'sessions', label: '会话', status: 'ready', items: [], emptyLabel: '输入关键词搜索会话消息' };
  }
  if (search.status === 'error') {
    return { id: 'sessions', label: '会话', status: 'unavailable', items: [], unavailableReason: search.error ?? '搜索会话失败' };
  }
  if (search.data === null) {
    return { id: 'sessions', label: '会话', status: 'loading', items: [], unavailableReason: '正在搜索会话' };
  }
  return {
    id: 'sessions',
    label: '会话',
    status: 'ready',
    emptyLabel: '没有匹配的会话消息',
    items: search.data.items.map((message) => ({
      id: `session:${message.id}`,
      title: message.threadTitle ?? message.threadId,
      subtitle: `${message.role} · ${previewLine(message.snippet.length === 0 ? message.content : message.snippet)}`,
      onOpen: () => onOpenSession(message.threadId)
    }))
  };
}
