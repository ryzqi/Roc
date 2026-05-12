export function FieldPreview({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="field">
      <label>{label}</label>
      <div className="field-box">
        <span>{value}</span>
        <span>▾</span>
      </div>
    </div>
  );
}
