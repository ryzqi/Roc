import {useId, useState} from 'react';
import {AlertTriangle, ChevronDown, ChevronRight, CircleAlert, Info} from 'lucide-react';
import type {WorkspaceLatexCompileResult} from '../../shared/schemas/research-production';

export function WorkspaceProblems({result, onDiagnostic}: {
  result: WorkspaceLatexCompileResult;
  onDiagnostic: (path: string, line: number | null) => void;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(result.status === 'failed');
  const contentId = useId();
  return <section className="authoring-problems" data-expanded={expanded} data-testid="writing-problems" aria-label="构建问题">
    <button type="button" className="authoring-problems-toggle" aria-expanded={expanded} aria-controls={contentId}
      data-testid="writing-problems-toggle" onClick={() => setExpanded(value => !value)}>
      {expanded ? <ChevronDown size={14} aria-hidden="true"/> : <ChevronRight size={14} aria-hidden="true"/>}
      构建问题 <span className="tabular-nums">{result.diagnostics.length} 项</span>
    </button>
    <div id={contentId} className="authoring-problems-content" hidden={!expanded}>
      <ul>{result.diagnostics.map((diagnostic, index) => {
        const Icon = diagnostic.severity === 'error' ? CircleAlert : diagnostic.severity === 'warning' ? AlertTriangle : Info;
        return <li key={index}>
          <span className="authoring-problem-severity"><Icon size={14} aria-hidden="true"/>{diagnostic.severity === 'error' ? '错误' : diagnostic.severity === 'warning' ? '警告' : '提示'}</span>
          {diagnostic.file ? <button type="button" className="authoring-diagnostic-link" onClick={() => onDiagnostic(diagnostic.file!, diagnostic.line)}>
            {diagnostic.file}{diagnostic.line === null ? '' : `:${diagnostic.line}`}
          </button> : null}
          <span className="authoring-problem-message">{diagnostic.message}</span>
        </li>;
      })}</ul>
    </div>
  </section>;
}
