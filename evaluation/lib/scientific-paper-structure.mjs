import {hash} from './common.mjs';

/** Validate original-title intervals and graph edges independently of the production builder. */
export function verifyScientificPaperStructure(blocks, structure, chunks) {
  const source = new Map(blocks.map(b => [b.id, b]));
  if (source.size !== blocks.length || structure.version !== 1 || !structure.ruleVersion ||
      structure.blocks.length !== blocks.length || new Set(structure.blocks.map(b => b.blockId)).size !== blocks.length) {
    throw new Error('scientific_structure_source_inventory_invalid');
  }
  const nodes = new Map(), categories = {}, roles = {}, statuses = {};
  for (const node of structure.sections) {
    const block = source.get(node.blockId), parent = node.parentId === null ? null : nodes.get(node.parentId);
    if (!block || nodes.has(node.id) || !Number.isInteger(node.start) || !Number.isInteger(node.end) ||
        node.start < 0 || node.end <= node.start || node.end > block.text.length ||
        block.text.slice(node.start, node.end) !== node.title || node.source !== 'rule' ||
        !Number.isInteger(node.level) || node.level < 1 || node.level > 12 ||
        node.parentId !== null && (!parent || parent.level >= node.level)) {
      throw new Error('scientific_structure_title_or_tree_invalid');
    }
    nodes.set(node.id, node); categories[node.category] = (categories[node.category] ?? 0) + 1;
  }
  const annotations = new Map(structure.blocks.map(b => [b.blockId, b]));
  for (const item of structure.blocks) {
    if (!source.has(item.blockId) || item.sectionIds.length > 12) throw new Error('scientific_structure_source_inventory_invalid');
    let parent = null;
    for (const id of item.sectionIds) {
      const node = nodes.get(id);
      if (!node || node.parentId !== parent) throw new Error('scientific_structure_path_invalid');
      parent = id;
    }
    const sem = item.semantic;
    if (sem.version !== 1 || !sem.classifierVersion || !['classified', 'unknown', 'not_applicable'].includes(sem.status) ||
        (sem.status === 'classified') !== (sem.roles.length > 0) || new Set(sem.roles.map(r => r.role)).size !== sem.roles.length) {
      throw new Error('scientific_structure_semantic_invalid');
    }
    statuses[sem.status] = (statuses[sem.status] ?? 0) + 1;
    for (const r of sem.roles) {
      if (!['problem', 'contribution', 'method', 'dataset', 'metric', 'experimental_setup', 'result', 'ablation', 'limitation'].includes(r.role) ||
          !Number.isFinite(r.confidence) || r.confidence < 0 || r.confidence > 1 || !['rule', 'model'].includes(r.source)) {
        throw new Error('scientific_structure_semantic_invalid');
      }
      roles[r.role] = (roles[r.role] ?? 0) + 1;
    }
  }
  const published = blocks.filter(b => b.text.trim());
  if (published.length !== chunks.length) throw new Error('scientific_structure_chunk_source_changed');
  for (let i = 0; i < published.length; i++) {
    const b = published[i], chunk = chunks[i], a = annotations.get(b.id);
    if (chunk.content !== b.text || chunk.locator !== b.locator || chunk.semantic.blockId !== b.id ||
        hash(chunk.semantic.scientific) !== hash(a.semantic) || hash(chunk.semantic.sectionIds) !== hash(a.sectionIds)) {
      throw new Error('scientific_structure_chunk_source_changed');
    }
  }
  return {blocks: blocks.length, sections: nodes.size, categories, roles, statuses,
    sourceHash: hash(blocks), structureHash: hash(structure), chunkHash: hash(chunks)};
}
