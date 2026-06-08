import { Copy } from 'lucide-react';
import { useCopyContent } from '../activity-block/use-copy-content';

type ToolDataSectionProps = {
  label: string;
  data: unknown;
  variant?: 'default' | 'error';
};

export function ToolDataSection({ label, data, variant = 'default' }: ToolDataSectionProps): React.JSX.Element {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const { copied, copy } = useCopyContent(() => text);

  return (
    <div className={`tool-data-section tool-data-section--${variant}`}>
      <div className="tool-data-header">
        <span className="tool-data-label">{label}</span>
        <button
          aria-label={copied ? `已复制${label}` : `复制${label}`}
          className="tool-data-copy"
          onClick={copy}
          title="复制"
          type="button"
        >
          <Copy aria-hidden="true" size={14} />
        </button>
      </div>
      <div className="tool-data-content">
        <pre>{text}</pre>
      </div>
    </div>
  );
}
