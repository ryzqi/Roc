type ToolDataSectionProps = {
  label: string;
  data: unknown;
  variant?: 'default' | 'error';
};

export function ToolDataSection({ label, data, variant = 'default' }: ToolDataSectionProps): React.JSX.Element {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);

  return (
    <div className={`tool-data-section tool-data-section--${variant}`}>
      <div className="tool-data-header">
        <span className="tool-data-label">{label}</span>
      </div>
      <div className="tool-data-content">
        <pre>{text}</pre>
      </div>
    </div>
  );
}
