import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { crc32, inflateRawSync } from 'node:zlib';

import UTIF from 'utif';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';
import { materializeArchitectureCorpus } from '../fixtures/architecture-repair/materialize.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixtureRoot = join(repositoryRoot, 'tests/fixtures/architecture-repair');
const corpus = JSON.parse(await readFile(join(fixtureRoot, 'corpus.json'), 'utf8'));
const { readBibtex } = await importTypeScriptModule('src/main/plugins/research/bibliography.ts', {
  platform: 'node',
  tempDir: join(repositoryRoot, '.runtime/tmp')
});
const { persistedTaskEventSchema } = await importTypeScriptModule('src/shared/schemas/task-event.ts', {
  platform: 'node',
  tempDir: join(repositoryRoot, '.runtime/tmp')
});
const { extractResearchTemplate } = await importTypeScriptModule('src/main/plugins/research/template-archive.ts', {
  platform: 'node',
  tempDir: join(repositoryRoot, '.runtime/tmp')
});

function zipEntries(archive) {
  const entries = [];
  let offset = archive.readUInt32LE(archive.length - 6);
  while (archive.readUInt32LE(offset) === 0x02014b50) {
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    entries.push({
      name: archive.toString('utf8', offset + 46, offset + 46 + nameLength),
      method: archive.readUInt16LE(offset + 10),
      crc: archive.readUInt32LE(offset + 16),
      compressedSize: archive.readUInt32LE(offset + 20),
      uncompressedSize: archive.readUInt32LE(offset + 24),
      externalAttributes: archive.readUInt32LE(offset + 38),
      localOffset: archive.readUInt32LE(offset + 42)
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function readZipMember(archive, entry) {
  const localNameLength = archive.readUInt16LE(entry.localOffset + 26);
  const localExtraLength = archive.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + localNameLength + localExtraLength;
  const compressed = archive.subarray(start, start + entry.compressedSize);
  return entry.method === 8 ? inflateRawSync(compressed) : compressed;
}

test('architecture repair corpus stays internally consistent', async () => {
  assert.equal(corpus.version, 1);

  const bibliography = readBibtex(await readFile(join(repositoryRoot, corpus.bibliography.path), 'utf8'));
  assert.deepEqual(bibliography.map((entry) => entry.citationKey), corpus.bibliography.entries);
  assert.equal(bibliography[0].preambles[0], 'Proceedings of the Roc Data Workshop');
  assert.equal(bibliography[1].fields.crossref, 'roc-workshop-2025');
  assert.equal(bibliography[1].fields.customresearchfield, 'must survive parse and export');
  assert.equal(bibliography[2].fields.eprinttype, 'arxiv');

  const pdf = await readFile(join(repositoryRoot, corpus.documents.pdf.path));
  assert.equal(createHash('sha256').update(pdf).digest('hex'), corpus.documents.pdf.sha256);
  assert.equal(corpus.documents.tiff.find((item) => item.id === 'multipage-rgb').pages.length, 2);

  assert.ok(corpus.archives.rejectionCases.some((item) => item.id === 'corrupt-crc'));
  assert.ok(corpus.archives.limitCases.some((item) => item.target === 'template-import' && item.entryCount === 5001));
  assert.equal(corpus.longSession.eventCount, 420);
  assert.equal(corpus.longSession.retainedWindow, 400);
  assert.deepEqual(corpus.fileTree.generatedFileCounts, [1000, 10000, 50000]);
});

test('architecture repair corpus materializes reusable ZIP, TIFF, history, and file-tree inputs', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'roc-architecture-corpus-'));
  try {
    const materialized = await materializeArchitectureCorpus(temporaryRoot, { fileCounts: [3] });

    const validArchive = await readFile(materialized.archives['valid-members.zip']);
    const validEntries = zipEntries(validArchive);
    assert.deepEqual(validEntries.map((entry) => entry.name), corpus.archives.validMembers.map((entry) => entry.path));
    assert.deepEqual(validEntries.map((entry) => entry.method), [8, 0, 8, 8]);
    const sourceEntry = validEntries[0];
    const sourceBytes = readZipMember(validArchive, sourceEntry);
    assert.equal((crc32(sourceBytes) >>> 0), sourceEntry.crc);

    const corruptArchive = await readFile(materialized.archives['corrupt-crc.zip']);
    const corruptEntry = zipEntries(corruptArchive)[0];
    assert.notEqual((crc32(readZipMember(corruptArchive, corruptEntry)) >>> 0), corruptEntry.crc);
    const truncatedArchive = await readFile(materialized.archives['truncated-member.zip']);
    const truncatedEntry = zipEntries(truncatedArchive)[0];
    assert.throws(() => readZipMember(truncatedArchive, truncatedEntry));
    const collisionArchive = await readFile(materialized.archives['case-collision.zip']);
    assert.deepEqual(zipEntries(collisionArchive).map((entry) => entry.name), ['Figures/Plot.svg', 'figures/plot.svg']);
    const symlinkArchive = await readFile(materialized.archives['symlink-member.zip']);
    assert.equal(zipEntries(symlinkArchive)[0].externalAttributes >>> 16, 0o120777);

    const memberLimitArchive = await readFile(materialized.archives['template-import-too-many-members.zip']);
    assert.equal(memberLimitArchive.readUInt16LE(memberLimitArchive.length - 12), 5001);
    const exportLimitArchive = await readFile(materialized.archives['export-writer-too-many-files.zip']);
    assert.equal(exportLimitArchive.readUInt16LE(exportLimitArchive.length - 12), 10001);
    const compressionBomb = await readFile(materialized.archives['template-import-compression-bomb-over-file-limit.zip']);
    const compressionBombEntry = zipEntries(compressionBomb)[0];
    assert.equal(compressionBombEntry.uncompressedSize, 67_108_865);
    assert.ok(compressionBombEntry.compressedSize < 100_000);

    const multipageBytes = await readFile(materialized.documents.tiff['multipage-rgb']);
    const pages = UTIF.decode(multipageBytes);
    assert.equal(pages.length, 2);
    for (const page of pages) UTIF.decodeImage(multipageBytes, page);
    assert.deepEqual(Array.from(UTIF.toRGBA8(pages[0])), [0, 0, 0, 255]);
    assert.deepEqual(Array.from(UTIF.toRGBA8(pages[1])), [255, 255, 255, 255]);
    const oversizedIfd = await readFile(materialized.documents.tiff['oversized-ifd']);
    const [oversizedPage] = UTIF.decode(oversizedIfd);
    assert.equal(oversizedPage.t256[0], 5001);
    assert.equal(oversizedPage.t257[0], 5000);
    const malformedIfd = await readFile(materialized.documents.tiff['malformed-ifd']);
    const [malformedPage] = UTIF.decode(malformedIfd);
    assert.deepEqual(malformedPage.t256, []);
    assert.throws(() => UTIF.decodeImage(malformedIfd, malformedPage));

    const history = (await readFile(materialized.history, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
    assert.equal(history.length, corpus.longSession.eventCount);
    assert.ok(history.every((event) => persistedTaskEventSchema.safeParse(event).success));
    assert.deepEqual(history.filter((event) => event.type === 'tool_call').map((event) => event.sequence), Array.from({ length: 42 }, (_, index) => (index + 1) * 10));
    assert.equal((await readdir(materialized.fileTree[0])).length, 3);
    assert.equal(await readFile(join(materialized.fileTree[0], 'file-000002.txt'), 'utf8'), 'corpus:2\n');

    const cliOutputRoot = join(temporaryRoot, 'cli-output');
    await mkdir(cliOutputRoot);
    const cliResult = spawnSync(process.execPath, [join(fixtureRoot, 'materialize.mjs'), cliOutputRoot, '--file-counts=0'], { encoding: 'utf8' });
    assert.equal(cliResult.status, 0, cliResult.stderr);
    assert.deepEqual(JSON.parse(cliResult.stdout), { output: await realpath(cliOutputRoot), archiveCount: 15, fileCounts: [0] });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('template import verifies CRC and normalizes truncated archive failures with output cleanup', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'roc-architecture-template-archive-'));
  try {
    const corpusRoot = join(temporaryRoot, 'corpus');
    await mkdir(corpusRoot);
    const materialized = await materializeArchitectureCorpus(corpusRoot, { fileCounts: [] });
    const projectRoot = join(temporaryRoot, 'project');
    await mkdir(projectRoot);

    const validSource = join(projectRoot, 'valid-members.zip');
    await writeFile(validSource, await readFile(materialized.archives['valid-members.zip']));
    const validOutput = join(projectRoot, 'valid-output');
    const validResult = await extractResearchTemplate({ projectRoot, sourcePath: validSource, outputDir: validOutput });
    assert.equal(validResult.fileCount, 4);
    assert.equal(await readFile(join(validOutput, 'main.tex'), 'utf8'), corpus.archives.validMembers[0].content);
    assert.equal(await readFile(join(validOutput, 'empty.txt'), 'utf8'), '');

    const corruptSource = join(projectRoot, 'corrupt-crc.zip');
    await writeFile(corruptSource, await readFile(materialized.archives['corrupt-crc.zip']));
    const corruptOutput = join(projectRoot, 'corrupt-output');
    await assert.rejects(
      extractResearchTemplate({ projectRoot, sourcePath: corruptSource, outputDir: corruptOutput }),
      (error) => error.code === 'research_template_archive_crc_mismatch'
    );
    await assert.rejects(access(corruptOutput), { code: 'ENOENT' });

    const truncatedSource = join(projectRoot, 'truncated-member.zip');
    await writeFile(truncatedSource, await readFile(materialized.archives['truncated-member.zip']));
    const truncatedOutput = join(projectRoot, 'truncated-output');
    await assert.rejects(
      extractResearchTemplate({ projectRoot, sourcePath: truncatedSource, outputDir: truncatedOutput }),
      (error) => error.code === 'research_template_archive_entry_invalid'
    );
    await assert.rejects(access(truncatedOutput), { code: 'ENOENT' });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('architecture repair corpus refuses repository aliases and unbounded file-tree counts', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'roc-architecture-corpus-'));
  try {
    const repositoryAlias = join(temporaryRoot, 'repository-alias');
    await symlink(repositoryRoot, repositoryAlias, 'dir');
    const unsafeOutput = join(repositoryAlias, `.architecture-corpus-${process.pid}`);
    await assert.rejects(materializeArchitectureCorpus(repositoryAlias, { fileCounts: [] }), /corpus_output_must_be_outside_repository/);
    await assert.rejects(materializeArchitectureCorpus(unsafeOutput, { fileCounts: [] }), { code: 'ENOENT' });
    await assert.rejects(access(unsafeOutput), { code: 'ENOENT' });

    const oversizedOutput = join(temporaryRoot, 'oversized-count');
    await assert.rejects(materializeArchitectureCorpus(oversizedOutput, { fileCounts: [50_001] }), /invalid_file_tree_count/);
    await assert.rejects(access(oversizedOutput), { code: 'ENOENT' });

    const occupiedOutput = join(temporaryRoot, 'occupied-output');
    await mkdir(occupiedOutput);
    const sentinelPath = join(occupiedOutput, 'preserve.txt');
    await writeFile(sentinelPath, 'keep existing contents');
    await assert.rejects(materializeArchitectureCorpus(occupiedOutput, { fileCounts: [] }), /corpus_output_must_be_empty/);
    assert.equal(await readFile(sentinelPath, 'utf8'), 'keep existing contents');
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
