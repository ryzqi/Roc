import {createHash} from 'node:crypto';
import {writingContextReceiptSchema, type WritingContextReceipt} from '../../../shared/schemas/research-writing-context';

export const writingContextBasis = (receipt: WritingContextReceipt): string => createHash('sha256')
  .update(JSON.stringify({...receipt, result: {...receipt.result, basisDigest: null}})).digest('hex');
export type WritingContextRecord = {project_id: string; artifact_id: string; locator: string; excerpt: string; payload_json: string};

/** Callers join the workflow event by project/source ID and require its preparation event type. */
export function readWritingContextReceipt(row: WritingContextRecord): WritingContextReceipt {
  const receipt = writingContextReceiptSchema.parse(JSON.parse(row.excerpt));
  const event = JSON.parse(row.payload_json) as {contextId: string; artifactId: string; basisDigest: string};
  if (receipt.request.projectId !== row.project_id || receipt.result.projectId !== row.project_id ||
    receipt.request.artifactId !== row.artifact_id || receipt.result.artifactId !== row.artifact_id ||
    receipt.result.contextId !== row.locator || receipt.result.basisDigest !== writingContextBasis(receipt) ||
    event.contextId !== row.locator || event.artifactId !== row.artifact_id || event.basisDigest !== receipt.result.basisDigest) {
    throw new Error('research_writing_receipt_invalid');
  }
  return receipt;
}
