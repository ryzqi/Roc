export function FieldPreview({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="field-preview">
      <span className="field-preview-label">{label}</span>
      <div className="field-preview-value">{value}</div>
    </div>
  );
}
