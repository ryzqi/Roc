import { copyFile, mkdir, readFile, realpath, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';

import UTIF from 'utif';

const repositoryRoot = await realpath(fileURLToPath(new URL('../../..', import.meta.url)));
const fixtureRoot = fileURLToPath(new URL('.', import.meta.url));
const corpus = JSON.parse(await readFile(join(fixtureRoot, 'corpus.json'), 'utf8'));
const MAX_GENERATED_FILE_COUNT = 50_000;

function assertOutsideRepository(path) {
  if (path === repositoryRoot || path.startsWith(`${repositoryRoot}${sep}`)) {
    throw new Error('corpus_output_must_be_outside_repository');
  }
}

async function resolveOutsideRepository(outputRoot) {
  const requestedRoot = resolve(outputRoot);
  assertOutsideRepository(requestedRoot);
  const canonicalRoot = await realpath(requestedRoot);
  assertOutsideRepository(canonicalRoot);
  if (!(await stat(canonicalRoot)).isDirectory()) throw new Error('corpus_output_must_be_directory');
  if ((await readdir(canonicalRoot)).length > 0) throw new Error('corpus_output_must_be_empty');
  return canonicalRoot;
}

function validateFileCounts(fileCounts) {
  for (const count of fileCounts) {
    if (!Number.isSafeInteger(count) || count < 0 || count > MAX_GENERATED_FILE_COUNT) {
      throw new Error(`invalid_file_tree_count:${count}:maximum_${MAX_GENERATED_FILE_COUNT}`);
    }
  }
}

function zipArchive(members) {
  const localParts = [];
  const directoryParts = [];
  let localOffset = 0;

  for (const member of members) {
    const name = Buffer.from(member.path, 'utf8');
    const content = Buffer.isBuffer(member.content) ? member.content : Buffer.from(member.content ?? '', 'utf8');
    const method = member.method ?? 8;
    const fullCompressed = method === 8 ? deflateRawSync(content) : content;
    const compressed = member.truncateCompressedBytes === undefined
      ? fullCompressed
      : fullCompressed.subarray(0, Math.max(0, fullCompressed.length - member.truncateCompressedBytes));
    const checksum = (member.declaredCrc ?? crc32(content)) >>> 0;
    const compressedSize = member.declaredCompressedBytes ?? compressed.length;
    const uncompressedSize = member.declaredUncompressedBytes ?? content.length;

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x0021, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressedSize, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    name.copy(local, 30);
    localParts.push(local, compressed);

    const directory = Buffer.alloc(46 + name.length);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x0800, 8);
    directory.writeUInt16LE(method, 10);
    directory.writeUInt16LE(0, 12);
    directory.writeUInt16LE(0x0021, 14);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(compressedSize, 20);
    directory.writeUInt32LE(uncompressedSize, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt16LE(0, 30);
    directory.writeUInt16LE(0, 32);
    directory.writeUInt16LE(0, 34);
    directory.writeUInt16LE(0, 36);
    directory.writeUInt32LE((((member.unixMode ?? 0o100444) << 16) >>> 0), 38);
    directory.writeUInt32LE(localOffset, 42);
    name.copy(directory, 46);
    directoryParts.push(directory);
    localOffset += local.length + compressed.length;
  }

  const directory = Buffer.concat(directoryParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, directory, end]);
}

function membersForRejection(item) {
  const paths = item.paths ?? [item.path];
  return paths.map((path) => ({
    path,
    content: item.kind === 'symlink' ? '../outside.txt' : `fixture:${item.id}\n`,
    unixMode: item.kind === 'symlink' ? 0o120777 : undefined,
    declaredCrc: item.id === 'corrupt-crc' ? (crc32(Buffer.from(`fixture:${item.id}\n`)) ^ 1) >>> 0 : undefined,
    truncateCompressedBytes: item.id === 'truncated-member' ? 2 : undefined
  }));
}

function oversizedMembers(target) {
  if (target === 'template-import') {
    return Array.from({ length: 5 }, (_, index) => ({
      path: `total-${index}.bin`,
      content: 'x',
      declaredUncompressedBytes: index === 4 ? 1 : 67_108_864
    }));
  }
  return Array.from({ length: 9 }, (_, index) => ({
    path: `total-${index}.bin`,
    content: 'x',
    declaredUncompressedBytes: index === 8 ? 1 : 67_108_864
  }));
}

