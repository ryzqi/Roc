import type { RTKBinaryManager } from '../../../rtk-integration';
import { RocPaths } from '../../services/paths';
import { RtkService } from '../../services/rtk-service';

export type RtkAdapterOptions = {
  rootDir?: string;
  binaryManager?: RTKBinaryManager;
};

export function createRtkService(options: RtkAdapterOptions = {}): RtkService {
  const paths = new RocPaths(options.rootDir);
  paths.ensureTree();
  if (options.binaryManager !== undefined) {
    return new RtkService(paths, options.binaryManager);
  }
  return new RtkService(paths);
}
