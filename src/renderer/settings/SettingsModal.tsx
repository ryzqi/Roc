import { useRef, useState } from 'react';
import {
  AlertTriangle,
  ArchiveRestore,
  BookOpen,
  Brain,
  CalendarClock,
  Cpu,
  Database,
  FileCode,
  FlaskConical,
  KeyRound,
  Layers,
  Shield,
  Sliders,
  Webhook,
  type LucideIcon
} from 'lucide-react';
import { ModalShell } from '../shell/ModalShell';
import { ConfirmDialog } from '../shell/ConfirmDialog';
import { EmptyState } from '../shell/EmptyState';
import type { ThemeOverride } from '../app/ui-state';
import type { RocClient } from '../shared/roc-client';
import { SETTINGS_SECTIONS, highImpactChanges, sectionForDraftPath, type SettingsSectionId } from './settings-rules';
import { useSettingsStore, type SettingsStore } from './settings-scope';
import { AppSection, TasksSection } from './sections/AppSections';
import { AuthorizationSection } from './sections/AuthorizationSection';
import { BackupSection } from './sections/BackupSection';
import { DefaultModelSection } from './sections/DefaultModelSection';
import { HooksSection } from './sections/HooksSection';
import { ModelsSection } from './sections/ModelsSection';
import { RagSection } from './sections/RagSection';
import { LiteratureSection, SandboxSection } from './sections/ReadOnlySections';
import { PilotSection } from './sections/PilotSection';
import { GuardrailSection, MemorySection } from './sections/SecuritySections';

/**
 * Section glyphs.
 *
 * The settings rail carries an icon on every row (`Layers` / `Database` /
 * `BookOpen` / `FileCode` / `Shield` / `Sliders`), and that is most of what makes the rail
 * scannable at a glance. They live here rather than in `settings-rules.ts` on purpose: that
 * module holds pure data and is imported by `tests/unit/renderer-settings.test.mjs`, so
 * pulling a React component library into it would make the rules layer depend on the view
 * layer. The glyphs come from one vocabulary and cover every section.
 *
 * Monochrome by design — only the selected state tints its icon, and the hue
 * a selected row needs is already carried by the row's own surface.
 */
const SECTION_ICONS: Readonly<Record<SettingsSectionId, LucideIcon>> = {
  models: Layers,
  'default-model': Cpu,
  rag: Database,
  literature: BookOpen,
  sandbox: FileCode,
  guardrail: Shield,
  app: Sliders,
  tasks: CalendarClock,
  authorization: KeyRound,
  hooks: Webhook,
  memory: Brain,
  pilot: FlaskConical,
  backup: ArchiveRestore
};

/**
 * Settings centre (P8/T8.2–T8.4).
 *
 * ## Fixed shape
 *
 * `min(1100px, 92vw)` × `min(86vh, 760px)`, a 220px section list with 40px rows, a dirty bar
 * pinned above the scrolling form, and the thirteen sections in their normative order. The height is passed through `widthClassName` because `ModalShell` only caps its panel; a
 * settings window that scrolls the whole modal (header and section list included) loses the
 * dirty bar exactly when it matters.
 *
 * ## One draft, one save
 *
 * `settings.save` is whole-document (F22), so the surface is a document editor: the dirty bar
 * shows `store.diff.count`, the section dots come from `store.diff.sections`, and 「保存设置」
 * writes everything. Two consequences are deliberate:
 *
 *  - **Switching sections never asks for confirmation** because it cannot lose anything — the
 *    draft is shared and kept, so a per-section prompt would be noise. The prompt exists where
 *    the risk does: closing the modal, and discarding the draft.
 *  - **A discard is explicit and its own button**; closing with unsaved edits opens a
 *    confirmation that offers 继续编辑 first and focuses cancel (MASTER §11).
 *
 * ## Dirty dots are not colour-only
 *
 * A dirty row carries a glyph, a `title`, and a screen-reader-only sentence, and the row
 * element exposes `data-dirty` — so the state is assertable by the P8 gate without reading
 * pixels.
 */