function tiffPage(page, compression = 'none') {
  if (page.rgba.length !== page.width * page.height * 4) {
    throw new Error(`invalid_tiff_fixture_pixels:${page.width}x${page.height}`);
  }
  const encoded = Buffer.from(UTIF.encodeImage(Uint8Array.from(page.rgba), page.width, page.height));
  if (compression === 'none') return encoded;
  if (compression !== 'deflate') throw new Error(`unsupported_tiff_fixture_compression:${compression}`);

  const ifd = UTIF.decode(encoded)[0];
  const pixels = encoded.subarray(ifd.t273[0], ifd.t273[0] + ifd.t279[0]);
  const compressedPixels = deflateSync(pixels);
  ifd.t259 = [8];
  ifd.t279 = [compressedPixels.length];
  let metadata = Buffer.from(UTIF.encode([ifd]));
  ifd.t273 = [metadata.length];
  metadata = Buffer.from(UTIF.encode([ifd]));
  return Buffer.concat([metadata, compressedPixels]);
}

function tiffPages(pages, compression = 'none') {
  const encoded = pages.map((page) => tiffPage(page, compression));
  const ifds = encoded.map((bytes) => UTIF.decode(bytes)[0]);
  const pixels = ifds.map((ifd, index) => encoded[index].subarray(ifd.t273[0], ifd.t273[0] + ifd.t279[0]));
  let metadata = Buffer.from(UTIF.encode(ifds));
  let payloadOffset = metadata.length;
  for (let index = 0; index < ifds.length; index += 1) {
    ifds[index].t273 = [payloadOffset];
    payloadOffset += pixels[index].length;
  }
  metadata = Buffer.from(UTIF.encode(ifds));
  const output = Buffer.alloc(payloadOffset);
  metadata.copy(output);
  let offset = metadata.length;
  for (const data of pixels) {
    data.copy(output, offset);
    offset += data.length;
  }
  return output;
}

function oversizedTiff() {
  const source = tiffPage({ width: 1, height: 1, rgba: [0, 0, 0, 255] });
  const ifd = UTIF.decode(source)[0];
  ifd.t256 = [5001];
  ifd.t257 = [5000];
  ifd.t279 = [5001 * 5000 * 4];
  let metadata = Buffer.from(UTIF.encode([ifd]));
  ifd.t273 = [metadata.length];
  metadata = Buffer.from(UTIF.encode([ifd]));
  return metadata;
}

async function writeFileTree(root, fileCount) {
  const seedRoot = join(root, 'file-tree', 'seed');
  for (const path of corpus.fileTree.seedPaths) {
    const destination = join(seedRoot, path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, `seed:${path}\n`);
  }

  const generatedRoot = join(root, 'file-tree', `generated-${fileCount}`);
  await mkdir(generatedRoot, { recursive: true });
  const batchSize = 256;
  for (let start = 0; start < fileCount; start += batchSize) {
    const end = Math.min(fileCount, start + batchSize);
    await Promise.all(Array.from({ length: end - start }, (_, offset) => {
      const index = start + offset;
      const name = `file-${String(index).padStart(6, '0')}.txt`;
      return writeFile(join(generatedRoot, name), `corpus:${index}\n`);
    }));
  }
}

