import { FileAssociation } from "../types";

interface CacheFileAdapter {
  exists(targetPath: string): Promise<boolean>;
  stat(targetPath: string): Promise<{ isFile(): boolean }>;
  list(targetPath: string): Promise<string[]>;
  readText(targetPath: string): Promise<string>;
  remove(targetPath: string): Promise<void>;
  mkdir(targetPath: string): Promise<void>;
}

interface CachePathAdapter {
  dirname(targetPath: string): string;
  isAbsolute(targetPath: string): boolean;
  join(...parts: string[]): string;
}

export interface CacheUsage {
  fileCount: number;
  byteCount: number;
}

export class CacheMaintenanceService {
  public constructor(
    private readonly cacheRootDir: string,
    private readonly fileSystem: CacheFileAdapter,
    private readonly pathAdapter: CachePathAdapter
  ) {}

  public get rootPath(): string {
    return this.cacheRootDir;
  }

  public async getUsage(): Promise<CacheUsage> {
    return this.measurePath(this.cacheRootDir);
  }

  public async clearAssociation(association: FileAssociation): Promise<void> {
    for (const targetPath of [
      association.cacheTargetPath,
      association.cacheMapPath,
      association.legacyCacheTargetPath,
      association.legacyCacheMapPath
    ]) {
      if (targetPath && (await this.fileSystem.exists(targetPath))) {
        await this.fileSystem.remove(targetPath);
      }
    }
  }

  public async eraseAll(): Promise<void> {
    if (await this.fileSystem.exists(this.cacheRootDir)) {
      await this.fileSystem.remove(this.cacheRootDir);
    }
  }

  public async clearAll(): Promise<void> {
    if (await this.fileSystem.exists(this.cacheRootDir)) {
      await this.fileSystem.remove(this.cacheRootDir);
    }
    await this.fileSystem.mkdir(this.cacheRootDir);
  }

  private async measurePath(targetPath: string): Promise<CacheUsage> {
    if (!(await this.fileSystem.exists(targetPath))) {
      return { fileCount: 0, byteCount: 0 };
    }

    const stats = await this.fileSystem.stat(targetPath);
    if (stats.isFile()) {
      const content = await this.fileSystem.readText(targetPath);
      return { fileCount: 1, byteCount: new TextEncoder().encode(content).byteLength };
    }

    let fileCount = 0;
    let byteCount = 0;
    for (const child of await this.fileSystem.list(targetPath)) {
      const childPath = this.pathAdapter.isAbsolute(child) ? child : this.pathAdapter.join(targetPath, child);
      const usage = await this.measurePath(childPath);
      fileCount += usage.fileCount;
      byteCount += usage.byteCount;
    }
    return { fileCount, byteCount };
  }
}
