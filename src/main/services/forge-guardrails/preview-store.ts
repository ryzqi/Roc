import { randomUUID } from 'node:crypto';
import type { BackgroundTaskPreview } from '../../../shared/types';

export class PreviewStore {
  private readonly entries = new Map<string, BackgroundTaskPreview>();

  generatePreviewId(): string {
    return `preview_${randomUUID()}`;
  }

  put(previewId: string, preview: BackgroundTaskPreview): void {
    this.entries.set(previewId, preview);
  }

  take(previewId: string): BackgroundTaskPreview | null {
    const value = this.entries.get(previewId);
    if (value === undefined) {
      return null;
    }
    this.entries.delete(previewId);
    return value;
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
