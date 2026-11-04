import type {ResearchDocumentContent} from '../../shared/types';

/** Hash the normalized content returned by the generated document boundary. */
export async function documentContentHash(content: ResearchDocumentContent): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(content)));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
