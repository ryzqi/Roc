import { randomUUID } from 'node:crypto';
import type { BackgroundTaskPreview, BackgroundTaskPreviewRequest } from '../../../shared/types';

export type StoredBackgroundTaskPreview = {
  request: BackgroundTaskPreviewRequest;
  preview: BackgroundTaskPreview;
};

export class PreviewStore {
  private readonly entries = new Map<string, StoredBackgroundTaskPreview>();

  generatePreviewId(): string {
    return `preview_${randomUUID()}`;
  }

  put(previewId: string, entry: StoredBackgroundTaskPreview): void {
    this.entries.set(previewId, entry);
  }

  take(previewId: string): StoredBackgroundTaskPreview | null {
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
