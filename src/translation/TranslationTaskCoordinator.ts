export class TranslationCancelledError extends Error {
  public constructor(message = "翻译任务已取消。") {
    super(message);
    this.name = "AbortError";
  }
}

export function throwIfTranslationCancelled(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error ? signal.reason : new TranslationCancelledError();
}

export function isTranslationCancelled(error: unknown): boolean {
  return error instanceof TranslationCancelledError || (error instanceof Error && error.name === "AbortError");
}

export class TranslationTaskCoordinator {
  private readonly activeTasks = new Map<string, { controller: AbortController; settled: Promise<void> }>();

  public isRunning(sourcePath: string): boolean {
    return this.activeTasks.has(sourcePath);
  }

  public async run<T>(sourcePath: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.activeTasks.has(sourcePath)) {
      throw new UserFacingError("taskAlreadyRunning");
    }

    const controller = new AbortController();
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => { settle = resolve; });
    const activeTask = { controller, settled };
    this.activeTasks.set(sourcePath, activeTask);
    try {
      return await task(controller.signal);
    } finally {
      if (this.activeTasks.get(sourcePath) === activeTask) {
        this.activeTasks.delete(sourcePath);
      }
      settle();
    }
  }

  public cancel(sourcePath: string, message = "翻译任务已由用户取消。"): boolean {
    const activeTask = this.activeTasks.get(sourcePath);
    if (!activeTask) {
      return false;
    }
    activeTask.controller.abort(new TranslationCancelledError(message));
    return true;
  }

  public cancelAll(message = "翻译任务已取消。"): void {
    for (const { controller } of this.activeTasks.values()) {
      controller.abort(new TranslationCancelledError(message));
    }
  }

  public async waitForIdle(sourcePath?: string): Promise<void> {
    if (sourcePath !== undefined) {
      await this.activeTasks.get(sourcePath)?.settled;
    } else {
      await Promise.all([...this.activeTasks.values()].map(({ settled }) => settled));
    }
  }
}
import { UserFacingError } from "../i18n/UserFacingError";
