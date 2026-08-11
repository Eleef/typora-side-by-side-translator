import { fs, path as corePath, type App } from "@typora-community-plugin/core";
import { sanitizeDiagnosticMeta } from "../security/DiagnosticSanitizer";

const MAX_LOG_BYTES = 256 * 1024;

type DiagnosticLevel = "debug" | "info" | "warn" | "error";

interface DiagnosticEntry {
  at: string;
  level: DiagnosticLevel;
  message: string;
  meta?: unknown;
}

declare global {
  interface Window {
    __typoraSideBySideDiagnostics?: {
      moduleEvaluatedAt?: string;
      logPath?: string;
      entries: DiagnosticEntry[];
    };
  }
}

function ensureWindowBuffer(): NonNullable<Window["__typoraSideBySideDiagnostics"]> {
  if (!window.__typoraSideBySideDiagnostics) {
    window.__typoraSideBySideDiagnostics = { entries: [] };
  }
  return window.__typoraSideBySideDiagnostics;
}

function serializeMeta(meta: unknown): string {
  if (meta === undefined) {
    return "";
  }
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return ` ${String(meta)}`;
  }
}

export class PluginDiagnostics {
  private logPath: string | null = null;
  private attached = false;
  private currentLogBytes = 0;
  private writeQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly app: App) {}

  public static markModuleEvaluated(): void {
    const buffer = ensureWindowBuffer();
    const at = new Date().toISOString();
    buffer.moduleEvaluatedAt = at;
    console.info("[typora-side-by-side] module evaluated", { at });
  }

  public async attach(pluginDataPath: string): Promise<void> {
    if (this.attached) {
      return;
    }

    this.attached = true;
    this.logPath = this.resolveLogPath(pluginDataPath);
    await this.migrateLegacyLog();
    if (!this.attached) {
      return;
    }
    const buffer = ensureWindowBuffer();
    buffer.logPath = this.logPath ?? undefined;
    await this.initializeLogSize();
    if (!this.attached) {
      return;
    }

    await this.info("diagnostics attached", {
      logPath: this.logPath,
      pluginGlobalDir: this.app.env?.PLUGIN_GLOBAL_DIR,
      coreVersion: this.app.coreVersion,
      platform: this.app.platform
    });
  }

  public detach(): void {
    if (!this.attached) {
      return;
    }
    this.attached = false;
  }

  public async debug(message: string, meta?: unknown): Promise<void> {
    await this.write("debug", message, meta);
  }

  public async info(message: string, meta?: unknown): Promise<void> {
    await this.write("info", message, meta);
  }

  public async warn(message: string, meta?: unknown): Promise<void> {
    await this.write("warn", message, meta);
  }

  public async error(message: string, meta?: unknown): Promise<void> {
    await this.write("error", message, meta);
  }

  public getLogPath(): string | null {
    return this.logPath;
  }

  public async clear(): Promise<void> {
    await this.writeQueue;
    const buffer = ensureWindowBuffer();
    buffer.entries = [];
    this.currentLogBytes = 0;
    if (!this.logPath) {
      return;
    }

    for (const candidate of [this.logPath, this.getBackupLogPath()]) {
      if (await fs.exists(candidate)) {
        await fs.remove(candidate);
      }
    }
  }

  private resolveLogPath(pluginDataPath: string): string | null {
    const baseDir =
      this.app.env?.PLUGIN_GLOBAL_DIR ||
      (pluginDataPath ? corePath.dirname(pluginDataPath) : "");
    if (!baseDir) {
      return null;
    }
    return corePath.join(baseDir, "logs", "typora-side-by-side-translator.log");
  }

  private async write(level: DiagnosticLevel, message: string, meta?: unknown): Promise<void> {
    const task = this.writeQueue.then(() => this.writeNow(level, message, meta));
    this.writeQueue = task.catch(() => undefined);
    return task;
  }

  private async writeNow(level: DiagnosticLevel, message: string, meta?: unknown): Promise<void> {
    const sanitizedMeta = sanitizeDiagnosticMeta(meta);
    const entry: DiagnosticEntry = {
      at: new Date().toISOString(),
      level,
      message: String(sanitizeDiagnosticMeta(message)),
      meta: sanitizedMeta
    };

    const buffer = ensureWindowBuffer();
    buffer.entries.push(entry);
    if (buffer.entries.length > 200) {
      buffer.entries.splice(0, buffer.entries.length - 200);
    }

    const payload = `[${entry.at}] [${level.toUpperCase()}] ${entry.message}${serializeMeta(sanitizedMeta)}`;
    switch (level) {
      case "debug":
        console.debug("[typora-side-by-side]", entry.message, sanitizedMeta);
        break;
      case "info":
        console.info("[typora-side-by-side]", entry.message, sanitizedMeta);
        break;
      case "warn":
        console.warn("[typora-side-by-side]", entry.message, sanitizedMeta);
        break;
      case "error":
        console.error("[typora-side-by-side]", entry.message, sanitizedMeta);
        break;
    }

    if (!this.logPath) {
      return;
    }

    try {
      await fs.mkdir(corePath.dirname(this.logPath));
    } catch {
      // Directory may already exist.
    }

    try {
      const payloadBytes = new TextEncoder().encode(`${payload}\n`).byteLength;
      await this.rotateIfNeeded(payloadBytes);
      await fs.appendText(this.logPath, `${payload}\n`);
      this.currentLogBytes += payloadBytes;
    } catch (error) {
      console.error("[typora-side-by-side] failed to write diagnostic log", error);
    }
  }

  private async initializeLogSize(): Promise<void> {
    if (!this.logPath || !(await fs.exists(this.logPath))) {
      this.currentLogBytes = 0;
      return;
    }

    try {
      const content = await fs.readText(this.logPath);
      const sanitizedContent = String(sanitizeDiagnosticMeta(content));
      if (sanitizedContent !== content) {
        await fs.writeText(this.logPath, sanitizedContent);
      }
      this.currentLogBytes = new TextEncoder().encode(sanitizedContent).byteLength;
    } catch {
      this.currentLogBytes = 0;
    }
  }

  private async migrateLegacyLog(): Promise<void> {
    if (!this.logPath) {
      return;
    }
    const logDirectory = corePath.dirname(this.logPath);
    if (!(await fs.exists(this.logPath))) {
      const legacyPaths = ["typora-side-by-side-translation.log", "typora-bilingual.log"].map((filename) =>
        corePath.join(logDirectory, filename)
      );
      for (const legacyPath of legacyPaths) {
        if (!(await fs.exists(legacyPath))) {
          continue;
        }
        await fs.mkdir(logDirectory);
        await fs.move(legacyPath, this.logPath);
        break;
      }
    }

    const backupPath = this.getBackupLogPath();
    if (await fs.exists(backupPath)) {
      return;
    }
    const legacyBackups = ["typora-side-by-side-translation.1.log", "typora-bilingual.1.log"].map((filename) =>
      corePath.join(logDirectory, filename)
    );
    for (const legacyBackup of legacyBackups) {
      if (!(await fs.exists(legacyBackup))) {
        continue;
      }
      await fs.mkdir(logDirectory);
      await fs.move(legacyBackup, backupPath);
      break;
    }
  }

  private async rotateIfNeeded(incomingBytes: number): Promise<void> {
    if (!this.logPath || this.currentLogBytes + incomingBytes <= MAX_LOG_BYTES) {
      return;
    }

    const backupPath = this.getBackupLogPath();
    if (await fs.exists(backupPath)) {
      await fs.remove(backupPath);
    }
    if (await fs.exists(this.logPath)) {
      await fs.move(this.logPath, backupPath);
    }
    this.currentLogBytes = 0;
  }

  private getBackupLogPath(): string {
    if (!this.logPath) {
      return "";
    }
    return this.logPath.replace(/\.log$/i, ".1.log");
  }
}
