import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RocHookTrustRequest } from '../../../shared/types';
import type { RocPaths } from '../paths';

type TrustDocument = {
  schemaVersion: 1;
  trusted: Record<string, string>;
};

function createEmptyTrustDocument(): TrustDocument {
  return {
    schemaVersion: 1,
    trusted: {}
  };
}

export class HookTrustService {
  constructor(private readonly paths: RocPaths) {}

  getTrustPath(): string {
    return join(this.paths.configDir, 'hooks-trust.json');
  }

  async trust(request: RocHookTrustRequest): Promise<void> {
    this.validateRequest(request);
    const document = await this.readTrustDocument();
    document.trusted[request.handlerId] = request.hash;
    await this.writeTrustDocument(document);
  }

  async isTrusted(request: RocHookTrustRequest): Promise<boolean> {
    this.validateRequest(request);
    const document = await this.readTrustDocument();
    return document.trusted[request.handlerId] === request.hash;
  }

  private validateRequest(request: RocHookTrustRequest): void {
    if (request.handlerId.trim().length === 0) {
      throw new Error('hook_trust_handler_id_empty');
    }
    if (request.hash.trim().length === 0) {
      throw new Error('hook_trust_hash_empty');
    }
  }

  private async readTrustDocument(): Promise<TrustDocument> {
    const trustPath = this.getTrustPath();
    if (!existsSync(trustPath)) {
      return createEmptyTrustDocument();
    }
    const parsed = JSON.parse(await readFile(trustPath, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('hooks_trust_document_invalid');
    }
    const record = parsed as Record<string, unknown>;
    if (record.schemaVersion !== 1 || typeof record.trusted !== 'object' || record.trusted === null || Array.isArray(record.trusted)) {
      throw new Error('hooks_trust_document_invalid');
    }
    return {
      schemaVersion: 1,
      trusted: this.readTrustedRecord(record.trusted)
    };
  }

  private readTrustedRecord(value: object): Record<string, string> {
    const trusted: Record<string, string> = {};
    for (const [handlerId, hash] of Object.entries(value)) {
      if (typeof hash !== 'string') {
        throw new Error('hooks_trust_document_invalid');
      }
      trusted[handlerId] = hash;
    }
    return trusted;
  }

  private async writeTrustDocument(document: TrustDocument): Promise<void> {
    await mkdir(this.paths.configDir, { recursive: true });
    await writeFile(this.getTrustPath(), `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  }
}
