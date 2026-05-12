export function PreviewTreeItem({
  iconText,
  label,
  selected = false
}: {
  iconText: string;
  label: string;
  selected?: boolean;
}): React.JSX.Element {
  return (
    <div className={selected ? 'tree-item selected' : 'tree-item'}>
      <span>{iconText}</span>
      <span>{label}</span>
    </div>
  );
}
