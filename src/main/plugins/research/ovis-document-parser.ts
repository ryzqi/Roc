import {lstat, realpath, rm} from 'node:fs/promises';
import {relative} from 'node:path';
import {type z} from 'zod';
import {researchDocumentLimits, type researchOvisParsedDocumentSchema} from '../../../shared/schemas/research-production';
import {createOvisSourceArtifact, type OvisSourceArtifactInput} from './ovis-source-artifact';
import type {OvisInstallationManager} from './ovis-installation-manager';
import {writeOvisParsedDocument} from './ovis-parsed-document';
import {hasUnprovenResearchProcessExit} from './process-exit-state';
import {readResearchFile, researchContentHash} from './research-files';

type Dependencies = {capture: typeof createOvisSourceArtifact; write: typeof writeOvisParsedDocument};

/** Complete source-to-result transaction used by the production complete tier. */
export async function parseOvisDocument(input: Omit<OvisSourceArtifactInput, 'installation'>,
  models: Pick<OvisInstallationManager, 'acquire'>,
  dependencies: Dependencies = {capture: createOvisSourceArtifact, write: writeOvisParsedDocument}
): Promise<z.infer<typeof researchOvisParsedDocumentSchema>> {
  input.signal.throwIfAborted();
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs <= 0 || input.timeoutMs > 2_147_483_647) {
    throw new Error('research_ovis_request_invalid');
  }
  input = {...input, signal: AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs)])};
  const lease = await models.acquire(input.signal);
  let release = true, output: {path: string; dev: number; ino: number} | null = null;
  try {
    const capture = await dependencies.capture({...input, installation: lease.installation});
    const info = await lstat(input.outputDir), path = await realpath(input.outputDir);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('research_ovis_artifact_directory_invalid');
    output = {path, dev: info.dev, ino: info.ino};
    input.signal.throwIfAborted();
    const manifest = await readResearchFile(path, 'manifest.json', researchDocumentLimits.maxArtifactBytes);
    const result = await dependencies.write({directory: path, manifestSha256: researchContentHash(manifest),
      sourceHash: capture.sourceHash, model: lease.installation.identity, signal: input.signal});
    const source = await readResearchFile(await realpath(input.projectRoot), relative(input.projectRoot, input.sourcePath),
      researchDocumentLimits.maxTotalAssetBytes);
    if (researchContentHash(source) !== capture.sourceHash) throw new Error('research_source_changed_during_parse');
    input.signal.throwIfAborted();
    return result;
  } catch (error) {
    if (hasUnprovenResearchProcessExit(error)) {
      // Keep both inputs and the model lease: no install/remove may race a possibly live Worker.
      release = false;
    } else if (output) {
      try {
        const info = await lstat(input.outputDir);
        if (info.isSymbolicLink() || info.dev !== output.dev || info.ino !== output.ino ||
            await realpath(input.outputDir) !== output.path) throw new Error('research_ovis_artifact_cleanup_identity_changed');
        await rm(output.path, {recursive: true});
      } catch (cleanup) {throw new AggregateError([error, cleanup], 'research_ovis_parse_cleanup_failed');}
    }
    throw error;
  } finally {if (release) lease.release();}
}
