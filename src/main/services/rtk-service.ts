import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { RtkStatus } from '../../shared/types';
import type { RocPaths } from './paths';

export class RtkService {
  constructor(private readonly paths: RocPaths) {}

  getStatus(): RtkStatus {
    const binaryPath = join(this.paths.toolsDir, 'roc-rtk.exe');
    const binaryExists = existsSync(binaryPath);
    return {
      enabledForAgentCommands: true,
      binaryPath,
      configPath: join(this.paths.configDir, 'rtk.toml'),
      teeDir: join(this.paths.rtkDir, 'tee'),
      resourceState: binaryExists ? 'ready' : 'missing',
      bypassReason: binaryExists ? undefined : 'rtk_binary_missing'
    };
  }
}
