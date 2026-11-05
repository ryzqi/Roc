import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import guard from '../../../../resources/research-runtime/process-guard.lock.json';

export function researchProcessGuardHash(): string { return guard.sha256; }

export async function withResearchProcessGuard<T>(run: (executable: string, remove: () => Promise<void>) => Promise<T>): Promise<T> {
  if (process.arch !== 'arm64') throw new Error('research_process_architecture_unsupported');
  const bytes = Buffer.from(guard.data, 'base64');
  if (createHash('sha256').update(bytes).digest('hex') !== guard.sha256) throw new Error('research_process_guard_changed');
  const temporary = await mkdtemp('/private/tmp/roc-research-guard-');
  const remove = (): Promise<void> => rm(temporary, { recursive: true, force: true });
  try {
    const executable = join(temporary, 'guard');
    await writeFile(executable, bytes, { flag: 'wx', mode: 0o500 });
    return await run(executable, remove);
  } finally {
    await remove();
  }
}
