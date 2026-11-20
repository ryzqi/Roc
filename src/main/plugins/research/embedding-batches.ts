import {chunkTokenCount} from './knowledge-chunks';
import {normalizeEmbeddingBlob, vectorToBlob} from './embedding-vectors';

export type EmbeddingBatchPolicy = {
  maxItems: number; maxBatchTokens: number; maxInputTokens: number; providerContextTokens: number;
};
/** cl100k is the reproducible local budget. Providers with another tokenizer can reject a smaller limit. */
export const embeddingBatchDefaults: EmbeddingBatchPolicy = {
  maxItems: 32, maxBatchTokens: 16384, maxInputTokens: 8192, providerContextTokens: 8192
};
// Keep request grouping below the gateway's cold-batch time limit. This transport ceiling
// does not alter fragments or weighted pooling, so existing policy-bound vectors remain valid.
export const embeddingRequestMaxItems = 4;
export const embeddingBatchVersion = 'roc-embedding-cl100k-exact-spans-weighted-v1';
export function embeddingCacheVersion(identity: {configId: string; revision: number; model: string; dimensions: number},
  inputVersion: string, policy: EmbeddingBatchPolicy = embeddingBatchDefaults): string {
  return JSON.stringify({inputVersion, ...identity, algorithm: embeddingBatchVersion, policy});
}
type Fragment = {input: number; text: string; tokens: number};
type Send = (texts: string[]) => Promise<number[][]>;
export type CompletedEmbedding = {index: number; vector: Buffer};
function boundary(text: string, end: number): number {
  return end < text.length && /[\uD800-\uDBFF]/u.test(text[end - 1] ?? '') ? end - 1 : end;
}
function fragments(text: string, input: number, limit: number): Fragment[] {
  const count=chunkTokenCount(text);
  if (count<=limit) return [{input,text,tokens:Math.max(1,count)}];
  const result: Fragment[]=[];
  for (let start=0;start<text.length;) {
    let end=boundary(text,Math.min(text.length,start+limit*4));
    while (end>start && chunkTokenCount(text.slice(start,end))>limit) {
      end=boundary(text,start+Math.floor((end-start)*.75));
    }
    if (end<=start) throw new Error('embedding_input_unsplittable');
    const part=text.slice(start,end);
    result.push({input,text:part,tokens:Math.max(1,chunkTokenCount(part))}); start=end;
  }
  return result;
}
function halve(fragment: Fragment): Fragment[] {
  const end=boundary(fragment.text,Math.ceil(fragment.text.length/2));
  if (end<=0 || end>=fragment.text.length) throw new Error('embedding_input_unsplittable');
  return [fragment.text.slice(0,end),fragment.text.slice(end)].map(text=>({
    input:fragment.input,text,tokens:Math.max(1,chunkTokenCount(text))
  }));
}

/** Stored objects remain whole; every provider fragment is an exact, contiguous slice of its input. */
export async function embedTokenBatches(texts: readonly string[], dimensions: number, send: Send,
  signal: AbortSignal, requireCurrent: () => void, policy: EmbeddingBatchPolicy = embeddingBatchDefaults,
  onComplete?: (completed: CompletedEmbedding[]) => void): Promise<Buffer[]> {
  if (!Object.values(policy).every(value=>Number.isSafeInteger(value) && value>0) ||
    !Number.isSafeInteger(dimensions) || dimensions<1) throw new Error('embedding_batch_policy_invalid');
  const limit=Math.min(policy.maxInputTokens,policy.providerContextTokens,policy.maxBatchTokens);
  const parts=texts.flatMap((text,input)=>fragments(text,input,limit));
  const sums=texts.map(()=>Array<number>(dimensions).fill(0)), counts=texts.map(()=>0);
  const single=new Map<number,Buffer>();
  const remaining=texts.map(()=>0), completed=new Map<number,Buffer>();
  for(const part of parts)remaining[part.input]!++;
  const submit=async (batch: Fragment[], depth=0): Promise<void> => {
    signal.throwIfAborted();requireCurrent();
    let values: number[][];
    try {values=await send(batch.map(part=>part.text));}
    catch(error) {
      signal.throwIfAborted();requireCurrent();
      if (!(error instanceof Error) || error.message!=='embedding_provider_input_limit' || depth>=16) throw error;
      if (batch.length>1) {
        const middle=Math.ceil(batch.length/2);
        await submit(batch.slice(0,middle),depth+1);await submit(batch.slice(middle),depth+1);
      } else {
        const split=halve(batch[0]!);
        remaining[batch[0]!.input]!++;
        await submit([split[0]!],depth+1);await submit([split[1]!],depth+1);
      }
      return;
    }
    signal.throwIfAborted();requireCurrent();
    if (values.length!==batch.length) throw new Error('embedding_provider_count_mismatch');
    const accepted=batch.map((_,index)=>normalizeEmbeddingBlob(vectorToBlob(values[index]!),dimensions));
    batch.forEach((part,index)=>{
      const blob=accepted[index]!;
      single.set(part.input,blob);counts[part.input]!++;remaining[part.input]!--;
      for (let offset=0;offset<dimensions;offset++) sums[part.input]![offset]!+=blob.readFloatLE(offset*4)*part.tokens;
    });
    const ready: CompletedEmbedding[]=[];
    for(const part of batch) {
      if(remaining[part.input]!==0 || completed.has(part.input))continue;
      const vector=counts[part.input]===1 ? single.get(part.input)! : normalizeEmbeddingBlob(vectorToBlob(sums[part.input]!),dimensions);
      completed.set(part.input,vector);ready.push({index:part.input,vector});
    }
    if(ready.length)onComplete?.(ready);
  };
  let batch: Fragment[]=[], tokens=0;
  for (const part of parts) {
    if (batch.length && (batch.length>=Math.min(policy.maxItems,embeddingRequestMaxItems) || tokens+part.tokens>policy.maxBatchTokens)) {
      await submit(batch);batch=[];tokens=0;
    }
    batch.push(part);tokens+=part.tokens;
  }
  if(batch.length) await submit(batch);
  signal.throwIfAborted();requireCurrent();
  return texts.map((_,input)=>completed.get(input)!);
}
