export function normalizeEmbeddingBlob(blob: Buffer, dimensions: number): Buffer {
  if (!Number.isSafeInteger(dimensions) || dimensions < 1 || blob.length !== dimensions * 4) throw new Error('embedding_vector_invalid');
  // Roc's macOS/arm64 runtime is little endian. Keep Number arithmetic and
  // Float32 writes identical to vectorToBlob, including unaligned Buffers.
  const values = blob.byteOffset % 4 === 0 ? new Float32Array(blob.buffer, blob.byteOffset, dimensions) : null;
  let maximum = 0;
  for (let index = 0; index < dimensions; index++) {
    const value = values === null ? blob.readFloatLE(index * 4) : values[index]!;
    if (!Number.isFinite(value)) throw new Error('embedding_vector_invalid');
    maximum = Math.max(maximum, Math.abs(value));
  }
  if (maximum === 0) throw new Error('embedding_vector_invalid');
  let squaredNorm = 0;
  for (let index = 0; index < dimensions; index++) {
    const value = values === null ? blob.readFloatLE(index * 4) : values[index]!;
    squaredNorm += (value / maximum) ** 2;
  }
  const norm = Math.sqrt(squaredNorm);
  const normalized = Buffer.alloc(blob.length);
  for (let index = 0; index < dimensions; index++) {
    const value = values === null ? blob.readFloatLE(index * 4) : values[index]!;
    normalized.writeFloatLE((value / maximum) / norm, index * 4);
  }
  return normalized;
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
