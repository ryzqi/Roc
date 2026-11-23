import {Component, type ReactNode} from 'react';

type Props = {selected: boolean; onSuspend: () => void; children: ReactNode};

/** Capture before hiding the pane or removing previews can clamp its scroll position. */
export class ArtifactReadingBoundary extends Component<Props> {
  override getSnapshotBeforeUpdate(previous: Props): null {
    if (previous.selected && !this.props.selected) previous.onSuspend();
    return null;
  }

  override componentDidUpdate(): void {}

  override render(): ReactNode {
    return this.props.children;
  }
}
