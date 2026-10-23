import { accessSync, constants, existsSync } from 'node:fs';
import path from 'node:path';

export type RTKBinaryManagerOptions = {
  arch?: NodeJS.Architecture;
  resourceRoot?: string;
  resourcesPath?: string;
};

type PlatformBinary = {
  platformDir: string;
  binaryName: string;
};

type ElectronProcess = NodeJS.Process & {
  defaultApp?: boolean;
  resourcesPath?: string;
};

export class RTKBinaryManager {
  private readonly binaryPath: string | null;

  constructor(private readonly options: RTKBinaryManagerOptions = {}) {
    this.binaryPath = this.resolveBinaryPath();
  }

  getRTKBinaryPath(): string | null {
    return this.binaryPath;
  }

  isRTKAvailable(): boolean {
    if (this.binaryPath === null || !existsSync(this.binaryPath)) {
      return false;
    }

    try {
      accessSync(this.binaryPath, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  private resolveBinaryPath(): string | null {
    const platformBinary = this.resolvePlatformBinary();
    if (platformBinary === null) {
      return null;
    }

    return path.join(this.resourceBaseDir(), 'rtk-binaries', platformBinary.platformDir, platformBinary.binaryName);
  }

  private resolvePlatformBinary(): PlatformBinary | null {
    // 只随包 darwin-arm64/rtk；别的架构返回 null，由调用方降级。
    if (this.arch() !== 'arm64') {
      return null;
    }
    return { platformDir: 'darwin-arm64', binaryName: 'rtk' };
  }

  private resourceBaseDir(): string {
    if (this.options.resourcesPath !== undefined) {
      return this.options.resourcesPath;
    }

    const electronProcess = process as ElectronProcess;
    const resourcesPath = electronProcess.resourcesPath;
    if (resourcesPath !== undefined && electronProcess.defaultApp !== true) {
      return resourcesPath;
    }

    return path.join(this.options.resourceRoot ?? process.cwd(), 'resources');
  }

  private arch(): NodeJS.Architecture {
    return this.options.arch ?? process.arch;
  }
}
