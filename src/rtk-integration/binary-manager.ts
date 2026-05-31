import { accessSync, constants, existsSync } from 'node:fs';
import path from 'node:path';

type NodePlatform = NodeJS.Platform | 'freebsd';

export type RTKBinaryManagerOptions = {
  platform?: NodePlatform;
  arch?: NodeJS.Architecture;
  resourceRoot?: string;
  resourcesPath?: string;
};

type PlatformBinary = {
  platformDir: string;
  binaryName: string;
};

type ElectronProcess = NodeJS.Process & {
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

    if (this.platform() === 'win32') {
      return true;
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
    const platform = this.platform();
    const arch = this.arch();

    if (platform === 'win32' && arch === 'x64') {
      return { platformDir: 'win32-x64', binaryName: 'rtk.exe' };
    }
    if (platform === 'darwin' && arch === 'x64') {
      return { platformDir: 'darwin-x64', binaryName: 'rtk' };
    }
    if (platform === 'darwin' && arch === 'arm64') {
      return { platformDir: 'darwin-arm64', binaryName: 'rtk' };
    }
    if (platform === 'linux' && arch === 'x64') {
      return { platformDir: 'linux-x64', binaryName: 'rtk' };
    }
    return null;
  }

  private resourceBaseDir(): string {
    if (this.options.resourcesPath !== undefined) {
      return this.options.resourcesPath;
    }

    const resourcesPath = (process as ElectronProcess).resourcesPath;
    if (resourcesPath !== undefined) {
      return resourcesPath;
    }

    return path.join(this.options.resourceRoot ?? process.cwd(), 'resources');
  }

  private platform(): NodePlatform {
    return this.options.platform ?? process.platform;
  }

  private arch(): NodeJS.Architecture {
    return this.options.arch ?? process.arch;
  }
}
