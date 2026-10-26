export type ArchivePolicyLimits = {
  members: number;
  fileBytes: number;
  totalBytes: number;
};

export type ArchivePolicyEntry = {
  name: string;
  uncompressedSize: number;
  directory?: boolean;
  unixMode?: number;
};

export type ArchivePolicyFailure = 'path_invalid' | 'path_collision' | 'special_file' | 'member_limit' | 'file_limit' | 'total_limit' | 'entry_invalid';

export class ArchivePolicyError extends Error {
  constructor(readonly failure: ArchivePolicyFailure) {
    super(failure);
    this.name = 'ArchivePolicyError';
  }
}

type ArchiveNode = { path: string; kind: 'file' | 'directory'; explicit: boolean };

export class ArchivePolicy {
  private readonly nodes = new Map<string, ArchiveNode>();
  private memberCount = 0;
  private declaredBytes = 0;
  private actualBytes = 0;

  constructor(private readonly limits: ArchivePolicyLimits) {}

  add(entry: ArchivePolicyEntry): { path: string; directory: boolean } {
    const directory = entry.directory === true;
    const path = normalizeArchiveName(entry.name, directory);
    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
      throw new ArchivePolicyError('entry_invalid');
    }
    if (entry.uncompressedSize > this.limits.fileBytes) throw new ArchivePolicyError('file_limit');
    if (directory && entry.uncompressedSize !== 0) throw new ArchivePolicyError('entry_invalid');
    if (entry.unixMode !== undefined) validateUnixMode(entry.unixMode, directory);
    if (this.memberCount + 1 > this.limits.members) throw new ArchivePolicyError('member_limit');
    if (this.declaredBytes + entry.uncompressedSize > this.limits.totalBytes) throw new ArchivePolicyError('total_limit');

    this.reservePath(path, directory);
    this.memberCount += 1;
    this.declaredBytes += entry.uncompressedSize;
    return { path, directory };
  }

  addOutputBytes(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0) throw new ArchivePolicyError('entry_invalid');
    if (this.actualBytes + count > this.limits.totalBytes) throw new ArchivePolicyError('total_limit');
    this.actualBytes += count;
  }

  private reservePath(path: string, directory: boolean): void {
    const parts = path.split('/');
    for (let index = 1; index <= parts.length; index += 1) {
      const prefix = parts.slice(0, index).join('/');
      const key = archiveCollisionKey(prefix);
      const final = index === parts.length;
      const kind = final && !directory ? 'file' : 'directory';
      const existing = this.nodes.get(key);

      if (existing !== undefined) {
        if (existing.path !== prefix || existing.kind === 'file' || (final && kind === 'file')) {
          throw new ArchivePolicyError('path_collision');
        }
        if (final) {
          if (existing.explicit) throw new ArchivePolicyError('path_collision');
          existing.explicit = true;
        }
        continue;
      }

      if (final && kind === 'file') {
        for (const candidate of this.nodes.keys()) {
          if (candidate.startsWith(`${key}/`)) throw new ArchivePolicyError('path_collision');
        }
      }
      this.nodes.set(key, { path: prefix, kind, explicit: final });
    }
  }
}

function normalizeArchiveName(name: string, directory: boolean): string {
  if (typeof name !== 'string' || name.length === 0 || hasLoneSurrogate(name) || name.includes('\\') || /[\u0000-\u001f\u007f]/u.test(name)
      || name.startsWith('/') || /^[a-z]:/iu.test(name)) {
    throw new ArchivePolicyError('path_invalid');
  }
  const withoutDirectorySlash = directory && name.endsWith('/') ? name.slice(0, -1) : name;
  if (!directory && name.endsWith('/')) throw new ArchivePolicyError('path_invalid');
  const parts = withoutDirectorySlash.split('/').filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
    throw new ArchivePolicyError('path_invalid');
  }
  const path = parts.join('/');
  if (Buffer.byteLength(path, 'utf8') > 0xffff) throw new ArchivePolicyError('path_invalid');
  return path;
}

function validateUnixMode(mode: number, directory: boolean): void {
  if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0xffff) throw new ArchivePolicyError('entry_invalid');
  const kind = mode & 0o170000;
  if (kind === 0) return;
  if (kind !== 0o040000 && kind !== 0o100000) throw new ArchivePolicyError('special_file');
  if ((kind === 0o040000) !== directory) throw new ArchivePolicyError('entry_invalid');
}

function archiveCollisionKey(path: string): string {
  return path.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}
