const TYPEAHEAD_RESET_MS = 700;

export function focusMatchingItem(
  event: { key: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; preventDefault: () => void; target: EventTarget | null },
  items: HTMLElement[],
  labelAt: (index: number) => string,
  buffer: { prefix: string; at: number }
): void {
  if (event.altKey || event.ctrlKey || event.metaKey || event.key.length !== 1) {
    return;
  }
  const target = event.target;
  if (target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) {
    return;
  }
  const now = Date.now();
  buffer.prefix = now - buffer.at > TYPEAHEAD_RESET_MS ? event.key : `${buffer.prefix}${event.key}`;
  buffer.at = now;
  const query = buffer.prefix.toLocaleLowerCase();
  const current = items.indexOf(event.target as HTMLElement);
  const start = current < 0 ? 0 : current;
  for (let offset = 0; offset < items.length; offset += 1) {
    const index = (start + offset) % items.length;
    if (!labelAt(index).toLocaleLowerCase().startsWith(query)) {
      continue;
    }
    event.preventDefault();
    items[index]?.focus();
    return;
  }
}
