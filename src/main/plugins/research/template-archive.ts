import { inflateRawSync } from 'node:zlib';
import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join, posix as posixPath } from 'node:path';
import { researchJobError, runResearchJob, type ResearchJobPaths } from './research-job';

const MAX_MEMBERS = 5000;
const MAX_UNCOMPRESSED = 256 * 1024 * 1024;
const MAX_FILE = 64 * 1024 * 1024;
const SKIP_PARTS = new Set(['__MACOSX', '.git', '.DS_Store', '.roc-research', '.roc-build']);
const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const EOCD_SIGNATURE = 0x06054b50;
const STORED = 0;
const DEFLATE = 8;

type ZipMember = {
  name: string;
  directory: boolean;
  compression: number;
  localOffset: number;
  compressedSize: number;
  uncompressedSize: number;
  flags: number;
  externalAttributes: number;
};

function readU16(buffer: Buffer, offset: number): number {
  return buffer.readUInt16LE(offset);
}

function readU32(buffer: Buffer, offset: number): number {
  return buffer.readUInt32LE(offset);
}

function findEocd(buffer: Buffer): number {
  const minimum = 22;
  if (buffer.length < minimum) {
    researchJobError('research_template_archive_entry_invalid');
  }
  const start = Math.max(0, buffer.length - 22 - 65535);
  for (let offset = buffer.length - minimum; offset >= start; offset -= 1) {
    if (readU32(buffer, offset) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  researchJobError('research_template_archive_entry_invalid');
}

function decodeName(bytes: Buffer, utf8: boolean): string {
  return bytes.toString(utf8 ? 'utf8' : 'latin1');
}

function parseCentralDirectory(buffer: Buffer): ZipMember[] {
  const eocd = findEocd(buffer);
  if (readU16(buffer, eocd + 4) !== 0 || readU16(buffer, eocd + 6) !== 0) {
    researchJobError('research_template_archive_entry_invalid');
  }
  const entries = readU16(buffer, eocd + 10);
  const size = readU32(buffer, eocd + 12);
  const offset = readU32(buffer, eocd + 16);
  if (entries > MAX_MEMBERS || offset + size > buffer.length) {
    researchJobError('research_template_archive_too_large');
  }
  const members: ZipMember[] = [];
  let cursor = offset;
  for (let index = 0; index < entries; index += 1) {
    if (cursor + 46 > buffer.length || readU32(buffer, cursor) !== CENTRAL_SIGNATURE) {
      researchJobError('research_template_archive_entry_invalid');
    }
    const flags = readU16(buffer, cursor + 8);
    const compression = readU16(buffer, cursor + 10);
    const compressedSize = readU32(buffer, cursor + 20);
    const uncompressedSize = readU32(buffer, cursor + 24);
    const nameLength = readU16(buffer, cursor + 28);
    const extraLength = readU16(buffer, cursor + 30);
    const commentLength = readU16(buffer, cursor + 32);
    const externalAttributes = readU32(buffer, cursor + 38);
    const localOffset = readU32(buffer, cursor + 42);
    const nameStart = cursor + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd + extraLength + commentLength > buffer.length) {
      researchJobError('research_template_archive_entry_invalid');
    }
    members.push({
      name: decodeName(buffer.subarray(nameStart, nameEnd), (flags & 0x800) !== 0),
      directory: nameEndsWithSlash(buffer, nameStart, nameEnd),
      compression,
      localOffset,
      compressedSize,
      uncompressedSize,
      flags,
      externalAttributes
    });
    cursor = nameEnd + extraLength + commentLength;
  }
  return members;
}

function nameEndsWithSlash(buffer: Buffer, start: number, end: number): boolean {
  return end > start && (buffer[end - 1] === 0x2f || buffer[end - 1] === 0x5c);
}

function zipMemberPath(name: string): { path: string; directory: boolean } {
  if (name.includes('\\') || [...name].some((char) => char.charCodeAt(0) < 32)) {
    researchJobError('research_template_archive_entry_invalid');
  }
  const directory = name.endsWith('/');
  const parts = name.split('/').filter((part) => part.length > 0);
  if (posixPath.isAbsolute(name) || parts.length === 0 || parts.some((part) => part === '.' || part === '..')) {
    researchJobError('research_template_archive_entry_invalid');
  }
  return { path: parts.join('/'), directory };
}

function validateMember(member: ZipMember, names: Map<string, string>, files: Set<string>): string {
  const { path, directory } = zipMemberPath(member.name);
  const mode = (member.externalAttributes >>> 16) & 0xffff;
  const kind = mode & 0o170000;
  if (
    kind === 0o120000 ||
    (kind !== 0 && kind !== 0o040000 && kind !== 0o100000) ||
    (member.flags & 0x0009) !== 0 ||
    member.compressedSize === 0xffffffff ||
    member.uncompressedSize === 0xffffffff ||
    member.localOffset === 0xffffffff ||
    (member.compression !== STORED && member.compression !== DEFLATE)
  ) {
    researchJobError('research_template_archive_entry_invalid');
  }
  if (member.uncompressedSize > MAX_FILE) {
    researchJobError('research_template_archive_too_large');
  }
  const parts = path.split('/');
  for (let index = 1; index <= parts.length; index += 1) {
    const part = parts.slice(0, index).join('/');
    const folded = part.normalize('NFC').toLowerCase();
    const existing = names.get(folded);
    if (existing !== undefined && existing !== part) {
      researchJobError('research_template_archive_path_collision');
    }
    names.set(folded, part);
  }
  if (!directory) {
    if (files.has(path)) {
      researchJobError('research_template_archive_path_collision');
    }
    files.add(path);
  }
  return directory ? `${path}/` : path;
}

function skipMember(path: string): boolean {
  return path.split('/').some((part) => SKIP_PARTS.has(part));
}

function inflateMember(buffer: Buffer, member: ZipMember): Buffer {
  if (member.localOffset + 30 > buffer.length || readU32(buffer, member.localOffset) !== LOCAL_SIGNATURE) {
    researchJobError('research_template_archive_entry_invalid');
  }
  const nameLength = readU16(buffer, member.localOffset + 26);
  const extraLength = readU16(buffer, member.localOffset + 28);
  const dataStart = member.localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + member.compressedSize;
  if (dataEnd > buffer.length) {
    researchJobError('research_template_archive_entry_invalid');
  }
  const payload = buffer.subarray(dataStart, dataEnd);
  if (member.compression === STORED) {
    if (payload.length !== member.uncompressedSize) {
      researchJobError('research_template_archive_entry_invalid');
    }
    return Buffer.from(payload);
  }
  const inflated = inflateRawSync(payload, { maxOutputLength: member.uncompressedSize });
  if (inflated.length !== member.uncompressedSize) {
    researchJobError('research_template_archive_entry_invalid');
  }
  return inflated;
}

async function writeFileExclusive(path: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}

async function extractArchive(job: ResearchJobPaths): Promise<{ fileCount: number }> {
  const buffer = await readFile(job.source);
  const members = parseCentralDirectory(buffer);
  const names = new Map<string, string>();
  const files = new Set<string>();
  let uncompressed = 0;
  let extracted = 0;
  for (const member of members) {
    uncompressed += member.uncompressedSize;
    if (members.length > MAX_MEMBERS || uncompressed > MAX_UNCOMPRESSED) {
      researchJobError('research_template_archive_too_large');
    }
    const path = validateMember(member, names, files);
    if (skipMember(path)) {
      continue;
    }
    const destination = join(job.output, ...path.replace(/\/$/u, '').split('/'));
    if (path.endsWith('/')) {
      await mkdir(destination, { recursive: true, mode: 0o700 });
      continue;
    }
    await writeFileExclusive(destination, inflateMember(buffer, member));
    extracted += 1;
  }
  return { fileCount: extracted };
}

export async function extractResearchTemplate(input: {
  projectRoot: string;
  sourcePath: string;
  outputDir: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<{ fileCount: number; sourceHash: string }> {
  return await runResearchJob(
    { ...input, maxSourceBytes: MAX_UNCOMPRESSED, sourceExtensions: ['.zip'], sourceExtensionError: 'research_template_zip_required', timeoutMs: input.timeoutMs ?? 60_000 },
    extractArchive
  );
}
