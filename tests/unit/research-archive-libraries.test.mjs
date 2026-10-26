import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, open, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import yauzlModule from 'yauzl';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';
import { materializeArchitectureCorpus } from '../fixtures/architecture-repair/materialize.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const fixtureRoot = join(repositoryRoot, 'tests/fixtures/architecture-repair');
const corpus = JSON.parse(await readFile(join(fixtureRoot, 'corpus.json'), 'utf8'));
const yauzl = yauzlModule;
const { archiveBuilderProvenance, createExportZipArchive } = await importTypeScriptModule('src/main/plugins/research/export-archive.ts', {
  platform: 'node',
  external: ['yazl'],
  tempDir: join(repositoryRoot, '.runtime/tmp')
});
const { extractResearchTemplate } = await importTypeScriptModule('src/main/plugins/research/template-archive.ts', {
  platform: 'node',
  external: ['yauzl'],
  tempDir: join(repositoryRoot, '.runtime/tmp')
});

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function writeEntry(root, path, content) {
  const bytes = Buffer.from(content);
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), bytes);
  return { path, sha256: digest(bytes), size: bytes.length };
}

async function withDiskFullAfter(sourcePath, writeNumber, run) {
  const probe = await open(sourcePath, 'r');
  const handlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalWrite = handlePrototype.write;
  let writes = 0;
  handlePrototype.write = function (...args) {
    writes += 1;
    if (writes >= writeNumber) {
      return Promise.reject(Object.assign(new Error('No space left on device'), { code: 'ENOSPC', syscall: 'write' }));
    }
    return originalWrite.apply(this, args);
  };
  try {
    await run(() => writes);
  } finally {
    handlePrototype.write = originalWrite;
  }
}

async function withFirstFileStatFailure(temporaryRoot, run) {
  const probePath = join(temporaryRoot, 'stat-probe');
  await writeFile(probePath, '');
  const probe = await open(probePath, 'r');
  const handlePrototype = Object.getPrototypeOf(probe);
  await probe.close();
  const originalStat = handlePrototype.stat;
  let failed = false;
  handlePrototype.stat = function (...args) {
    if (!failed) {
      failed = true;
      return Promise.reject(new Error('simulated_fstat_failure'));
    }
    return originalStat.apply(this, args);
  };
  try {
    await run();
  } finally {
    handlePrototype.stat = originalStat;
  }
}

async function archiveNames(path) {
  const zip = await yauzl.openPromise(path, { lazyEntries: true, autoClose: false });
  try {
    const names = [];
    for await (const entry of zip.eachEntry()) names.push(entry.fileName);
    return names;
  } finally {
    zip.close();
  }
}

async function archiveMetadata(path) {
  const zip = await yauzl.openPromise(path, { lazyEntries: true, autoClose: false });
  try {
    const members = [];
    for await (const entry of zip.eachEntry()) {
      members.push({
        name: entry.fileName,
        date: entry.lastModFileDate,
        time: entry.lastModFileTime,
        unixMode: (entry.externalFileAttributes >>> 16) & 0xffff
      });
    }
    return members;
  } finally {
    zip.close();
  }
}

function setUncompressedSize(archive, memberName, size) {
  const centralStart = archive.readUInt32LE(archive.length - 6);
  let offset = centralStart;
  while (archive.readUInt32LE(offset) === 0x02014b50) {
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const name = archive.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === memberName) {
      const localOffset = archive.readUInt32LE(offset + 42);
      archive.writeUInt32LE(size, offset + 24);
      archive.writeUInt32LE(size, localOffset + 22);
      return archive;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`archive_member_not_found:${memberName}`);
}

function setCentralMemberName(archive, name) {
  const centralStart = archive.readUInt32LE(archive.length - 6);
  assert.equal(archive.readUInt32LE(centralStart), 0x02014b50);
  const nameLength = archive.readUInt16LE(centralStart + 28);
  const bytes = Buffer.from(name);
  assert.equal(bytes.length, nameLength);
  bytes.copy(archive, centralStart + 46);
  return archive;
}

