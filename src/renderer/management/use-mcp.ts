import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useSWR from 'swr';
import type {
  AgentCapabilityPreview,
  McpServerConfig,
  McpServerSnapshot,
  McpServersConfig,
  McpServerTestResult
} from '../../shared/types';
import type { AsyncStatus } from '../app/use-async-resource';
import { errorMessage } from '../app/loaded-state';
import { IpcResourceError, unwrapIpcResource } from '../app/ipc-resource';
import type { RocClient } from '../shared/roc-client';
import { notifySettingsChanged, useSettingsRevision } from '../shared/settings-events';
import { projectMcpRows, type McpRow } from '../shared/mcp-state';
import {
  deleteMcpServer,
  ensureExaPreset,
  getMcpConfig,
  listMcpServers,
  setMcpApprovalMode,
  setMcpServerEnabled,
  testMcpServer,
  upsertMcpServer
} from '../shared/mcp-store';
import { getCapabilityPreview } from './management-store';
import { useOptimisticFlags } from './use-optimistic-flags';
import { draftFromServer, emptyMcpDraft, toServerConfig, validateMcpDraft, type McpDraft, type McpDraftIssue } from './mcp-model';

/**
 * MCP data (P9/T9.3).
 *
 * ## Two reads, merged by id
 *
 * `mcp.getConfig` is the authoring view (`url`/`command`/`allowedTools`/`preset`/`riskLevel`) and
 * `mcp.listServers` is the runtime snapshot (`status`/`tools`/`lastError`); neither is the whole
 * truth, so the rows carry both and the UI renders what each one actually knows.
 *
 * ## The tool list is a preview of the current authored configuration
 *
 * `mcp.tools.get` exists in the plugin but has no IPC channel (B25), so per-server tool names come
 * from `agent.getCapabilityPreview`. Enabled ids form its request; authored fields, skill ids and
 * refresh revisions form its freshness key. Command and allow-list edits invalidate the preview
 * even when the enabled ids stay the same. Pending reads and mutations hide the previous result.
 *
 * ## `preset` is not editable
 *
 * It marks the built-in Exa server and is preserved from the existing record on save (see
 * `toServerConfig`); the preset button only materialises it.
 */

export type McpStore = {
  status: AsyncStatus;
  error: string | null;
  config: McpServersConfig | null;
  servers: McpServerSnapshot[];
  rows: McpRow[];
  runtimeError: string | null;
  approvalMode: { pending: boolean; error: string | null; run: (mode: McpServersConfig['approvalMode']) => Promise<boolean> };
  /** `checked` for the row toggle: the pending intent, else the config. */
  serverEnabled: (server: McpServerConfig) => boolean;
  reload: () => void;
  editingId: string | null;
  draft: McpDraft | null;
  issues: McpDraftIssue[];
  startCreate: () => void;
  startEdit: (server: McpServerConfig) => void;
  cancelEdit: () => void;
  setDraft: (next: McpDraft) => void;
  save: { pending: boolean; error: string | null; run: () => Promise<boolean> };
  remove: { pending: boolean; error: string | null; run: (serverId: string) => Promise<boolean> };
  toggle: { pending: boolean; error: string | null; run: (serverId: string, enabled: boolean) => Promise<boolean> };
  test: {
    pending: boolean;
    error: string | null;
    results: Record<string, McpServerTestResult>;
    run: (serverId: string) => Promise<boolean>;
  };
  preset: { pending: boolean; error: string | null; run: () => Promise<boolean> };
  preview: AgentCapabilityPreview | null;
  previewStatus: AsyncStatus;
  previewError: string | null;
  reloadPreview: () => void;
};

type McpResourceSnapshot = {
  config: McpServersConfig;
  servers: McpServerSnapshot[];
  runtimeError: string | null;
};

const MCP_RESOURCE_KEY = ['management', 'mcp', 'snapshot'] as const;

