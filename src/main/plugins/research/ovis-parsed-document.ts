import {lstat, mkdir, realpath, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {z} from 'zod';
import {researchDocumentLimits, researchOvisParsedDocumentSchema, researchParseContractVersion} from '../../../shared/schemas/research-production';
import {ovisParserVersion, ovisRuntime} from '../../../shared/schemas/research-ovis';
import {researchCoordinateFrameContractVersion, type ResearchDocumentCoordinateFrame} from '../../../shared/schemas/research-document-coordinates';
import {readOvisPaperContent, type OvisPaperContent} from './ovis-paper-content';
import {readResearchFile, researchContentHash} from './research-files';

type ParsedDocument = z.infer<typeof researchOvisParsedDocumentSchema>;
type CaptureInput = Parameters<typeof readOvisPaperContent>[0];
const artifacts = {middleJson: 'artifacts/middle.json', markdown: 'artifacts/document.md', structuredContent: 'artifacts/structured.json'};

/** Only the raw source-bound capture can produce an application result. No model loading or registration. */
async function reconstruct(input: CaptureInput): Promise<{
  parsed: ParsedDocument; frames: ResearchDocumentCoordinateFrame[]; assetIntegrity: OvisPaperContent['assetIntegrity'];
}> {
  const content = await readOvisPaperContent(input);
  return {frames: content.frames, assetIntegrity: content.assetIntegrity, parsed: researchOvisParsedDocumentSchema.parse({
    contractVersion: researchParseContractVersion, engine: 'ovisocr3-mlx', engineVersion: ovisRuntime['mlx-vlm'],
    parserVersion: ovisParserVersion, parserFingerprint: researchContentHash(JSON.stringify({
      contractVersion: researchParseContractVersion, parserVersion: ovisParserVersion,
      runtime: ovisRuntime, paperFingerprint: content.parserFingerprint})),
    modelManifest: content.model.installationReceiptSha256, modelIdentity: content.model, runtime: ovisRuntime,
    tier: 'complete', device: 'metal', parseMode: 'ocr', sourceHash: content.sourceHash,
    sourceCapture: {path: 'manifest.json', sha256: content.sourceManifestSha256},
    pageCount: content.pageCount, content: content.content, blocks: content.blocks, assets: content.assets,
    structure: content.structure, quality: content.quality, warnings: content.warnings, artifacts
  })};
}

function encoded(result: Awaited<ReturnType<typeof reconstruct>>): Record<keyof typeof artifacts, string> {
  const structured = JSON.stringify({...result.parsed, coordinateFrameContractVersion: researchCoordinateFrameContractVersion,
    pages: result.frames.map(frame => ({page: frame.page, frame}))}) + '\n';
  return {middleJson: structured, structuredContent: structured,
    markdown: result.parsed.blocks.map(block => block.kind === 'heading' ? `## ${block.text}` : block.text).filter(Boolean).join('\n\n') + '\n'};
}

/** Write once beside an existing immutable capture; failed writes remove only this call's artifacts directory. */
export async function writeOvisParsedDocument(input: CaptureInput): Promise<ParsedDocument> {
  const result = await reconstruct(input), contents = encoded(result);
  const root = await realpath(input.directory), directory = join(root, 'artifacts');
  input.signal.throwIfAborted();
  await mkdir(directory, {mode: 0o700});
  const owned = await lstat(directory);
  try {
    for (const key of Object.keys(artifacts) as Array<keyof typeof artifacts>) {
      input.signal.throwIfAborted();
      if (Buffer.byteLength(contents[key]) > researchDocumentLimits.maxArtifactBytes) throw new Error('research_document_artifact_limit');
      await writeFile(join(root, artifacts[key]), contents[key], {flag: 'wx', mode: 0o600, signal: input.signal});
    }
    input.signal.throwIfAborted();
    return result.parsed;
  } catch (error) {
    const current = await lstat(directory);
    if (current.isSymbolicLink() || current.dev !== owned.dev || current.ino !== owned.ino) {
      throw new Error('research_ovis_artifact_cleanup_identity_changed', {cause: error});
    }
    await rm(directory, {recursive: true});
    throw error;
  }
}

/** Rebuild before storage; matching caller/structured copies cannot legitimize altered content or provenance. */
export async function verifyOvisParsedDocument(directory: string, parsed: ParsedDocument): Promise<{
  frames: ResearchDocumentCoordinateFrame[]; assetIntegrity: OvisPaperContent['assetIntegrity']; structuredSha256: string;
}> {
  const result = await reconstruct({directory, manifestSha256: parsed.sourceCapture.sha256, sourceHash: parsed.sourceHash,
    model: parsed.modelIdentity, signal: new AbortController().signal});
  if (JSON.stringify(result.parsed) !== JSON.stringify(parsed)) throw new Error('research_ovis_result_capture_mismatch');
  const contents = encoded(result);
  for (const key of Object.keys(artifacts) as Array<keyof typeof artifacts>) {
    const bytes = await readResearchFile(directory, artifacts[key], researchDocumentLimits.maxArtifactBytes);
    if (!bytes.equals(Buffer.from(contents[key]))) throw new Error('research_ovis_result_artifact_mismatch');
  }
  return {frames: result.frames, assetIntegrity: result.assetIntegrity, structuredSha256: researchContentHash(contents.structuredContent)};
}