function addLocalZip64Extra(archive) {
  const localNameLength = archive.readUInt16LE(26);
  const localExtraLength = archive.readUInt16LE(28);
  const localExtraStart = 30 + localNameLength;
  const centralStart = archive.readUInt32LE(archive.length - 6);
  const extraField = Buffer.from([0x01, 0x00, 0x00, 0x00]);
  const withExtra = Buffer.alloc(archive.length + extraField.length);
  archive.copy(withExtra, 0, 0, localExtraStart + localExtraLength);
  extraField.copy(withExtra, localExtraStart + localExtraLength);
  archive.copy(withExtra, localExtraStart + localExtraLength + extraField.length, localExtraStart + localExtraLength);
  withExtra.writeUInt16LE(localExtraLength + extraField.length, 28);
  withExtra.writeUInt32LE(centralStart + extraField.length, withExtra.length - 6);
  return withExtra;
}

function setMalformedUtf8MemberName(archive) {
  const centralStart = archive.readUInt32LE(archive.length - 6);
  assert.equal(archive.readUInt32LE(centralStart), 0x02014b50);
  const nameLength = archive.readUInt16LE(centralStart + 28);
  const localOffset = archive.readUInt32LE(centralStart + 42);
  assert.equal(archive.readUInt32LE(localOffset), 0x04034b50);
  assert.equal(archive.readUInt16LE(localOffset + 26), nameLength);
  archive[centralStart + 46] = 0xff;
  archive[localOffset + 30] = 0xff;
  archive.writeUInt16LE(archive.readUInt16LE(centralStart + 8) | 0x0800, centralStart + 8);
  archive.writeUInt16LE(archive.readUInt16LE(localOffset + 6) | 0x0800, localOffset + 6);
  return archive;
}

