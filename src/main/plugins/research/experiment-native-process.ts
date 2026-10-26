import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import bridge from '../../../../resources/research-runtime/r-process.lock.json';
import bridgeSource from '../../../../resources/research-runtime/r-process.c?raw';
import { researchContentHash } from './research-files';
import { experimentDirectoryEntryLimit, experimentFileCountLimit, experimentFileLimit, experimentOutputTotalLimit } from './experiment-files';
import type { ResearchProcessRequest, ResearchProcessResult } from './process-runner';

export async function runRExperimentProcess(request: ResearchProcessRequest,
  run: (request: ResearchProcessRequest) => Promise<ResearchProcessResult>): Promise<ResearchProcessResult> {
  request.signal?.throwIfAborted();
  if (request.command !== '/usr/bin/env') throw new Error('research_experiment_r_launcher_invalid');
  // 桥接库只有 arm64 一片；在别的架构上 DYLD_INSERT_LIBRARIES 会静默不生效。
  if (process.arch !== 'arm64') throw new Error('research_experiment_r_architecture_unsupported');
  const bytes = Buffer.from(bridge.data, 'base64');
  if (researchContentHash(bytes) !== bridge.sha256 || researchContentHash(bridgeSource) !== bridge.sourceHash) throw new Error('research_experiment_r_bridge_changed');
  // R 的初始化拒绝带空格的 TMPDIR；此目录仅属于本次进程，结束后统一清理。
  const temporary = await mkdtemp('/private/tmp/roc-research-r-');
  try {
    const library = join(temporary, 'roc-research-r-process.dylib');
    await writeFile(library, bytes, { flag: 'wx', mode: 0o500 });
    // R 的初始化和临时目录回收依赖这些系统工具；内核仍拒绝脱组及 posix_spawn。
    const helpers = ['/bin/sh', '/bin/bash', '/usr/bin/uname', '/usr/bin/which', '/bin/rm'];
    return await run({ ...request, args: [`DYLD_INSERT_LIBRARIES=${library}`, ...request.args], readablePaths: [...request.readablePaths, ...helpers, library],
      additionalExecutables: [...(request.additionalExecutables ?? []), ...helpers], writablePaths: [...request.writablePaths, temporary],
      writeLimits: [...(request.writeLimits ?? []), { path: temporary, maxFileBytes: experimentFileLimit, maxTotalBytes: experimentOutputTotalLimit,
        maxFiles: experimentFileCountLimit, maxEntries: experimentDirectoryEntryLimit }],
      environment: { ...request.environment, TMPDIR: temporary, TMP: temporary, TEMP: temporary } });
  } finally { await rm(temporary, { recursive: true, force: true }); }
}

export function rProcessBridgeHash(): string { return researchContentHash(JSON.stringify(bridge)); }
