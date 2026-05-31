import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RtkBypassReason, RtkStatus } from '../../shared/types';
import { RTKBinaryManager } from '../../rtk-integration';
import type { RocPaths } from './paths';

export type RtkExecutionMetadata = {
  binaryPath: string;
  runtimeRoot: string;
  configPath: string;
  teeDir: string;
  trackingDatabasePath: string;
  resourceState: 'ready' | 'missing';
  bypassReason?: RtkBypassReason;
};

export class RtkService {
  constructor(
    private readonly paths: RocPaths,
    private readonly binaryManager = new RTKBinaryManager()
  ) {}

  getStatus(): RtkStatus {
    const metadata = this.getExecutionMetadata();
    return {
      enabledForAgentCommands: true,
      binaryPath: metadata.binaryPath,
      configPath: metadata.configPath,
      teeDir: metadata.teeDir,
      resourceState: metadata.resourceState,
      bypassReason: metadata.bypassReason
    };
  }

  getExecutionMetadata(): RtkExecutionMetadata {
    const bundledBinaryPath = this.binaryManager.getRTKBinaryPath();
    const binaryPath = bundledBinaryPath === null ? join(this.paths.toolsDir, 'roc-rtk.exe') : bundledBinaryPath;
    const binaryExists =
      bundledBinaryPath === null ? existsSync(binaryPath) : this.binaryManager.isRTKAvailable();
    return {
      binaryPath,
      runtimeRoot: this.paths.root,
      configPath: join(this.paths.rtkDir, 'config.toml'),
      teeDir: join(this.paths.rtkDir, 'tee'),
      trackingDatabasePath: join(this.paths.rtkDir, 'history.db'),
      resourceState: binaryExists ? 'ready' : 'missing',
      bypassReason: binaryExists ? undefined : 'rtk_binary_missing'
    };
  }
}
