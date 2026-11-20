import {join} from 'node:path';
import {createExportZipArchive} from './export-archive';
import {ResearchExportFiles, exportFileLimit, type ExportToolchain} from './export-files';
import {readResearchFile, researchContentHash} from './research-files';
import {runArxivPreflight} from './arxiv-preflight';
import {compileLatex} from './latex-service';
import {serializeResearchPublicProjection} from './export-public-projection';

/** Build a reviewable derivative of the frozen export, never the live workspace. */
export async function buildArxivSubmission(input: {
  writer: ResearchExportFiles; entryPath: string; bbl: string | null; scratch: string;
  projectId: string; exportId: string; artifactId: string; sourceHash: string | null;
  tools: ExportToolchain; signal: AbortSignal;
}): Promise<void> {
  const {writer, signal} = input;
  const originals = writer.list().filter(file => file.path.startsWith('source/'));
  const texts = new Map<string, string>();
  for (const file of originals) {
    signal.throwIfAborted();
    if (/\.(?:tex|sty|cls)$/u.test(file.path)) {
      texts.set(file.path.slice(7), (await readResearchFile(writer.root, file.path, exportFileLimit)).toString('utf8'));
    }
  }
  const preflight = runArxivPreflight({entryPath: input.entryPath, texFiles: texts,
    files: originals.map(file => ({...file, path: file.path.slice(7)})), bbl: input.bbl});
  const changes = [];
  for (const file of originals) {
    signal.throwIfAborted();
    const path = file.path.slice(7);
    const removed = preflight.pruned.includes(path);
    if (!removed) await writer.copy(writer.root, file, `submission/source/${path}`);
    changes.push({path, action: removed ? 'removed' : 'retained', originalSha256: file.sha256,
      derivedSha256: removed ? null : file.sha256, reason: removed ? 'unreachable_unmentioned_tex' : 'conservative_byte_copy'});
  }
  const sourceRoot = join(writer.root, 'submission/source');
  let compileStatus: 'not_run_blocked' | 'ready' | 'failed' = 'not_run_blocked';
  let pdfHash: string | null = null;
  if (!preflight.submissionBlocked) {
    const compiled = await compileLatex({rootPath: sourceRoot, entryPath: input.entryPath,
      outputDir: join(input.scratch, 'submission-compiled'), jobDir: input.scratch, signal,
      runner: request => input.tools.compile({...request, admission: {projectId: input.projectId, priority: 'user'}})});
    compileStatus = compiled.status;
    pdfHash = compiled.pdfHash;
    await writer.write('submission/compile-diagnostics.public.json', serializeResearchPublicProjection(compiled.diagnostics));
  }
  const files = writer.list().filter(file => file.path.startsWith('submission/source/'))
    .map(file => ({...file, path: file.path.slice('submission/source/'.length)}));
  // The outer export has a per-file bound; do not create an oversized nested archive.
  const archiveWithinBudget = files.reduce((total, file) => total + file.size, 0) < exportFileLimit - 1024 * 1024;
  let archive: {path: string; sha256: string; size: number} | null = null;
  if (compileStatus === 'ready' && archiveWithinBudget) {
    const zipPath = join(input.scratch, 'submission.zip');
    const zip = await createExportZipArchive(sourceRoot, zipPath, files, signal);
    const bytes = await readResearchFile(input.scratch, 'submission.zip', exportFileLimit);
    if (researchContentHash(bytes) !== zip.sha256) throw new Error('research_export_snapshot_changed');
    archive = await writer.write('submission/submission.zip', bytes);
  }
  const manifest = {schemaVersion: 1, rulesVersion: 'roc-arxiv-v2', target: 'arxiv-manual-review',
    rulesReference: 'https://info.arxiv.org/help/submit_tex.html',
    origin: {kind: 'approved_artifact_export', exportId: input.exportId, artifactId: input.artifactId, sourceHash: input.sourceHash},
    entryPath: input.entryPath, preflight, changes, archive,
    compilation: {environment: 'Roc pinned Tectonic bundle', toolchainHash: await input.tools.utilityIdentity(), status: compileStatus, pdfHash},
    limitations: ['arXiv environment not executed; human submission review required',
      'No comment removal, macro expansion or text rewriting',
      ...(!archiveWithinBudget ? ['Nested archive omitted: exceeds per-file export budget; review submission/source'] : [])]};
  await writer.write('submission/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);
  await writer.write('logs/arxiv-preflight.json', `${JSON.stringify(preflight, null, 2)}\n`);
}
