import {link, unlink, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {paperIrArtifactSchema, paperIrV2Version, type PaperIRArtifact, type PaperIRV2} from '../../../shared/schemas/research-paper-ir-v2';
import {createResearchDirectory, readResearchFile, researchContentHash, researchRelativePath} from './research-files';
import {paperIRObjects, validatePaperIR} from './paper-ir-validation';

const maxIRBytes = 128 * 1024 * 1024;
export function paperIRArtifact(ir: PaperIRV2): PaperIRArtifact {
  const bytes = Buffer.from(JSON.stringify(validatePaperIR(ir))), sha256 = researchContentHash(bytes);
  if (bytes.length > maxIRBytes) throw new Error('research_paper_ir_too_large');
  const scope = researchContentHash(`${ir.identity.documentId}\n${ir.identity.parseId}`);
  const objectBlocks = new Set([...ir.tables, ...ir.figures, ...ir.equations].map(o => o.blockId));
  const indexedBlocksHash = researchContentHash(JSON.stringify(ir.blocks.filter(b => b.text.trim() || objectBlocks.has(b.blockId))
    .map(b => ({id: b.blockId, kind: b.kind, text: b.text, locator: b.sourceLocator.rawLocator}))));
  return paperIrArtifactSchema.parse({version: paperIrV2Version,
    path: `paper-ir/${scope}/${ir.identity.parseHash}/${sha256}.json`, sha256, size: bytes.length,
    identity: ir.identity, metadata: ir.metadata, indexedBlocksHash});
}
export function assertPaperIRArtifact(input: PaperIRArtifact, ir: PaperIRV2): void {
  if (JSON.stringify(paperIrArtifactSchema.parse(input)) !== JSON.stringify(paperIRArtifact(ir))) {
    throw new Error('research_paper_ir_artifact_changed');
  }
}
/** The owning library/index catalog selects a receipt. No mutable "latest" file or history overwrite. */
export class PaperIRRepository {
  constructor(private readonly root: string) {}
  async publish(input: PaperIRV2): Promise<PaperIRArtifact> {
    const ir = validatePaperIR(input), receipt = paperIRArtifact(ir);
    const path = researchRelativePath(receipt.path), slash = path.lastIndexOf('/');
    const dir = await createResearchDirectory(this.root, path.slice(0, slash));
    const target = join(dir, path.slice(slash + 1)), temporary = join(dir, `.staging-${randomUUID()}`);
    await writeFile(temporary, JSON.stringify(ir), {flag: 'wx', mode: 0o600});
    try {
      // Hard-link publication is atomic and exclusive on POSIX; rename could overwrite history.
      try {await link(temporary, target);}
      catch (error) {if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;}
      await this.read(receipt);
    } finally {await unlink(temporary);}
    return receipt;
  }
  async read(input: PaperIRArtifact, scope?: Partial<Pick<PaperIRArtifact['identity'], 'paperId' | 'documentId' | 'parseId' | 'knowledgeDocumentId'>>): Promise<PaperIRV2> {
    const receipt = paperIrArtifactSchema.parse(input);
    for (const [key, value] of Object.entries(scope ?? {})) {
      if (receipt.identity[key as keyof typeof receipt.identity] !== value) throw new Error('research_paper_ir_scope_invalid');
    }
    const bytes = await readResearchFile(this.root, receipt.path, maxIRBytes);
    if (bytes.length !== receipt.size || researchContentHash(bytes) !== receipt.sha256) throw new Error('research_paper_ir_artifact_changed');
    const ir = validatePaperIR(JSON.parse(bytes.toString('utf8')));
    assertPaperIRArtifact(receipt, ir);
    return ir;
  }
  object(ir: PaperIRV2, id: string) {
    const object = paperIRObjects(validatePaperIR(ir)).find(o => o.id === id);
    if (!object) throw new Error('research_paper_ir_object_not_found');
    return object;
  }
  isCurrent(receipt: PaperIRArtifact, current: PaperIRArtifact | null): boolean {
    return current !== null && receipt.sha256 === current.sha256 && receipt.identity.parseId === current.identity.parseId;
  }
}