export async function materializeArchitectureCorpus(outputRoot, options = {}) {
  const fileCounts = options.fileCounts ?? corpus.fileTree.generatedFileCounts;
  validateFileCounts(fileCounts);
  const root = await resolveOutsideRepository(outputRoot);

  const archivesRoot = join(root, 'archives');
  await mkdir(archivesRoot, { recursive: true });
  const archives = {};
  const writeArchive = async (name, members) => {
    const path = join(archivesRoot, name);
    await writeFile(path, zipArchive(members));
    archives[name] = path;
  };
  await writeArchive('valid-members.zip', corpus.archives.validMembers);
  for (const item of corpus.archives.rejectionCases) {
    await writeArchive(`${item.id}.zip`, membersForRejection(item));
  }
  for (const item of corpus.archives.limitCases) {
    const name = `${item.target}-${item.id}.zip`;
    let members;
    if (item.entryCount !== undefined) {
      members = Array.from({ length: item.entryCount }, (_, index) => ({
        path: `entry-${String(index).padStart(5, '0')}.txt`,
        content: '',
        method: 0
      }));
    } else if (item.id === 'oversized-total') {
      members = oversizedMembers(item.target);
    } else {
      members = [{
        path: 'large.bin',
        content: item.id === 'compression-bomb-over-file-limit'
          ? Buffer.alloc(item.uncompressedBytes, 0x61)
          : 'x',
        declaredUncompressedBytes: item.uncompressedBytes
      }];
    }
    await writeArchive(name, members);
  }

  const documentsRoot = join(root, 'documents');
  await mkdir(documentsRoot, { recursive: true });
  const bibliographyPath = join(root, 'bibliography-semantics.bib');
  await copyFile(join(fixtureRoot, 'bibliography-semantics.bib'), bibliographyPath);
  const pdfPath = join(documentsRoot, 'p5-paper.pdf');
  await copyFile(join(repositoryRoot, corpus.documents.pdf.path), pdfPath);

  const tiffArtifacts = {};
  for (const item of corpus.documents.tiff) {
    if (item.pages !== undefined && !item.pages.some((page) => page.pixelsMaterialized === false)) {
      const path = join(documentsRoot, `${item.id}.tif`);
      await writeFile(path, tiffPages(item.pages, item.compression ?? 'none'));
      tiffArtifacts[item.id] = path;
    }
  }
  const oversizedPath = join(documentsRoot, 'oversized-ifd.tif');
  await writeFile(oversizedPath, oversizedTiff());
  tiffArtifacts['oversized-ifd'] = oversizedPath;
  const malformedSource = tiffPage({ width: 1, height: 1, rgba: [0, 0, 0, 255] });
  const malformedPath = join(documentsRoot, 'malformed-ifd.tif');
  await writeFile(malformedPath, malformedSource.subarray(0, 15));
  tiffArtifacts['malformed-ifd'] = malformedPath;

  const historyPath = join(root, 'long-session.jsonl');
  const events = Array.from({ length: corpus.longSession.eventCount }, (_, index) => {
    const sequence = index + corpus.longSession.sequenceStart;
    const base = {
      id: `corpus-event-${String(sequence).padStart(4, '0')}`,
      threadId: 'architecture-corpus-thread',
      runId: 'architecture-corpus-run',
      createdAt: '2026-01-01T00:00:00.000Z',
      sequence
    };
    if (sequence % corpus.longSession.toolCallEvery === 0) {
      return { ...base, type: 'tool_call', payload: { name: 'fixture-tool', status: 'end', input: { sequence }, output: { ok: true } } };
    }
    const assistant = sequence % 2 === 0;
    return {
      ...base,
      type: 'message',
      payload: assistant
        ? { role: 'assistant', content: `assistant ${sequence}`, providerId: 'openai', modelId: 'gpt-4o' }
        : { role: 'user', content: `user ${sequence}` }
    };
  });
  await writeFile(historyPath, events.map((event) => JSON.stringify(event)).join('\n') + '\n');

  for (const count of fileCounts) {
    await writeFileTree(root, count);
  }

  return {
    root,
    bibliography: bibliographyPath,
    archives,
    documents: { pdf: pdfPath, tiff: tiffArtifacts },
    history: historyPath,
    fileTree: fileCounts.map((count) => join(root, 'file-tree', `generated-${count}`))
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const outputRoot = process.argv[2];
  if (outputRoot === undefined) throw new Error('usage: node materialize.mjs <temporary-output-directory> [--file-counts=1000,10000,50000]');
  const fileCountsArgument = process.argv.find((argument) => argument.startsWith('--file-counts='));
  const fileCounts = fileCountsArgument === undefined
    ? corpus.fileTree.generatedFileCounts
    : fileCountsArgument.slice('--file-counts='.length).split(',').map(Number);
  const result = await materializeArchitectureCorpus(outputRoot, { fileCounts });
  console.log(JSON.stringify({ output: result.root, archiveCount: Object.keys(result.archives).length, fileCounts }));
}
