import type { FileEntryShape } from '../../shared/types';
import { sanitizeTestId } from '../utils/sanitize-test-id';
import { fileLabel, fileTreeIcon } from '../workbench/file-tree-helpers';

export function TreeItem({
  active = false,
  depth = 0,
  expanded = false,
  entry,
  loading = false,
  onClick
}: {
  active?: boolean;
  depth?: number;
  expanded?: boolean;
  entry: FileEntryShape;
  loading?: boolean;
  onClick?: () => void;
}): React.JSX.Element {
  const className = active ? 'tree-item selected' : 'tree-item';
  const label = fileLabel(entry.relativePath);
  const expander = entry.type === 'directory' ? (loading ? '…' : expanded ? '▾' : '▸') : null;
  const icon = fileTreeIcon(entry, active, expanded);
  if (onClick !== undefined) {
    return (
      <button
        className={className}
        data-testid={`${entry.type === 'directory' ? 'workbench-directory' : 'workbench-file'}-${sanitizeTestId(entry.relativePath)}`}
        style={{ paddingLeft: `${14 + depth * 16}px` }}
        type="button"
        onClick={onClick}
      >
        <span className="tree-item-expander">{expander}</span>
        <span className="tree-item-icon">{icon}</span>
        <span className="tree-item-label">{label}</span>
      </button>
    );
  }
  return (
    <div className={className} style={{ paddingLeft: `${14 + depth * 16}px` }}>
      <span className="tree-item-expander">{expander}</span>
      <span className="tree-item-icon">{icon}</span>
      <span className="tree-item-label">{label}</span>
    </div>
  );
}