test('export ZIPs are ordered, reproducible, and readable as streamed template archives', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'roc-archive-library-roundtrip-'));
  try {
    const sourceRootPath = join(temporaryRoot, 'bundle');
    await mkdir(sourceRootPath);
    const sourceRoot = await realpath(sourceRootPath);
    const largeBytes = randomBytes(180_000);
    const entries = [
      await writeEntry(sourceRoot, '文献.bib', '@article{roc2025,title={Roc}}\n'),
      await writeEntry(sourceRoot, '\uFEFFname.txt', 'BOM member\n'),
      await writeEntry(sourceRoot, 'main.tex', 'Roc manuscript\n'),
      await writeEntry(sourceRoot, 'empty.txt', ''),
      await writeEntry(sourceRoot, 'large.bin', largeBytes)
    ];
    const firstPath = join(temporaryRoot, 'first.zip');
    const secondPath = join(temporaryRoot, 'second.zip');
    const signal = new AbortController().signal;
    const first = await createExportZipArchive(sourceRoot, firstPath, entries, signal);
    const second = await createExportZipArchive(sourceRoot, secondPath, entries, signal);
    const firstBytes = await readFile(firstPath);
    const secondBytes = await readFile(secondPath);

    assert.deepEqual(await archiveNames(firstPath), ['empty.txt', 'large.bin', 'main.tex', '文献.bib', '\uFEFFname.txt']);
    assert.deepEqual(await archiveMetadata(firstPath), ['empty.txt', 'large.bin', 'main.tex', '文献.bib', '\uFEFFname.txt'].map((name) => ({
      name, date: 0x21, time: 0, unixMode: 0o100444
    })));
    assert.deepEqual(first, { sha256: digest(firstBytes), size: firstBytes.length });
    assert.deepEqual(second, first);
    assert.deepEqual(secondBytes, firstBytes);
    assert.equal(archiveBuilderProvenance.libraries.yazl.version, '3.3.1');
    assert.match(archiveBuilderProvenance.libraries.yazl.lockfileIntegrity, /^sha512-/u);
    assert.equal(archiveBuilderProvenance.writer.compression.level, 6);

    const outputDir = join(temporaryRoot, 'extracted');
    const extracted = await extractResearchTemplate({ projectRoot: temporaryRoot, sourcePath: firstPath, outputDir });
    assert.equal(extracted.fileCount, entries.length);
    assert.equal(await readFile(join(outputDir, 'main.tex'), 'utf8'), 'Roc manuscript\n');
    assert.equal(await readFile(join(outputDir, '文献.bib'), 'utf8'), '@article{roc2025,title={Roc}}\n');
    assert.equal(await readFile(join(outputDir, '\uFEFFname.txt'), 'utf8'), 'BOM member\n');
    assert.equal(await readFile(join(outputDir, 'empty.txt'), 'utf8'), '');
    assert.deepEqual(await readFile(join(outputDir, 'large.bin')), largeBytes);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('export archive closes its destination descriptor when initial fstat fails', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'roc-archive-library-fstat-'));
  try {
    const sourceRootPath = join(temporaryRoot, 'bundle');
    await mkdir(sourceRootPath);
    const sourceRoot = await realpath(sourceRootPath);
    await withFirstFileStatFailure(temporaryRoot, async () => {
      await assert.rejects(
        createExportZipArchive(sourceRoot, join(temporaryRoot, 'fstat-failure.zip'), [
          { path: 'source.txt', sha256: '0'.repeat(64), size: 0 }
        ], new AbortController().signal),
        /simulated_fstat_failure/u
      );
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('template reader awaits archive descriptor close before returning', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'roc-archive-library-close-wait-'));
  const originalClose = yauzl.ZipFile.prototype.close;
  let closeObserved = false;
  try {
    const sourceRootPath = join(temporaryRoot, 'bundle');
    await mkdir(sourceRootPath);
    const sourceRoot = await realpath(sourceRootPath);
    const entry = await writeEntry(sourceRoot, 'source.txt', 'source\n');
    const archivePath = join(temporaryRoot, 'source.zip');
    await createExportZipArchive(sourceRoot, archivePath, [entry], new AbortController().signal);
    yauzl.ZipFile.prototype.close = function (...args) {
      this.once('close', () => { closeObserved = true; });
      setTimeout(() => originalClose.apply(this, args), 50);
    };
    await extractResearchTemplate({
      projectRoot: temporaryRoot,
      sourcePath: archivePath,
      outputDir: join(temporaryRoot, 'extracted')
    });
    assert.equal(closeObserved, true);
  } finally {
    yauzl.ZipFile.prototype.close = originalClose;
    if (!closeObserved) await new Promise((resolve) => setTimeout(resolve, 60));
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('template reader preserves extraction errors when archive close also fails', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'roc-archive-library-close-error-'));
  const originalClose = yauzl.ZipFile.prototype.close;
  const closeError = new Error('simulated_yauzl_close_failure');
  let activeZip;
  let operation;
  try {
    const sourceRootPath = join(temporaryRoot, 'bundle');
    await mkdir(sourceRootPath);
    const sourceRoot = await realpath(sourceRootPath);
    const entry = await writeEntry(sourceRoot, 'safe.txt', 'source\n');
    const archivePath = join(temporaryRoot, 'source.zip');
    await createExportZipArchive(sourceRoot, archivePath, [entry], new AbortController().signal);
    const archive = await readFile(archivePath);
    await chmod(archivePath, 0o600);
    await writeFile(archivePath, setCentralMemberName(archive, '../x.txt'));
    yauzl.ZipFile.prototype.close = function (...args) {
      activeZip = this;
      this.emit('error', closeError);
    };
    operation = extractResearchTemplate({
        projectRoot: temporaryRoot,
        sourcePath: archivePath,
        outputDir: join(temporaryRoot, 'extracted')
      });
    const outcome = await Promise.race([
      operation.then((value) => ({ status: 'resolved', value }), (error) => ({ status: 'rejected', error })),
      new Promise((resolve) => setTimeout(() => resolve({ status: 'timeout' }), 30))
    ]);
    assert.equal(outcome.status, 'rejected', 'archive close error should settle extraction without waiting for a close event');
    assert.equal(outcome.error.code, 'research_template_archive_entry_invalid');
    assert.ok(outcome.error.cleanupErrors?.some((cleanupError) => cleanupError.message === closeError.message));
  } finally {
    yauzl.ZipFile.prototype.close = originalClose;
    if (activeZip?.isOpen) originalClose.call(activeZip);
    await operation?.catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('template reader observes descriptor close failure after a prior ZIP parser error', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'roc-archive-library-reader-close-error-'));
  const originalEachEntry = yauzl.ZipFile.prototype.eachEntry;
  const originalZipClose = yauzl.ZipFile.prototype.close;
  const closeError = new Error('simulated_reader_close_failure_after_parse_error');
  let activeZip;
  let parserErrorEmitted;
  let operation;
  try {
    const sourceRootPath = join(temporaryRoot, 'bundle');
    await mkdir(sourceRootPath);
    const sourceRoot = await realpath(sourceRootPath);
    const entry = await writeEntry(sourceRoot, 'safe.txt', 'source\n');
    const archivePath = join(temporaryRoot, 'source.zip');
    await createExportZipArchive(sourceRoot, archivePath, [entry], new AbortController().signal);
    yauzl.ZipFile.prototype.eachEntry = function () {
      const zip = this;
      return (async function* () {
        zip.emittedError = true;
        const parserError = new Error('simulated_yauzl_parser_error');
        zip.emit('error', parserError);
      })();
    };
    yauzl.ZipFile.prototype.close = function (...args) {
      activeZip = this;
      parserErrorEmitted = this.emittedError;
      this.reader.emit('error', closeError);
    };
    operation = extractResearchTemplate({
      projectRoot: temporaryRoot,
      sourcePath: archivePath,
      outputDir: join(temporaryRoot, 'extracted')
    });
    const outcome = await Promise.race([
      operation.then((value) => ({ status: 'resolved', value }), (error) => ({ status: 'rejected', error })),
      new Promise((resolve) => setTimeout(() => resolve({ status: 'timeout' }), 30))
    ]);
    assert.equal(outcome.status, 'rejected', 'reader close failure should settle extraction after a parser error');
    assert.ok(outcome.error.cleanupErrors?.some((error) => error.message === closeError.message), JSON.stringify({
      status: outcome.status,
      name: outcome.error.name,
      message: outcome.error.message,
      code: outcome.error.code,
      errors: outcome.error.errors,
      cause: outcome.error.cause,
      cleanupErrors: outcome.error.cleanupErrors,
      parserErrorEmitted
    }));
    assert.equal(parserErrorEmitted, true, 'yauzl must already be in its parser-error state before close');
    assert.equal(outcome.error.code, 'research_template_archive_entry_invalid');
  } finally {
    yauzl.ZipFile.prototype.eachEntry = originalEachEntry;
    yauzl.ZipFile.prototype.close = originalZipClose;
    if (activeZip?.isOpen) originalZipClose.call(activeZip);
    await operation?.catch(() => undefined);
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('template reader rejects ZIP64 extra fields found only in local headers', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'roc-archive-library-local-zip64-'));
  try {
    const sourceRootPath = join(temporaryRoot, 'bundle');
    await mkdir(sourceRootPath);
    const sourceRoot = await realpath(sourceRootPath);
    const entry = await writeEntry(sourceRoot, 'safe.txt', 'source\n');
    const archivePath = join(temporaryRoot, 'source.zip');
    await createExportZipArchive(sourceRoot, archivePath, [entry], new AbortController().signal);
    const archive = await readFile(archivePath);
    await chmod(archivePath, 0o600);
    await writeFile(archivePath, addLocalZip64Extra(archive));
    await assert.rejects(
      extractResearchTemplate({
        projectRoot: temporaryRoot,
        sourcePath: archivePath,
        outputDir: join(temporaryRoot, 'extracted')
      }),
      { code: 'research_template_archive_entry_invalid' }
    );
    await assert.rejects(access(join(temporaryRoot, 'extracted', 'safe.txt')), { code: 'ENOENT' });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('template reader rejects malformed UTF-8 member names when the UTF-8 flag is set', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'roc-archive-library-invalid-utf8-'));
  try {
    const sourceRootPath = join(temporaryRoot, 'bundle');
    await mkdir(sourceRootPath);
    const sourceRoot = await realpath(sourceRootPath);
    const entry = await writeEntry(sourceRoot, 'safe.txt', 'source\n');
    const archivePath = join(temporaryRoot, 'source.zip');
    await createExportZipArchive(sourceRoot, archivePath, [entry], new AbortController().signal);
    const archive = await readFile(archivePath);
    await chmod(archivePath, 0o600);
    await writeFile(archivePath, setMalformedUtf8MemberName(archive));
    const outputDir = join(temporaryRoot, 'extracted');
    await assert.rejects(
      extractResearchTemplate({ projectRoot: temporaryRoot, sourcePath: archivePath, outputDir }),
      { code: 'research_template_archive_entry_invalid' }
    );
    await assert.rejects(access(outputDir), { code: 'ENOENT' });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('export ZIP policy rejects normalized and ancestor path conflicts before opening sources', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'roc-archive-library-collisions-'));
  try {
    const sourceRoot = join(temporaryRoot, 'bundle');
    await mkdir(sourceRoot);
    const collisionSets = [
      ['Figures/Plot.svg', 'figures/plot.svg'],
      ['café.txt', 'café.txt'],
      ['straße.txt', 'STRASSE.txt'],
      ['report', 'report/appendix.txt']
    ];
    for (const [index, paths] of collisionSets.entries()) {
      const archivePath = join(temporaryRoot, `collision-${index}.zip`);
      const entries = paths.map((path) => ({ path, sha256: '0'.repeat(64), size: 0 }));
      await assert.rejects(
        createExportZipArchive(sourceRoot, archivePath, entries, new AbortController().signal),
        (error) => error.message === 'research_export_path_collision'
      );
      await assert.rejects(access(archivePath), { code: 'ENOENT' });
    }

    await assert.rejects(
      createExportZipArchive(sourceRoot, join(temporaryRoot, 'file-limit.zip'), [
        { path: 'too-large.bin', sha256: '0'.repeat(64), size: 64 * 1024 * 1024 + 1 }
      ], new AbortController().signal),
      (error) => error.message === 'research_export_file_limit'
    );
    await assert.rejects(
      createExportZipArchive(sourceRoot, join(temporaryRoot, 'total-limit.zip'), Array.from({ length: 9 }, (_, index) => ({
        path: `part-${index}.bin`, sha256: '0'.repeat(64), size: 64 * 1024 * 1024
      })), new AbortController().signal),
      (error) => error.message === 'research_export_file_limit'
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('template ZIP reader rejects the attack and limit corpus without leaving partial output', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'roc-archive-library-corpus-'));
  try {
    const corpusRoot = join(temporaryRoot, 'corpus');
    await mkdir(corpusRoot);
    const materialized = await materializeArchitectureCorpus(corpusRoot, { fileCounts: [] });
    const projectRoot = join(temporaryRoot, 'project');
    await mkdir(projectRoot);

    const expectedCodes = new Map([
      ['case-collision', 'research_template_archive_path_collision'],
      ['unicode-normalization-collision', 'research_template_archive_path_collision'],
      ['corrupt-crc', 'research_template_archive_crc_mismatch']
    ]);
    const archiveCases = [
      ...corpus.archives.rejectionCases.map((item) => ({ id: item.id, expectedCode: expectedCodes.get(item.id) })),
      ...corpus.archives.limitCases.filter((item) => item.target === 'template-import').map((item) => ({
        id: `template-import-${item.id}`,
        expectedCode: 'research_template_archive_too_large'
      }))
    ];
    for (const [index, item] of archiveCases.entries()) {
      const sourcePath = join(projectRoot, `${item.id}.zip`);
      const outputDir = join(projectRoot, `output-${index}`);
      await writeFile(sourcePath, await readFile(materialized.archives[`${item.id}.zip`]));
      await assert.rejects(extractResearchTemplate({ projectRoot, sourcePath, outputDir }), (error) => {
        if (item.expectedCode !== undefined) assert.equal(error.message, item.expectedCode, item.id);
        return true;
      });
      await assert.rejects(access(outputDir), { code: 'ENOENT' });
    }

    const mismatchedSource = join(projectRoot, 'mismatched-size.zip');
    const mismatched = setUncompressedSize(await readFile(materialized.archives['valid-members.zip']), 'main.tex', 1);
    await writeFile(mismatchedSource, mismatched);
    const mismatchedOutput = join(projectRoot, 'mismatched-output');
    await assert.rejects(
      extractResearchTemplate({ projectRoot, sourcePath: mismatchedSource, outputDir: mismatchedOutput }),
      (error) => error.message === 'research_template_archive_entry_invalid'
    );
    await assert.rejects(access(mismatchedOutput), { code: 'ENOENT' });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('export writer preserves exclusive destinations and cleans up cancellation and snapshot failures', async () => {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'roc-archive-library-cleanup-'));
  try {
    const sourceRootPath = join(temporaryRoot, 'bundle');
    await mkdir(sourceRootPath);
    const sourceRoot = await realpath(sourceRootPath);
    const smallEntry = await writeEntry(sourceRoot, 'small.txt', 'original contents');

    const existingPath = join(temporaryRoot, 'existing.zip');
    await writeFile(existingPath, 'keep this archive');
    await assert.rejects(createExportZipArchive(sourceRoot, existingPath, [smallEntry], new AbortController().signal));
    assert.equal(await readFile(existingPath, 'utf8'), 'keep this archive');

    const externalPath = join(temporaryRoot, 'outside.txt');
    await writeFile(externalPath, 'outside data');
    await symlink(externalPath, join(sourceRoot, 'linked.txt'));
    const symlinkArchive = join(temporaryRoot, 'symlink.zip');
    await assert.rejects(
      createExportZipArchive(sourceRoot, symlinkArchive, [{ ...smallEntry, path: 'linked.txt' }], new AbortController().signal),
      (error) => error.message === 'research_path_symlink'
    );
    await assert.rejects(access(symlinkArchive), { code: 'ENOENT' });
    assert.equal(await readFile(externalPath, 'utf8'), 'outside data');

    const diskFullEntry = await writeEntry(sourceRoot, 'disk-full.txt', 'disk full cleanup');
    const readerSource = join(temporaryRoot, 'reader-disk-full.zip');
    await createExportZipArchive(sourceRoot, readerSource, [diskFullEntry], new AbortController().signal);
    const writerDiskFullArchive = join(temporaryRoot, 'writer-disk-full.zip');
    await withDiskFullAfter(externalPath, 2, async (getWriteCount) => {
      await assert.rejects(
        createExportZipArchive(sourceRoot, writerDiskFullArchive, [diskFullEntry], new AbortController().signal),
        (error) => error.code === 'ENOSPC'
      );
      assert.ok(getWriteCount() >= 2);
      await assert.rejects(access(writerDiskFullArchive), { code: 'ENOENT' });
    });

    const readerDiskFullOutput = join(temporaryRoot, 'reader-disk-full-output');
    await withDiskFullAfter(externalPath, 1, async () => {
      await assert.rejects(
        extractResearchTemplate({ projectRoot: temporaryRoot, sourcePath: readerSource, outputDir: readerDiskFullOutput }),
        (error) => error.code === 'ENOSPC'
      );
      await assert.rejects(access(readerDiskFullOutput), { code: 'ENOENT' });
    });

    const changedPath = join(sourceRoot, 'small.txt');
    await writeFile(changedPath, 'changed contents!');
    const changedArchive = join(temporaryRoot, 'changed.zip');
    await assert.rejects(
      createExportZipArchive(sourceRoot, changedArchive, [smallEntry], new AbortController().signal),
      (error) => error.message === 'research_export_snapshot_changed'
    );
    await assert.rejects(access(changedArchive), { code: 'ENOENT' });

    const largeEntry = await writeEntry(sourceRoot, 'large.bin', randomBytes(24 * 1024 * 1024));
    const cancelledArchive = join(temporaryRoot, 'cancelled.zip');
    const controller = new AbortController();
    const pending = createExportZipArchive(sourceRoot, cancelledArchive, [largeEntry], controller.signal);
    let partialArchiveSize = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        partialArchiveSize = (await stat(cancelledArchive)).size;
        if (partialArchiveSize > 64) break;
      } catch {
        // The exclusive destination has not been opened yet.
      }
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.ok(partialArchiveSize > 64, 'archive stream should have written bytes before cancellation');
    controller.abort();
    await assert.rejects(pending);
    await assert.rejects(access(cancelledArchive), { code: 'ENOENT' });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});
