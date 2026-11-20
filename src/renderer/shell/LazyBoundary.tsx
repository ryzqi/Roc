import { Component, Suspense, createContext, lazy, useContext, type ComponentType, type ReactNode } from 'react';
import { errorMessage } from '../app/loaded-state';
import { ErrorBar } from './ErrorBar';

const initialAttempt = {};
const LazyAttempt = createContext<object>(initialAttempt);

/**
 * A rejected React.lazy caches its failure. Keep component identity stable during
 * suspense, and create a fresh lazy only after this region explicitly retries.
 */
export function retryableLazy<Props extends object>(
  load: () => Promise<{ default: ComponentType<Props> }>
): ComponentType<Props> {
  const attempts = new WeakMap<object, ComponentType<Props>>();
  return function RetryableContent(props: Props): React.JSX.Element {
    const attempt = useContext(LazyAttempt);
    let Content = attempts.get(attempt);
    if (Content === undefined) {
      Content = lazy(load);
      attempts.set(attempt, Content);
    }
    return <Content {...props} />;
  };
}

export type LazyBoundaryProps = {
  children: ReactNode;
  fallback: ReactNode;
  label?: string;
  testId?: string;
  active?: boolean;
  resetKey?: string | number;
  onRetry?: () => void;
  onDismiss?: () => void;
  renderError?: (content: ReactNode) => ReactNode;
};

type BoundaryProps = LazyBoundaryProps & { parentAttempt: object };
type BoundaryState = { error: string | null; attempt: object | null; resetKey: string | number | undefined };

class ContentBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { error: null, attempt: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { error: errorMessage(error) };
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return props.resetKey === state.resetKey ? null : { error: null, attempt: null, resetKey: props.resetKey };
  }

  private retry = (): void => {
    this.props.onRetry?.();
    this.setState({ error: null, attempt: {} });
  };

  override render(): ReactNode {
    const { children, fallback, label = '内容加载失败', testId = 'content-load-error',
      active = true, onDismiss, renderError } = this.props;
    if (this.state.error !== null) {
      if (!active) return null;
      const content = <div className="min-w-0 p-2" data-testid={testId}>
        <ErrorBar error={{ level: 'page', message: `${label}：${this.state.error}`, retry: this.retry }}
          {...(onDismiss === undefined ? {} : { onDismiss })} />
      </div>;
      return renderError === undefined ? content : renderError(content);
    }
    return <LazyAttempt.Provider value={this.state.attempt ?? this.props.parentAttempt}>
      <Suspense fallback={active ? fallback : null}>{children}</Suspense>
    </LazyAttempt.Provider>;
  }
}

/** Failures stay within the owning surface, including delayed rejections while hidden. */
export function LazyBoundary(props: LazyBoundaryProps): React.JSX.Element {
  const parentAttempt = useContext(LazyAttempt);
  return <ContentBoundary {...props} parentAttempt={parentAttempt} />;
}