export type SettingsModalProps = {
  open: boolean;
  client: RocClient;
  projectId: string | null;
  workspacePath: string | null;
  themeOverride: ThemeOverride;
  onThemeOverrideChange: (next: ThemeOverride) => void;
  onResetUiPreferences: () => void;
  onClose: () => void;
};

function renderSection(
  id: SettingsSectionId,
  store: SettingsStore,
  props: SettingsModalProps
): React.JSX.Element {
  switch (id) {
    case 'models':
      return <ModelsSection store={store} />;
    case 'default-model':
      return <DefaultModelSection store={store} />;
    case 'rag':
      return <RagSection store={store} />;
    case 'literature':
      return <LiteratureSection store={store} />;
    case 'sandbox':
      return <SandboxSection store={store} />;
    case 'guardrail':
      return <GuardrailSection store={store} />;
    case 'app':
      return (
        <AppSection
          store={store}
          themeOverride={props.themeOverride}
          onThemeOverrideChange={props.onThemeOverrideChange}
        />
      );
    case 'tasks':
      return <TasksSection store={store} />;
    case 'authorization':
      return <AuthorizationSection store={store} />;
    case 'hooks':
      return <HooksSection store={store} />;
    case 'memory':
      return <MemorySection store={store} />;
    case 'pilot':
      return <PilotSection client={props.client} />;
    case 'backup':
      return (
        <BackupSection
          store={store}
          workspacePath={props.workspacePath}
          onResetUiPreferences={props.onResetUiPreferences}
        />
      );
  }
}

/**
 * The panel body: error, loading (the draft is not built yet — the settings document and the
 * per-project index status are two loads), or the section itself.
 *
 * A function rather than a nested ternary inside the JSX so the three states stay readable and
 * the loader cannot be mistaken for an empty form.
 */
function renderPanel(
  id: SettingsSectionId,
  store: SettingsStore,
  props: SettingsModalProps
): React.JSX.Element {
  if (store.status === 'error') {
    return (
      <EmptyState
        tone="error"
        title="读取设置失败"
        description={store.error ?? '后端没有返回原因。'}
        action={{ label: '重试', onClick: () => store.reload() }}
        testId="settings-load-error"
      />
    );
  }
  if (store.draft === null) {
    return <EmptyState tone="loading" title="正在读取设置…" testId="settings-loading" />;
  }
  return renderSection(id, store, props);
}

/**
 * The dirty bar's sentence.
 *
 * 「已保存」 is only appended while clean: otherwise the line would read 「未保存 3 项 · 已保存」
 * and the two halves would deny each other.
 */
function dirtyBarText(dirty: boolean, dirtyCount: number, savedOnce: boolean): string {
  if (dirty) {
    return `未保存 ${dirtyCount} 项`;
  }
  return savedOnce ? '没有未保存的改动 · 已保存' : '没有未保存的改动';
}

