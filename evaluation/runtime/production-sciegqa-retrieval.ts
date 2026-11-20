import {createHash} from 'node:crypto';
import type {parseResearchDocument} from '../../src/main/plugins/research/document-parser';
import {indexDocumentBlocks} from '../../src/main/plugins/research/index-files';
import {openProductionRag, type RetrievalConfiguration} from './production-rag';

export type SciegqaParsedSource = {
  id: string; title: string; sourceUri: string; sourceHash: string;
  resultHash: string; parseId: string; parsed: Awaited<ReturnType<typeof parseResearchDocument>>;
};
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Production block-derived IR/chunking and BM25 services in a private DB.
 * Receives parsed original sources only, never published QA or gold regions. */
export async function openSciegqaRetrieval(input: {
  path: string; sources: SciegqaParsedSource[]; projectId: string;
  config: RetrievalConfiguration; signal: AbortSignal;
}) {
  if (input.config.mode !== 'bm25' || input.config.rerank !== 'none') {
    throw new Error('scientific_sciegqa_retrieval_configuration_unsupported');
  }
  const runtime = await openProductionRag({...input, documents: []});
  try {
    for (const source of input.sources) {
      input.signal.throwIfAborted();
      if (source.parsed.sourceHash !== source.sourceHash ||
        source.parseId !== `evaluation-sciegqa:${source.resultHash}`) {
        throw new Error('scientific_sciegqa_retrieval_source_changed');
      }
      const chunks = indexDocumentBlocks(source.parsed.blocks, {
        paperId: source.id, parseId: source.parseId, sourceHash: source.sourceHash
      });
      const content = chunks.map(chunk => chunk.content).join('\n\n');
      runtime.repository.upsertFromSource({
        id: source.id, projectId: input.projectId, sourceType: 'file', sourceId: source.id,
        title: source.title, content, chunks, embeddingPolicy: 'none'
      }, {sourceHash: source.sourceHash, contentSha256: digest(content), sourceVersion: source.resultHash,
        parseId: source.parseId, parserVersion: source.parsed.parserVersion,
        parserFingerprint: source.parsed.parserFingerprint, sourceUri: source.sourceUri, license: null});
    }
    return runtime;
  } catch (error) {await runtime.close(); throw error;}
}
