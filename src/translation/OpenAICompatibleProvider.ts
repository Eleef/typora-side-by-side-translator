import { PluginSettingsData, TranslationRequestPayload, TranslationResponsePayload } from "../types";
import { normalizeAndValidateBaseUrl } from "../security/EndpointPolicy";
import { delay } from "../utils";
import { ExplicitTranslationAuthorization, ExplicitTranslationAuthorizer } from "./ExplicitTranslationAuthorizer";
import { MarkdownStructureProtector, ProtectedMarkdown } from "./MarkdownStructureProtector";
import { throwIfTranslationCancelled } from "./TranslationTaskCoordinator";

export const MAX_TRANSLATION_RESPONSE_CHARS = 4_000_000;
export const MAX_TRANSLATION_RESPONSE_BYTES = 8_000_000;
const MAX_ATTEMPTS = 3;
const RESERVED_CONTROL_COMMENT = /<!--\s*typora-(?:side-by-side|bilingual):block-(?:start|end)\b/i;

class RetryableTranslationError extends Error {
  public constructor(message: string, public readonly retryAfterMs?: number) {
    super(message);
  }
}

export interface TranslationProviderRuntime {
  fetch: typeof globalThis.fetch;
  delay(milliseconds: number): Promise<void>;
  setTimeout(handler: () => void, timeoutMs: number): ReturnType<typeof globalThis.setTimeout>;
  clearTimeout(timer: ReturnType<typeof globalThis.setTimeout>): void;
  random(): number;
}

const DEFAULT_RUNTIME: TranslationProviderRuntime = {
  fetch: (input, init) => globalThis.fetch(input, init),
  delay,
  setTimeout: (handler, timeoutMs) => globalThis.setTimeout(handler, timeoutMs),
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
  random: Math.random
};

const SYSTEM_PROMPT = [
  "你是 Markdown 文档翻译引擎。",
  "目标语言固定为简体中文。",
  "保持 Markdown 结构，不要输出任何解释。",
  "所有 TYPORASIDEBYSIDEPROTECTED...TOKEN 标记必须原样保留且各出现一次。",
  "保留链接 URL、代码、数学公式、HTML 原样。",
  "只返回 JSON，格式为 {\"blocks\":[{\"id\":\"...\",\"translatedMarkdown\":\"...\"}]}。"
].join("\n");

export class OpenAICompatibleProvider {
  private readonly structureProtector = new MarkdownStructureProtector();

  public constructor(
    private readonly authorizer: ExplicitTranslationAuthorizer,
    private readonly runtime: TranslationProviderRuntime = DEFAULT_RUNTIME
  ) {}