function upsertServerInMcpSnapshot(
  snapshot: McpResourceSnapshot | undefined,
  server: McpServerConfig
): McpResourceSnapshot | undefined {
  if (snapshot === undefined) {
    return snapshot;
  }
  const servers = [...snapshot.config.servers];
  const existingIndex = servers.findIndex((item) => item.id === server.id);
  if (existingIndex === -1) {
    servers.push(server);
  } else {
    servers[existingIndex] = server;
  }
  return { ...snapshot, config: { ...snapshot.config, servers } };
}

export function useMcp(client: RocClient, enabledSkillIds: readonly string[] | null): McpStore {
  const settingsRevision = useSettingsRevision();
  const resource = useSWR<McpResourceSnapshot, IpcResourceError>(
    MCP_RESOURCE_KEY,
    async () => {
      const [configResult, serversResult] = await Promise.all([getMcpConfig(client), listMcpServers(client)]);
      const config = unwrapIpcResource(configResult);
      return {
        config,
        servers: serversResult.ok ? serversResult.data : [],
        runtimeError: serversResult.ok ? null : serversResult.error.message
      };
    },
    { keepPreviousData: false, shouldRetryOnError: false }
  );
  let status: AsyncStatus;
  if (resource.isValidating) {
    status = 'loading';
  } else if (resource.error !== undefined) {
    status = 'error';
  } else if (resource.data !== undefined) {
    status = 'ready';
  } else {
    status = 'idle';
  }
  const error = resource.isValidating ? null : resource.error?.message ?? null;
  const config = resource.data?.config ?? null;
  const servers = resource.data?.servers ?? [];
  const runtimeError = resource.data?.runtimeError ?? null;
  const [reloadNonce, setReloadNonce] = useState(0);
  const settingsRevisionRef = useRef(settingsRevision);
  const [approvalPending, setApprovalPending] = useState(false);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraftState] = useState<McpDraft | null>(null);
  const [pending, setPending] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  // Same as `use-skills`: depend on the stable `clear` rather than the whole flags object.
  const { valueFor: flagValueFor, set: setFlag, clear: clearFlags } = useOptimisticFlags();
  const [togglePending, setTogglePending] = useState(false);
  const [removePending, setRemovePending] = useState(false);
  const [testPending, setTestPending] = useState(false);
  const [presetPending, setPresetPending] = useState(false);
  const [testResults, setTestResults] = useState<Record<string, McpServerTestResult>>({});

  const refreshResource = useCallback(() => {
    void resource.mutate().catch(() => undefined);
  }, [resource.mutate]);
  const reload = useCallback(() => {
    setReloadNonce((current) => current + 1);
    refreshResource();
  }, [refreshResource]);

  useEffect(() => {
    if (settingsRevisionRef.current !== settingsRevision) {
      settingsRevisionRef.current = settingsRevision;
      refreshResource();
    }
  }, [refreshResource, settingsRevision]);

  useEffect(() => {
    if (resource.data !== undefined) {
      // A fresh config read is the authority again: drop any pending toggle intent.
      clearFlags();
    }
  }, [resource.data, clearFlags]);

  /* -------------------------------------------------------------- */
  /* Capability preview (per-server tool names)                      */
  /* -------------------------------------------------------------- */

  const enabledServerIds = useMemo(() => {
    const ids: string[] = [];
    for (const server of config?.servers ?? []) {
      if (server.enabled) {
        ids.push(server.id);
      }
    }
    return ids;
  }, [config]);
  // Include authored fields, not just enabled ids: editing a command or allow-list changes tools.
  const previewKey = JSON.stringify([config, enabledSkillIds, reloadNonce, settingsRevision]);
  const [previewData, setPreview] = useState<AgentCapabilityPreview | null>(null);
  const [previewDataKey, setPreviewDataKey] = useState<string | null>(null);
  const [loadedPreviewStatus, setPreviewStatus] = useState<AsyncStatus>('loading');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPreview(null);
    setPreviewError(null);
    setPreviewStatus('loading');
    if (status !== 'ready' || enabledSkillIds === null || togglePending || pending || removePending || presetPending || approvalPending) return;
    setPreviewDataKey(previewKey);
    void (async () => {
      try {
        const result = await getCapabilityPreview(client, {
          mcpServers: enabledServerIds,
          skills: [...enabledSkillIds],
          mode: 'chat'
        });
        if (cancelled) {
          return;
        }
        if (!result.ok) {
          setPreviewStatus('error');
          setPreviewError(result.error.message);
          setPreview(null);
          return;
        }
        setPreview(result.data);
        setPreviewDataKey(previewKey);
        setPreviewStatus('ready');
        setPreviewError(null);
      } catch (caught) {
        if (!cancelled) {
          setPreviewStatus('error');
          setPreviewError(errorMessage(caught));
          setPreview(null);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // The serialized key tracks authored values without depending on fresh array identities.
  }, [client, previewKey, previewNonce, status, togglePending, pending, removePending, presetPending, approvalPending]);

  const reloadPreview = useCallback(() => {
    setPreview(null);
    setPreviewStatus('loading');
    setPreviewNonce((current) => current + 1);
  }, []);

  /* -------------------------------------------------------------- */
  /* Draft + mutations                                               */
  /* -------------------------------------------------------------- */

  const issues = useMemo(() => (draft === null ? [] : validateMcpDraft(draft)), [draft]);

  const setDraft = useCallback((next: McpDraft) => {
    setDraftState(next);
    setMutationError(null);
  }, []);

  const startCreate = useCallback(() => {
    setEditingId(null);
    setDraftState(emptyMcpDraft());
    setMutationError(null);
  }, []);

  const startEdit = useCallback((server: McpServerConfig) => {
    setEditingId(server.id);
    setDraftState(draftFromServer(server));
    setMutationError(null);
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setDraftState(null);
    setMutationError(null);
  }, []);

  const save = useCallback(async (): Promise<boolean> => {
    if (draft === null || issues.length > 0) {
      return false;
    }
    const existing = (config?.servers ?? []).find((server) => server.id === draft.id.trim()) ?? null;
    // Creating a *new* server must not silently overwrite an existing one with the same id.
    if (editingId === null && existing !== null) {
      setMutationError(`id ${draft.id.trim()} 已被占用；换成别的 id，或先选中它再编辑。`);
      return false;
    }
    setPending(true);
    setMutationError(null);
    try {
      const result = await upsertMcpServer(client, toServerConfig(draft, existing));
      if (!result.ok) {
        setMutationError(result.error.message);
        return false;
      }
      await resource.mutate((current) => upsertServerInMcpSnapshot(current, result.data), { revalidate: false });
      setEditingId(result.data.id);
      setDraftState(draftFromServer(result.data));
      setTestResults((current) => {
        const next = { ...current };
        delete next[result.data.id];
        return next;
      });
      reloadPreview();
      // `settings.get()` carries `mcpServers`, so a consumer's cached configuration is stale now.
      notifySettingsChanged();
      return true;
    } catch (caught) {
      setMutationError(errorMessage(caught));
      return false;
    } finally {
      setPending(false);
    }
  }, [client, config, draft, editingId, issues.length, reloadPreview, resource.mutate]);

  const remove = useCallback(
    async (serverId: string): Promise<boolean> => {
      setRemovePending(true);
      setMutationError(null);
      try {
        const result = await deleteMcpServer(client, serverId);
        if (!result.ok) {
          setMutationError(result.error.message);
          return false;
        }
        if (editingId === serverId) {
          setEditingId(null);
          setDraftState(null);
        }
        notifySettingsChanged();
        return true;
      } catch (caught) {
        setMutationError(errorMessage(caught));
        return false;
      } finally {
        setRemovePending(false);
      }
    },
    [client, editingId]
  );

  const toggle = useCallback(
    async (serverId: string, enabled: boolean): Promise<boolean> => {
      setTogglePending(true);
      setMutationError(null);
      // Move the box now; the config read below makes the backend the authority again.
      setFlag(serverId, enabled);
      try {
        const result = await setMcpServerEnabled(client, { id: serverId, enabled });
        if (!result.ok) {
          setMutationError(result.error.message);
          // The toggle moved optimistically; a refusal must put it back to the snapshot's value.
          clearFlags();
          return false;
        }
        reloadPreview();
        notifySettingsChanged();
        return true;
      } catch (caught) {
        clearFlags();
        setMutationError(errorMessage(caught));
        return false;
      } finally {
        setTogglePending(false);
      }
    },
    [client, setFlag, clearFlags, reloadPreview]
  );

  const test = useCallback(
    async (serverId: string): Promise<boolean> => {
      setTestPending(true);
      setMutationError(null);
      try {
        const result = await testMcpServer(client, serverId);
        if (!result.ok) {
          setMutationError(result.error.message);
          return false;
        }
        setTestResults((current) => ({ ...current, [serverId]: result.data }));
        reload();
        return true;
      } catch (caught) {
        setMutationError(errorMessage(caught));
        return false;
      } finally {
        setTestPending(false);
      }
    },
    [client, reload]
  );

  const preset = useCallback(async (): Promise<boolean> => {
    setPresetPending(true);
    setMutationError(null);
    try {
      const result = await ensureExaPreset(client);
      if (!result.ok) {
        setMutationError(result.error.message);
        return false;
      }
      setEditingId(result.data.id);
      setDraftState(draftFromServer(result.data));
      // `settings.get()` carries `mcpServers`, so a consumer's cached configuration is stale now.
      notifySettingsChanged();
      return true;
    } catch (caught) {
      setMutationError(errorMessage(caught));
      return false;
    } finally {
      setPresetPending(false);
    }
  }, [client]);

  const approvalMode = useCallback(async (mode: McpServersConfig['approvalMode']): Promise<boolean> => {
    setApprovalPending(true);
    setMutationError(null);
    try {
      const result = await setMcpApprovalMode(client, mode);
      if (!result.ok) { setMutationError(result.error.message); return false; }
      notifySettingsChanged();
      return true;
    } catch (caught) {
      setMutationError(errorMessage(caught));
      return false;
    } finally { setApprovalPending(false); }
  }, [client]);

  const previewCurrent = status === 'ready' && previewDataKey === previewKey
    && !togglePending && !pending && !removePending && !presetPending && !approvalPending;
  const previewStatus: AsyncStatus = enabledSkillIds === null ? 'idle'
    : status === 'error' ? 'error' : !previewCurrent ? 'loading' : loadedPreviewStatus;
  const preview = previewCurrent && previewStatus === 'ready' ? previewData : null;
  const rows = useMemo(() => projectMcpRows({
    config, servers, enabled: (server) => flagValueFor(server.id, server.enabled),
    tests: testResults, preview, previewStatus
  }), [config, servers, flagValueFor, testResults, preview, previewStatus]);

  return useMemo(
    () => ({
      status,
      error,
      config,
      servers,
      rows,
      runtimeError,
      approvalMode: { pending: approvalPending, error: mutationError, run: approvalMode },
      serverEnabled: (server: McpServerConfig) => flagValueFor(server.id, server.enabled),
      reload,
      editingId,
      draft,
      issues,
      startCreate,
      startEdit,
      cancelEdit,
      setDraft,
      save: { pending, error: mutationError, run: save },
      remove: { pending: removePending, error: mutationError, run: remove },
      toggle: { pending: togglePending, error: mutationError, run: toggle },
      test: { pending: testPending, error: mutationError, results: testResults, run: test },
      preset: { pending: presetPending, error: mutationError, run: preset },
      preview,
      previewStatus,
      previewError: status === 'error' ? error : previewError,
      reloadPreview
    }),
    [
      status,
      error,
      config,
      servers,
      rows,
      runtimeError,
      approvalPending,
      approvalMode,
      flagValueFor,
      reload,
      editingId,
      draft,
      issues,
      startCreate,
      startEdit,
      cancelEdit,
      setDraft,
      pending,
      mutationError,
      save,
      removePending,
      remove,
      togglePending,
      toggle,
      testPending,
      testResults,
      test,
      presetPending,
      preset,
      preview,
      previewStatus,
      previewError,
      reloadPreview
    ]
  );
}
