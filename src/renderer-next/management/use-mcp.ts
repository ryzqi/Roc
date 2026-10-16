import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AgentCapabilityPreview,
  McpServerConfig,
  McpServerSnapshot,
  McpServersConfig,
  McpServerTestResult
} from '../../shared/types';
import type { AsyncStatus } from '../app/use-async-resource';
import { errorMessage } from '../app/loaded-state';
import type { RocClient } from '../shared/roc-client';
import { notifySettingsChanged } from '../shared/settings-events';
import {
  deleteMcpServer,
  ensureExaPreset,
  getMcpConfig,
  listMcpServers,
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
 * ## The tool list is a preview, and it is keyed on the enabled set
 *
 * `mcp.tools.get` exists in the plugin but has no IPC channel (B25), so per-server tool names come
 * from `agent.getCapabilityPreview`. That call is keyed on `{mcpServers, skills}` — the enabled
 * ids — because the preview describes *that*装配: leaving a stale preview on screen after a
 * toggle would be a claim about a configuration that no longer exists. The key is the joined id
 * lists, so any change re-reads.
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
  rows: Array<{ server: McpServerConfig; snapshot: McpServerSnapshot | null }>;
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

export function useMcp(client: RocClient, enabledSkillIds: readonly string[]): McpStore {
  const [config, setConfig] = useState<McpServersConfig | null>(null);
  const [servers, setServers] = useState<McpServerSnapshot[]>([]);
  const [status, setStatus] = useState<AsyncStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

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

  const reload = useCallback(() => {
    setNonce((current) => current + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    void (async () => {
      try {
        const [configResult, serversResult] = await Promise.all([getMcpConfig(client), listMcpServers(client)]);
        if (cancelled) {
          return;
        }
        if (!configResult.ok) {
          setStatus('error');
          setError(configResult.error.message);
          return;
        }
        setConfig(configResult.data);
        // The runtime snapshot may fail on its own (a broken adapter); the config is still usable.
        setServers(serversResult.ok ? serversResult.data : []);
        // A fresh config read is the authority again: drop any pending toggle intent.
        clearFlags();
        setStatus('ready');
        setError(null);
      } catch (caught) {
        if (!cancelled) {
          setStatus('error');
          setError(errorMessage(caught));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, nonce, clearFlags]);

  const rows = useMemo(
    () =>
      (config?.servers ?? []).map((server) => ({
        server,
        snapshot: servers.find((entry) => entry.id === server.id) ?? null
      })),
    [config, servers]
  );

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
  const previewKey = `${enabledServerIds.join(',')}|${[...enabledSkillIds].join(',')}`;
  const [preview, setPreview] = useState<AgentCapabilityPreview | null>(null);
  const [previewStatus, setPreviewStatus] = useState<AsyncStatus>('loading');
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewNonce, setPreviewNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setPreviewStatus('loading');
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
    // Only `previewKey` (the joined enabled id lists) and an explicit reload: the two arrays get a
    // fresh identity on every config/skills read, so depending on them re-ran the preview (an extra
    // IPC) even when the enabled set had not changed.
  }, [client, previewKey, previewNonce]);

  const reloadPreview = useCallback(() => {
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
      setEditingId(result.data.id);
      setDraftState(draftFromServer(result.data));
      reload();
      // `settings.get()` carries `mcpServers`, so a consumer's cached configuration is stale now.
      notifySettingsChanged();
      return true;
    } catch (caught) {
      setMutationError(errorMessage(caught));
      return false;
    } finally {
      setPending(false);
    }
  }, [client, config, draft, editingId, issues.length, reload]);

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
        reload();
        notifySettingsChanged();
        return true;
      } catch (caught) {
        setMutationError(errorMessage(caught));
        return false;
      } finally {
        setRemovePending(false);
      }
    },
    [client, editingId, reload]
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
        reload();
        reloadPreview();
        notifySettingsChanged();
        return true;
      } catch (caught) {
        setMutationError(errorMessage(caught));
        return false;
      } finally {
        setTogglePending(false);
      }
    },
    [client, setFlag, reload, reloadPreview]
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
      reload();
      // `settings.get()` carries `mcpServers`, so a consumer's cached configuration is stale now.
      notifySettingsChanged();
      return true;
    } catch (caught) {
      setMutationError(errorMessage(caught));
      return false;
    } finally {
      setPresetPending(false);
    }
  }, [client, reload]);

  return useMemo(
    () => ({
      status,
      error,
      config,
      servers,
      rows,
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
      previewError,
      reloadPreview
    }),
    [
      status,
      error,
      config,
      servers,
      rows,
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
