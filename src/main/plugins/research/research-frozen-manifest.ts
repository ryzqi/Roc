import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { readResearchFile, researchContentHash } from './research-files';

export async function writeFrozenManifest(input: {
  root: string;
  path: string;
  content: string;
  limit: number;
  changedCode: string;
}): Promise<string> {
  const hash = researchContentHash(input.content);
  try {
    await writeFile(join(input.root, input.path), input.content, { flag: 'wx', mode: 0o400 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (researchContentHash(await readResearchFile(input.root, input.path, input.limit)) !== hash) {
      throw new Error(input.changedCode);
    }
  }
  return hash;
}
