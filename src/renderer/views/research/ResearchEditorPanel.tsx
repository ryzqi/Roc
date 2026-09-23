import { Send } from 'lucide-react';

import { TextArea } from '../../components/ui';
import { researchTemplatePreviewUrl } from '../../../shared/research-preview';
import type { ResearchTemplate, ResearchTemplateFile, ResearchTemplateFileContent } from '../../../shared/types';

export function ResearchEditorPanel({
  files,
  onChangeDraft,
  onCompile,
  onImport,
  onOpenFile,
  onSave,
  onSelect,
  openFile,
  selectedTemplateId,
  templates,
  working,
  readOnly = false
}: {
  files: ResearchTemplateFile[];
  onChangeDraft: (value: string) => void;
  onCompile: () => void;
  onImport: () => void;
  onOpenFile: (path: string) => void;
  onSave: () => void;
  onSelect: (templateId: string) => void;
  openFile: ResearchTemplateFileContent | null;
  selectedTemplateId: string | null;
  templates: ResearchTemplate[];
  working: boolean;
  readOnly?: boolean;
}): React.JSX.Element {
  const template = templates.find((item) => item.id === selectedTemplateId) ?? null;
  const preview = template === null ? null : researchTemplatePreviewUrl(template);
  const writeBlocked = working || readOnly;
  return (
    <section className="research-tool-panel" data-testid="research-editor-panel">
      <div className="research-tool-heading">
        <div>
          <h2>文稿编辑器</h2>
        </div>
        <button className="ui-button ui-button--secondary" disabled={writeBlocked} type="button" data-testid="research-template-import" onClick={onImport}>导入模板</button>
      </div>
      <div className="research-library-layout">
        <div className="research-literature-list" data-testid="research-template-list">
          {templates.length === 0 ? <div className="research-empty-inline" role="status">还没有模板。导入后可在这里编辑。</div> : templates.map((item) => (
            <button className={item.id === selectedTemplateId ? 'research-literature-row research-library-row--active' : 'research-literature-row'} key={item.id} type="button" onClick={() => onSelect(item.id)}>
              <strong>{item.entryPath}</strong>
              <span>{item.status === 'ready' ? '可预览' : item.status === 'failed' ? '编译失败' : item.status === 'compiling' ? '编译中' : '已导入'}</span>
            </button>
          ))}
        </div>
        {template === null ? <div className="research-empty-inline" role="status">选择一份模板开始编辑。</div> : (
          <div className="research-editor">
            <div className="research-literature-list" data-testid="research-template-files">
              {files.map((file) => (
                <button className={openFile?.path === file.path ? 'research-literature-row research-library-row--active' : 'research-literature-row'} key={file.path} type="button" disabled={!file.editable} onClick={() => onOpenFile(file.path)}>
                  <strong>{file.path}</strong>
                  <span>{file.editable ? '可编辑' : '只读'}</span>
                </button>
              ))}
            </div>
            {openFile === null ? <div className="research-empty-inline" role="status">选择一个源文件。</div> : (
              <label className="research-run-instruction">
                {openFile.path}
                <TextArea data-testid="research-template-editor" spellCheck={true} value={openFile.content} onChange={(event) => onChangeDraft(event.target.value)} rows={16} />
              </label>
            )}
            <div className="research-stage-actions">
              <button className="ui-button ui-button--secondary" disabled={writeBlocked || openFile === null} type="button" data-testid="research-template-save" onClick={onSave}>保存文件</button>
              <button className="ui-button ui-button--secondary" disabled={writeBlocked} type="button" data-testid="research-template-compile" onClick={onCompile}>
                <Send aria-hidden="true" size={15} />
                编译预览
              </button>
            </div>
            {template.errors.length === 0 ? null : <p className="research-stage-error" data-testid="research-template-errors">{template.errors.join(' ')}</p>}
            {preview === null ? null : <iframe className="research-pdf-preview" data-testid="research-template-preview" src={preview} title="PDF 预览" />}
          </div>
        )}
      </div>
    </section>
  );
}