export function SettingsModal(props: SettingsModalProps): React.JSX.Element {
  const store = useSettingsStore(props.client, props.projectId);
  const [activeSection, setActiveSection] = useState<SettingsSectionId>('models');
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);
  const [impactOpen, setImpactOpen] = useState(false);
  const [saveAttempted, setSaveAttempted] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLButtonElement>(null);

  const dirtyCount = store.diff.count;
  const dirty = dirtyCount > 0;
  const impacts = highImpactChanges(store.base, store.draft);

  // Unsaved drafts are never discarded silently: the veto opens a confirmation instead of
  // closing, and Escape cancels it.
  const requestClose = (): boolean => {
    if (!dirty) {
      return true;
    }
    setCloseConfirmOpen(true);
    return false;
  };

  /**
   * Vertical tablist keyboard support: ↑/↓ step, Home/End jump to the ends (the WAI-ARIA
   * convention for `role="tablist"`, and what every macOS settings window does).
   */
  const selectSection = (id: SettingsSectionId): void => {
    setActiveSection(id);
    listRef.current?.querySelector<HTMLButtonElement>(`[data-section="${id}"]`)?.focus();
  };

  const onListKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const target = event.key === 'Home' ? SETTINGS_SECTIONS[0] : SETTINGS_SECTIONS[SETTINGS_SECTIONS.length - 1];
      if (target !== undefined) {
        selectSection(target.id);
      }
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
      return;
    }
    event.preventDefault();
    const index = SETTINGS_SECTIONS.findIndex((section) => section.id === activeSection);
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    const next = SETTINGS_SECTIONS[(index + delta + SETTINGS_SECTIONS.length) % SETTINGS_SECTIONS.length];
    if (next !== undefined) {
      selectSection(next.id);
    }
  };

  const persist = (): void => {
    void store.save.run().then((saved) => {
      if (saved) {
        setSaveAttempted(false);
      } else {
        setSaveAttempted(true);
      }
    });
  };

  const requestSave = (): void => {
    if (store.issues.length > 0) {
      setSaveAttempted(true);
      return;
    }
    if (impacts.length > 0) {
      setImpactOpen(true);
      return;
    }
    persist();
  };

  /**
   * Every issue is shown, including one whose path maps to no section — a blocker that cannot be
   * seen is worse than one with a vague location, and `validateDraft` is the only thing standing
   * between the user and a backend rejection.
   */
  const issueEntries = store.issues.map((issue) => ({ issue, section: sectionForDraftPath(issue.path) }));

  return (
    <>
      <ModalShell
        open={props.open}
        title="设置"
        onClose={props.onClose}
        beforeClose={requestClose}
        widthClassName="w-[min(1100px,92vw)] h-[min(86vh,760px)]"
        testId="settings-modal"
        initialFocusRef={activeTabRef}
        returnFocusSelector='[data-testid="titlebar-settings"]'
        // The left rail brings its own columns; see `bodyPadding` in `ModalShell`.
        bodyPadding="none"
      >
        <div className="flex h-full">
          <div
            ref={listRef}
            role="tablist"
            aria-orientation="vertical"
            aria-label="设置分区"
            onKeyDown={onListKeyDown}
            className="flex w-[190px] shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-line bg-bg p-2"
            data-testid="settings-sections"
          >
            {SETTINGS_SECTIONS.map((section) => {
              const selected = section.id === activeSection;
              const sectionDirty = store.dirtySections.has(section.id);
              const Icon = SECTION_ICONS[section.id];
              return (
                <button
                  key={section.id}
                  type="button"
                  ref={selected ? activeTabRef : undefined}
                  role="tab"
                  id={`settings-tab-${section.id}`}
                  data-section={section.id}
                  data-dirty={sectionDirty ? 'true' : 'false'}
                  aria-selected={selected}
                  aria-controls={`settings-panel-${section.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => selectSection(section.id)}
                  title={sectionDirty ? `${section.label}：有未保存的修改` : section.label}
                  data-testid={`settings-section-${section.id}`}
                  className={
                    selected
                      ? 'flex h-10 items-center gap-2 rounded-card border border-line-strong bg-[var(--surface-card-hover)] px-2.5 text-left font-semibold text-ink shadow-[var(--shadow-card)]'
                      : 'flex h-10 items-center gap-2 rounded-card border border-transparent px-2.5 text-left text-muted hover:bg-[var(--overlay-hover)] hover:text-ink active:bg-[var(--overlay-active)]'
                  }
                >
                  <Icon
                    size={13}
                    aria-hidden="true"
                    className={selected ? 'shrink-0 text-ink' : 'shrink-0 text-subtle'}
                  />
                  <span className="text-[var(--font-meta-size)]">{section.label}</span>
                  {sectionDirty ? (
                    <>
                      <span
                        aria-hidden="true"
                        className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--st-warn)] ring-1 ring-[var(--st-warn-line)]"
                        data-testid={`settings-dirty-dot-${section.id}`}
                      />
                      <span className="sr-only">（有未保存的修改）</span>
                    </>
                  ) : null}
                </button>
              );
            })}
          </div>

          <div className="flex min-w-0 flex-1 flex-col p-3">
            <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line pb-2">
              <span className="min-w-0 flex-1 text-muted text-[var(--font-meta-size)]" data-testid="settings-dirty-bar">
                {dirtyBarText(dirty, dirtyCount, store.savedAt !== null)}
              </span>
              <button
                type="button"
                onClick={() => {
                  store.discard();
                  setSaveAttempted(false);
                }}
                disabled={!dirty}
                data-testid="settings-discard-draft"
                className="h-[var(--control-height-compact)] rounded-control px-2 text-muted hover:text-ink active:bg-[var(--overlay-active)] disabled:opacity-40"
              >
                放弃修改
              </button>
              <button
                type="button"
                onClick={requestSave}
                disabled={!dirty || store.save.pending}
                data-testid="settings-save"
                className="h-[var(--control-height-compact)] rounded-control border border-line bg-surface-strong px-3 text-ink hover:bg-[var(--surface-card-hover)] active:bg-[var(--overlay-active)] disabled:opacity-40"
              >
                {store.save.pending ? '保存中…' : '保存设置'}
              </button>
            </div>

            {store.save.error === null ? null : (
              <p
                role="alert"
                data-testid="settings-save-error"
                className="mt-2 flex items-start gap-1.5 rounded-card border border-[var(--st-bad-line)] px-2 py-1.5 text-[var(--st-bad)] text-[var(--font-meta-size)]"
              >
                <AlertTriangle size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
                <span className="min-w-0">{store.save.error}</span>
              </p>
            )}

            {saveAttempted && issueEntries.length > 0 ? (
              <ul
                role="alert"
                data-testid="settings-field-issues"
                className="mt-2 flex flex-col gap-0.5 rounded-card border border-[var(--st-warn-line)] px-2 py-1.5"
              >
                {issueEntries.map(({ issue, section }) => (
                  <li
                    key={`${issue.path}:${issue.message}`}
                    className="flex items-start gap-1.5 text-[var(--st-warn)] text-[var(--font-meta-size)]"
                  >
                    <AlertTriangle size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
                    <span className="min-w-0">
                      {section === null ? (
                        <span className="mr-1 font-mono text-[var(--font-micro-size)]">{issue.path}</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setActiveSection(section)}
                          className="mr-1 underline decoration-dotted"
                          data-testid={`settings-issue-jump-${section}`}
                        >
                          {SETTINGS_SECTIONS.find((entry) => entry.id === section)?.label ?? section}
                        </button>
                      )}
                      {issue.message}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}

            <div
              role="tabpanel"
              id={`settings-panel-${activeSection}`}
              aria-labelledby={`settings-tab-${activeSection}`}
              tabIndex={-1}
              className="min-h-0 flex-1 overflow-y-auto pt-3"
              data-testid="settings-panel"
            >
              {renderPanel(activeSection, store, props)}
            </div>
          </div>
        </div>
      </ModalShell>

      <ConfirmDialog
        open={closeConfirmOpen}
        title="放弃未保存的设置？"
        message={`有 ${dirtyCount} 项设置尚未保存。`}
        detail="放弃后这些改动不会写入后端，需要重新设置。"
        confirmLabel="放弃修改"
        cancelLabel="继续编辑"
        tone="destructive"
        testId="settings-discard"
        onCancel={() => setCloseConfirmOpen(false)}
        onConfirm={() => {
          setCloseConfirmOpen(false);
          store.discard();
          setSaveAttempted(false);
          props.onClose();
        }}
      />

      <ConfirmDialog
        open={impactOpen}
        title="保存这些高影响设置？"
        message="以下设置会影响到窗口之外的行为。"
        detail={impacts.map((impact) => `${impact.title}：${impact.detail}`).join('\n')}
        confirmLabel="保存设置"
        testId="settings-impact-confirm"
        onCancel={() => setImpactOpen(false)}
        onConfirm={() => {
          setImpactOpen(false);
          persist();
        }}
      />
    </>
  );
}
