import type React from 'react';
import { SETTINGS_SECTIONS, type ImpactRow, type SettingsSectionId } from '../settings-model';

const sectionLabel: Record<SettingsSectionId, string> = SETTINGS_SECTIONS.reduce<
  Record<SettingsSectionId, string>
>((accumulator, section) => {
  accumulator[section.id] = section.label;
  return accumulator;
}, {} as Record<SettingsSectionId, string>);

export function ImpactPreviewModal({
  busy,
  onCancel,
  onConfirm,
  rows
}: {
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  rows: ImpactRow[];
}): React.JSX.Element {
  const highRows = rows.filter((row) => row.severity === 'high');
  const infoRows = rows.filter((row) => row.severity === 'info');
  return (
    <div className="modal-backdrop" data-testid="impact-preview-modal" role="dialog" aria-modal="true">
      <div className="modal-card">
        <header className="modal-header">
          <h2>保存设置前的影响预览</h2>
          <p className="modal-subtitle">
            {rows.length === 0
              ? '没有检测到变更。'
              : `共 ${rows.length} 项变更（${highRows.length} 项高影响 / ${infoRows.length} 项常规）。`}
          </p>
        </header>
        <div className="modal-body">
          {highRows.length === 0 ? null : (
            <section className="impact-group" data-testid="impact-preview-high">
              <h3>高影响</h3>
              {highRows.map((row) => (
                <div className="impact-row impact-high" key={`${row.sectionId}:${row.field}`}>
                  <div className="impact-meta">
                    <span className="impact-section">{sectionLabel[row.sectionId]}</span>
                    <span className="impact-field">{row.field}</span>
                  </div>
                  <div className="impact-change">
                    <span className="impact-before">{row.before}</span>
                    <span className="impact-arrow">→</span>
                    <span className="impact-after">{row.after}</span>
                  </div>
                  <p className="impact-note">{row.impact}</p>
                </div>
              ))}
            </section>
          )}
          {infoRows.length === 0 ? null : (
            <section className="impact-group" data-testid="impact-preview-info">
              <h3>常规变更</h3>
              {infoRows.map((row) => (
                <div className="impact-row" key={`${row.sectionId}:${row.field}`}>
                  <div className="impact-meta">
                    <span className="impact-section">{sectionLabel[row.sectionId]}</span>
                    <span className="impact-field">{row.field}</span>
                  </div>
                  <div className="impact-change">
                    <span className="impact-before">{row.before}</span>
                    <span className="impact-arrow">→</span>
                    <span className="impact-after">{row.after}</span>
                  </div>
                  <p className="impact-note">{row.impact}</p>
                </div>
              ))}
            </section>
          )}
        </div>
        <footer className="modal-footer">
          <button data-testid="impact-preview-cancel" disabled={busy} onClick={onCancel} type="button">
            取消
          </button>
          <button
            className="primary"
            data-testid="impact-preview-confirm"
            disabled={busy || rows.length === 0}
            onClick={onConfirm}
            type="button"
          >
            {busy ? '保存中…' : '确认保存'}
          </button>
        </footer>
      </div>
    </div>
  );
}
