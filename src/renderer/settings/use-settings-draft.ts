import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  AppSettings,
  PermissionsConfig,
  ProviderConfig
} from '../../shared/types';
import {
  buildImpactRows,
  buildSettingsSaveRequest,
  dirtySectionIds,
  type ImpactRow,
  type ImpactSourceState,
  type SettingsSectionId
} from '../settings-model';

export type SettingsDraft = {
  settings: AppSettings;
  permissions: PermissionsConfig;
  defaultModelId: string | null;
  baseSettings: AppSettings;
  basePermissions: PermissionsConfig;
  baseDefaultModelId: string | null;
  isDirty: boolean;
  dirtyIds: SettingsSectionId[];
  impactRows: ImpactRow[];
  pendingHighImpact: boolean;
  setSettings: (next: AppSettings) => void;
  setPermissions: (next: PermissionsConfig) => void;
  setDefaultModelId: (next: string | null) => void;
  resetAll: () => void;
  resetSection: (sectionId: SettingsSectionId) => void;
  buildSaveRequest: (overrides?: { providers?: ProviderConfig[] }) => ReturnType<typeof buildSettingsSaveRequest>;
};

export function useSettingsDraft(input: {
  baseSettings: AppSettings;
  basePermissions: PermissionsConfig;
  baseDefaultModelId: string | null;
  baseProviders: ProviderConfig[];
}): SettingsDraft {
  const { baseSettings, basePermissions, baseDefaultModelId, baseProviders } = input;

  const [draftSettings, setDraftSettings] = useState<AppSettings>(baseSettings);
  const [draftPermissions, setDraftPermissions] = useState<PermissionsConfig>(basePermissions);
  const [draftDefaultModelId, setDraftDefaultModelIdState] = useState<string | null>(baseDefaultModelId);

  useEffect(() => {
    setDraftSettings(baseSettings);
  }, [baseSettings]);
  useEffect(() => {
    setDraftPermissions(basePermissions);
  }, [basePermissions]);
  useEffect(() => {
    setDraftDefaultModelIdState(baseDefaultModelId);
  }, [baseDefaultModelId]);

  const impactRows = useMemo(() => {
    const base: ImpactSourceState = {
      settings: baseSettings,
      permissions: basePermissions,
      defaultModelId: baseDefaultModelId
    };
    const draft: ImpactSourceState = {
      settings: draftSettings,
      permissions: draftPermissions,
      defaultModelId: draftDefaultModelId
    };
    return buildImpactRows(base, draft);
  }, [
    baseSettings,
    basePermissions,
    baseDefaultModelId,
    draftSettings,
    draftPermissions,
    draftDefaultModelId
  ]);

  const dirtyIds = useMemo(() => dirtySectionIds(impactRows), [impactRows]);
  const isDirty = impactRows.length > 0;
  const pendingHighImpact = impactRows.some((row) => row.severity === 'high');

  const resetAll = useCallback(() => {
    setDraftSettings(baseSettings);
    setDraftPermissions(basePermissions);
    setDraftDefaultModelIdState(baseDefaultModelId);
  }, [baseSettings, basePermissions, baseDefaultModelId]);

  const resetSection = useCallback(
    (sectionId: SettingsSectionId) => {
      if (sectionId === 'app-basics' || sectionId === 'memory') {
        setDraftSettings(baseSettings);
      }
      if (sectionId === 'auth-security') {
        setDraftPermissions(basePermissions);
      }
      if (sectionId === 'default-model') {
        setDraftDefaultModelIdState(baseDefaultModelId);
      }
    },
    [baseSettings, basePermissions, baseDefaultModelId]
  );

  const buildSaveRequest = useCallback<SettingsDraft['buildSaveRequest']>(
    (overrides) =>
      buildSettingsSaveRequest({
        settings: draftSettings,
        providers: overrides?.providers ?? baseProviders,
        defaultModelId: draftDefaultModelId,
        permissions: draftPermissions
      }),
    [draftSettings, draftPermissions, draftDefaultModelId, baseProviders]
  );

  return {
    settings: draftSettings,
    permissions: draftPermissions,
    defaultModelId: draftDefaultModelId,
    baseSettings,
    basePermissions,
    baseDefaultModelId,
    isDirty,
    dirtyIds,
    impactRows,
    pendingHighImpact,
    setSettings: setDraftSettings,
    setPermissions: setDraftPermissions,
    setDefaultModelId: setDraftDefaultModelIdState,
    resetAll,
    resetSection,
    buildSaveRequest
  };
}
