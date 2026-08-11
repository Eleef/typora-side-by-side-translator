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
  private readonly activeTasks = new Map<string, AbortController>();

  public isRunning(sourcePath: string): boolean {
    return this.activeTasks.has(sourcePath);
  }

  public async run<T>(sourcePath: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.activeTasks.has(sourcePath)) {
      throw new UserFacingError("taskAlreadyRunning");
    }

    const controller = new AbortController();
    this.activeTasks.set(sourcePath, controller);
    try {
      return await task(controller.signal);
    } finally {
      if (this.activeTasks.get(sourcePath) === controller) {
        this.activeTasks.delete(sourcePath);
      }
    }
  }

  public cancel(sourcePath: string, message = "翻译任务已由用户取消。"): boolean {
    const controller = this.activeTasks.get(sourcePath);
    if (!controller) {
      return false;
    }
    controller.abort(new TranslationCancelledError(message));
    return true;
  }

  public cancelAll(message = "翻译任务已取消。"): void {
    for (const controller of this.activeTasks.values()) {
      controller.abort(new TranslationCancelledError(message));
    }
  }
}
import { UserFacingError } from "../i18n/UserFacingError";
