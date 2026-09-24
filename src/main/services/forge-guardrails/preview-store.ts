import { randomUUID } from 'node:crypto';
import type { BackgroundTaskPreview, BackgroundTaskPreviewRequest } from '../../../shared/types';

export type StoredBackgroundTaskPreview = {
  request: BackgroundTaskPreviewRequest;
  preview: BackgroundTaskPreview;
};

// 一次运行里多次预览后台任务时，未确认的预览不能一直留在主进程。
export const maxStoredBackgroundTaskPreviews = 8;

export class PreviewStore {
  private readonly entries = new Map<string, StoredBackgroundTaskPreview>();

  generatePreviewId(): string {
    return `preview_${randomUUID()}`;
  }

  put(previewId: string, entry: StoredBackgroundTaskPreview): void {
    if (this.entries.has(previewId)) {
      this.entries.delete(previewId);
    }
    this.entries.set(previewId, entry);
    while (this.entries.size > maxStoredBackgroundTaskPreviews) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined || oldest === previewId) {
        break;
      }
      this.entries.delete(oldest);
    }
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
