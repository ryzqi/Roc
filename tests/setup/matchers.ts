import '../_matchers/contract';
import { vi } from 'vitest';

if (typeof document !== 'undefined') {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (typeof ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as typeof ResizeObserver;
  }
}

vi.mock('react-virtuoso', async () => {
  const ReactModule = await import('react');
  const maxTestDomRows = 80;
  const Virtuoso = ReactModule.forwardRef(function TestVirtuoso(
    props: Record<string, unknown>,
    ref: { current: unknown } | ((value: unknown) => void) | null
  ) {
    ReactModule.useImperativeHandle(ref, () => ({ scrollToIndex: () => undefined }));
    const data = Array.isArray(props.data) ? props.data : [];
    const itemContent = props.itemContent as ((index: number, item: unknown) => unknown) | undefined;
    const requestedCount = typeof props.initialItemCount === 'number' ? props.initialItemCount : data.length;
    const visibleCount = Math.min(requestedCount, maxTestDomRows, data.length);
    const start = Math.max(0, data.length - visibleCount);
    const visible = data.slice(start);
    return ReactModule.createElement(
      'div',
      {
        className: props.className,
        'data-testid': props['data-testid'],
        'data-message-count': props['data-message-count']
      },
      itemContent === undefined
        ? null
        : visible.map((item, offset) => {
            const key =
              typeof item === 'object' && item !== null && 'key' in item && typeof item.key === 'string'
                ? item.key
                : String(start + offset);
            return ReactModule.createElement(ReactModule.Fragment, { key }, itemContent(start + offset, item));
          })
    );
  });
  return { Virtuoso };
});
