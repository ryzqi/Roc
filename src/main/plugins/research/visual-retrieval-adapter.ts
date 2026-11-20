import {setImmediate} from 'node:timers/promises';
import type {VisualModel} from '../../../shared/schemas/research-visual-retrieval';

export type VisualMatrix = {tokens: number; dimensions: number; values: Float32Array};
/** Engines own inference and resource settlement; the index owns authorization and ranking. */
export interface VisualRetrievalAdapter {
  encode(input: {projectId: string; model: VisualModel; images: readonly Buffer[]; query: string | null},
    signal: AbortSignal): Promise<{matrices: VisualMatrix[]; assertCurrent: () => void}>;
}
export function validateVisualMatrix(matrix: VisualMatrix, maxTokens = 4096): void {
  if (!Number.isInteger(matrix.tokens) || matrix.tokens < 1 || matrix.tokens > maxTokens ||
    !Number.isInteger(matrix.dimensions) || matrix.dimensions < 1 || matrix.dimensions > 512 ||
    !(matrix.values instanceof Float32Array) || matrix.values.length !== matrix.tokens * matrix.dimensions) {
    throw new Error('research_visual_matrix_shape_invalid');
  }
  for (let i = 0; i < matrix.tokens; i++) {
    let norm = 0;
    for (let j = 0; j < matrix.dimensions; j++) {
      const value = matrix.values[i * matrix.dimensions + j]!;
      if (!Number.isFinite(value)) throw new Error('research_visual_matrix_value_invalid');
      norm += value * value;
    }
    if (Math.abs(norm - 1) > 0.01) throw new Error('research_visual_matrix_not_normalized');
  }
}
export function encodeVisualMatrix(matrix: VisualMatrix): Buffer {
  validateVisualMatrix(matrix);
  const bytes = Buffer.alloc(matrix.values.length * 4);
  matrix.values.forEach((value, i) => bytes.writeFloatLE(value, i * 4));
  return bytes;
}
export function decodeVisualMatrix(bytes: Buffer, shape: Pick<VisualMatrix, 'tokens' | 'dimensions'>): VisualMatrix {
  if (bytes.length !== shape.tokens * shape.dimensions * 4 || bytes.length > 8 * 1024 ** 2) {
    throw new Error('research_visual_matrix_size_invalid');
  }
  const values = new Float32Array(bytes.length / 4);
  for (let i = 0; i < values.length; i++) values[i] = bytes.readFloatLE(i * 4);
  const matrix = {...shape, values}; validateVisualMatrix(matrix); return matrix;
}
/** Sum of per-query-token maximum cosine similarities; never average document tokens. */
export async function visualMaxSim(query: VisualMatrix, documents: readonly VisualMatrix[], signal: AbortSignal): Promise<number[]> {
  validateVisualMatrix(query, 256);
  let operations = 0;
  for (const document of documents) {
    validateVisualMatrix(document);
    if (document.dimensions !== query.dimensions) throw new Error('research_visual_dimensions_changed');
    operations += query.tokens * document.tokens * query.dimensions;
  }
  if (operations > 100_000_000) throw new Error('research_visual_scoring_budget_exceeded');
  const deadline = performance.now() + 2000, scores: number[] = [];
  let work = 0;
  for (const document of documents) {
    let score = 0;
    for (let q = 0; q < query.tokens; q++) {
      let max = -Infinity;
      for (let d = 0; d < document.tokens; d++) {
        let dot = 0;
        for (let k = 0; k < query.dimensions; k++) {
          dot += query.values[q * query.dimensions + k]! * document.values[d * document.dimensions + k]!;
        }
        max = Math.max(max, dot); work += query.dimensions;
        if (work >= 65536) {
          await setImmediate(); signal.throwIfAborted(); work = 0;
          if (performance.now() > deadline) throw new Error('research_visual_scoring_timeout');
        }
      }
      score += max;
    }
    scores.push(score);
  }
  signal.throwIfAborted(); return scores;
}