  public async translateBlocks(
    settings: PluginSettingsData,
    blocks: TranslationRequestPayload[],
    authorization?: ExplicitTranslationAuthorization,
    signal?: AbortSignal
  ): Promise<TranslationResponsePayload> {
    this.authorizer.assertAuthorized(authorization);
    throwIfTranslationCancelled(signal);
    if (!settings.baseUrl || !settings.apiKey || !settings.model) {
      throw new Error("请先在插件设置中填写 baseUrl、apiKey 和 model。");
    }

    const protectedBlocks = blocks.map((block) => {
      const protection = this.structureProtector.protect(block.sourceMarkdown);
      return {
        request: { ...block, sourceMarkdown: protection.markdown },
        protection
      };
    });
    const baseUrl = normalizeAndValidateBaseUrl(settings.baseUrl);
    const url = `${baseUrl}/chat/completions`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      throwIfTranslationCancelled(signal);
      if (attempt > 0) {
        const retryAfterMs = lastError instanceof RetryableTranslationError ? lastError.retryAfterMs : undefined;
        await this.waitBeforeRetry(retryAfterMs ?? this.getBackoffMs(attempt - 1), signal);
      }

      const controller = new AbortController();
      let timedOut = false;
      const abortFromCaller = () => controller.abort(signal?.reason);
      if (signal) {
        signal.addEventListener("abort", abortFromCaller, { once: true });
        if (signal.aborted) {
          abortFromCaller();
        }
      }
      const timer = this.runtime.setTimeout(() => {
        timedOut = true;
        controller.abort(new Error("翻译请求超时。"));
      }, settings.timeoutMs);

      try {
        const response = await this.runtime.fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${settings.apiKey}`
          },
          body: JSON.stringify({
            model: settings.model,
            temperature: 0.2,
            messages: [
              { role: "system", content: SYSTEM_PROMPT },
              {
                role: "user",
                content: JSON.stringify({
                  targetLang: "zh-CN",
                  blocks: protectedBlocks.map((item) => item.request)
                })
              }
            ]
          }),
          signal: controller.signal
        });

        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          const message = `翻译接口返回 ${response.status} ${response.statusText}`;
          if (this.isRetryableStatus(response.status)) {
            throw new RetryableTranslationError(message, this.parseRetryAfter(response.headers.get("Retry-After")));
          }
          throw new Error(message);
        }

        const responseText = await this.readResponseText(response, controller);
        const payload = JSON.parse(responseText) as {
          choices?: Array<{ message?: { content?: unknown } }>;
        };
        const content = payload?.choices?.[0]?.message?.content;
        if (typeof content !== "string") {
          throw new Error("翻译接口未返回可解析文本。");
        }
        if (content.length > MAX_TRANSLATION_RESPONSE_CHARS) {
          throw new Error("翻译接口返回内容过大，已拒绝处理。");
        }

        const parsed = JSON.parse(content) as TranslationResponsePayload;
        if (!Array.isArray(parsed.blocks)) {
          throw new Error("翻译接口返回的 JSON 缺少 blocks 数组。");
        }

        this.validateResponse(parsed, blocks);
        const protectionsById = new Map(
          protectedBlocks.map((item) => [item.request.id, item.protection] as const)
        );
        return {
          blocks: parsed.blocks.map((block) => ({
            id: block.id,
            translatedMarkdown: this.restoreProtectedMarkdown(block, protectionsById.get(block.id))
          }))
        };
      } catch (error) {
        throwIfTranslationCancelled(signal);
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        if (timedOut) {
          lastError = new RetryableTranslationError("翻译请求超时。请检查网络或增大超时时间。");
        } else if (normalizedError instanceof RetryableTranslationError || normalizedError instanceof TypeError) {
          lastError =
            normalizedError instanceof RetryableTranslationError
              ? normalizedError
              : new RetryableTranslationError(normalizedError.message);
        } else {
          throw normalizedError;
        }
      } finally {
        this.runtime.clearTimeout(timer);
        signal?.removeEventListener("abort", abortFromCaller);
      }
    }

    throw lastError ?? new Error("翻译请求失败。");
  }

  private restoreProtectedMarkdown(
    block: TranslationResponsePayload["blocks"][number],
    protection: ProtectedMarkdown | undefined
  ): string {
    if (!protection) {
      throw new Error(`翻译接口返回了未知 block：${block.id}`);
    }
    return protection.restoreAndValidate(block.translatedMarkdown);
  }

  private validateResponse(response: TranslationResponsePayload, requests: TranslationRequestPayload[]): void {
    const expectedIds = new Set(requests.map((request) => request.id));
    const receivedIds = new Set<string>();

    for (const block of response.blocks) {
      if (!block || typeof block.id !== "string" || typeof block.translatedMarkdown !== "string") {
        throw new Error("翻译接口返回了无效的 block 数据。");
      }
      if (!expectedIds.has(block.id)) {
        throw new Error(`翻译接口返回了未知 block：${block.id}`);
      }
      if (receivedIds.has(block.id)) {
        throw new Error(`翻译接口重复返回 block：${block.id}`);
      }
      if (RESERVED_CONTROL_COMMENT.test(block.translatedMarkdown)) {
        throw new Error(`翻译接口返回的 block ${block.id} 包含插件保留控制注释。`);
      }
      receivedIds.add(block.id);
    }

    const missingIds = [...expectedIds].filter((id) => !receivedIds.has(id));
    if (missingIds.length > 0) {
      throw new Error(`翻译接口缺少 ${missingIds.length} 个 block。`);
    }
  }

  private async readResponseText(response: Response, controller: AbortController): Promise<string> {
    const contentLength = Number.parseInt(response.headers.get("Content-Length") ?? "", 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_TRANSLATION_RESPONSE_BYTES) {
      controller.abort();
      throw new Error("翻译接口响应体过大，已在下载前拒绝处理。");
    }

    if (!response.body) {
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > MAX_TRANSLATION_RESPONSE_BYTES) {
        throw new Error("翻译接口响应体过大，已拒绝处理。");
      }
      return text;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const chunks: string[] = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        totalBytes += value.byteLength;
        if (totalBytes > MAX_TRANSLATION_RESPONSE_BYTES) {
          controller.abort();
          await reader.cancel().catch(() => undefined);
          throw new Error("翻译接口响应体过大，已停止下载。");
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
      chunks.push(decoder.decode());
      return chunks.join("");
    } finally {
      reader.releaseLock();
    }
  }

  private isRetryableStatus(status: number): boolean {
    return status === 408 || status === 409 || status === 429 || (status >= 500 && status <= 599);
  }

  private parseRetryAfter(value: string | null): number | undefined {
    if (!value) {
      return undefined;
    }
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 30_000);
    }
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) {
      return undefined;
    }
    return Math.min(Math.max(0, timestamp - Date.now()), 30_000);
  }

  private getBackoffMs(retryIndex: number): number {
    const exponential = Math.min(1000 * 2 ** retryIndex, 8000);
    return exponential + Math.floor(this.runtime.random() * 250);
  }

  private async waitBeforeRetry(milliseconds: number, signal?: AbortSignal): Promise<void> {
    throwIfTranslationCancelled(signal);
    if (!signal) {
      await this.runtime.delay(milliseconds);
      return;
    }

    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.reason instanceof Error ? signal.reason : new Error("翻译任务已取消。"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      this.runtime.delay(milliseconds).then(
        () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
        (error) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
    throwIfTranslationCancelled(signal);
  }
}
