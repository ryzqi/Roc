export function normalizeEmbeddingBlob(blob: Buffer, dimensions: number): Buffer {
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || blob.length !== dimensions * 4) throw new Error('embedding_vector_invalid');
  const values: number[] = [];
  for (let offset = 0; offset < blob.length; offset += 4) {
    values.push(blob.readFloatLE(offset));
  }
  return vectorToBlob(values);
}

export function vectorToBlob(vector: readonly number[]): Buffer {
  let maximum = 0;
  for (const value of vector) {
    if (!Number.isFinite(value)) throw new Error('embedding_vector_invalid');
    maximum = Math.max(maximum, Math.abs(value));
  }
  if (maximum === 0) throw new Error('embedding_vector_invalid');
  let squaredNorm = 0;
  for (const value of vector) squaredNorm += (value / maximum) ** 2;
  const norm = Math.sqrt(squaredNorm);
  const blob = Buffer.alloc(vector.length * 4);
  vector.forEach((value, index) => blob.writeFloatLE((value / maximum) / norm, index * 4));
  return blob;
}
