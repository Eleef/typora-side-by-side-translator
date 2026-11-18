import { PluginSettingsData, TranslationRequestPayload, TranslationResponsePayload } from "../types";
import { UserFacingError, UserFacingErrorCode } from "../i18n/UserFacingError";
import { planYamlFrontmatterTranslation } from "../markdown/YamlFrontmatter";
import { normalizeAndValidateBaseUrl } from "../security/EndpointPolicy";
import { delay } from "../utils";
import { ExplicitTranslationAuthorization, ExplicitTranslationAuthorizer } from "./ExplicitTranslationAuthorizer";
import { MarkdownStructureProtector, ProtectedMarkdown } from "./MarkdownStructureProtector";
import { getTargetLanguageDefinition } from "./TargetLanguage";
import { throwIfTranslationCancelled } from "./TranslationTaskCoordinator";

export const MAX_TRANSLATION_RESPONSE_CHARS = 4_000_000;
export const MAX_TRANSLATION_RESPONSE_BYTES = 8_000_000;
const MAX_ATTEMPTS = 3;
const MAX_TEXT_FALLBACK_BLOCKS = 2;
const MAX_TEXT_FALLBACK_SEGMENTS = 24;
const MAX_TEXT_FALLBACK_CHARS = 1200;
const RESERVED_CONTROL_COMMENT = /<!--\s*typora-(?:side-by-side|bilingual):block-(?:start|end)\b/i;

class RetryableTranslationError extends UserFacingError {
  public constructor(
    code: UserFacingErrorCode,
    values: Record<string, string | number> = {},
    public readonly retryAfterMs?: number
  ) {
    super(code, values);
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

function buildSystemPrompt(settings: PluginSettingsData, mode: "markdown" | "text"): string {
  const language = getTargetLanguageDefinition(settings.targetLang);
  return [
    "你是 Markdown 文档翻译引擎。",
    `将可翻译内容翻译为 ${language.promptName}（${language.code}）。`,
    "自动识别源语言；如果内容已经是目标语言，保持原意和自然表达，不要添加说明。",
    ...(mode === "markdown" ? [
      "保持 Markdown 结构，不要输出任何解释。",
      "保留原文粗体标记和相邻正文之间的分隔空格，例如 **标签：** 正文。",
      "对于 format 为 yaml-values 的块，sourceMarkdown 是 JSON 对象。只翻译字符串值，保留所有键；translatedMarkdown 返回同样结构的 JSON 字符串，不要添加 YAML、代码围栏或解释。",
      "所有 TYPORASIDEBYSIDEPROTECTED...TOKEN 标记必须原样保留且各出现一次。",
      "保留链接 URL、代码、数学公式、HTML 原样。"
    ] : [
      "这些是从原文按顺序提取的纯文本片段。相邻片段可提供上下文，但必须独立返回并保持各自的含义。",
      "保留每个 ID，不要合并、拆分或省略片段。translatedMarkdown 字段只返回纯文本，不添加 Markdown 格式。"
    ]),
    "只返回 JSON，格式为 {\"blocks\":[{\"id\":\"...\",\"translatedMarkdown\":\"...\"}]}。"
  ].join("\n");
}

export class OpenAICompatibleProvider {
  private readonly structureProtector = new MarkdownStructureProtector();
  private readonly fallbackUsedByCommand = new WeakSet<ExplicitTranslationAuthorization>();

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
      throw new UserFacingError("translationSettingsIncomplete");
    }

    const protectedBlocks = blocks.map((block) => {
      if (block.format === "yaml-values") {
        const yaml = planYamlFrontmatterTranslation(block.sourceMarkdown);
        if (!yaml) {
          throw new UserFacingError("responseBlockInvalid", { detail: "invalid YAML translation input" });
        }
        return { request: { ...block, sourceMarkdown: JSON.stringify(yaml.values) }, yaml };
      }
      const protection = this.structureProtector.protect(block.sourceMarkdown);
      return {
        request: { ...block, sourceMarkdown: protection.markdown },
        protection
      };
    });
    const response = await this.requestBlocks(settings, protectedBlocks.map((item) => item.request), "markdown", signal);
    const receivedById = new Map(response.blocks.map((block) => [block.id, block.translatedMarkdown]));
    const results = new Map<string, string>();
    const pending: Array<{ id: string; plan: ReturnType<ProtectedMarkdown["planTextFallback"]>; segmentIds: string[] }> = [];
    const fallbackRequests: TranslationRequestPayload[] = [];
    let fallbackChars = 0;
    for (const { request, protection, yaml } of protectedBlocks) {
      const translated = receivedById.get(request.id)!;
      if (yaml) {
        let rendered: string | null = null;
        try {
          rendered = yaml.render(JSON.parse(translated));
        } catch {
          rendered = null;
        }
        if (rendered === null || RESERVED_CONTROL_COMMENT.test(rendered)) {
          throw new UserFacingError("responseBlockInvalid", { detail: "invalid YAML translation values" });
        }
        results.set(request.id, rendered);
        continue;
      }
      try {
        results.set(request.id, protection.restoreAndValidate(translated));
      } catch (error) {
        if (!(error instanceof UserFacingError) ||
          error.code !== "markdownProtectionFailed" || error.values.reason !== "structure") {
          throw error;
        }
        if (this.fallbackUsedByCommand.has(authorization!) || pending.length >= MAX_TEXT_FALLBACK_BLOCKS) {
          throw new UserFacingError("markdownFallbackLimit");
        }
        const plan = protection.planTextFallback();
        if (plan.segments.length === 0) {
          throw error;
        }
        fallbackChars = plan.segments.reduce((total, segment) => total + segment.length, fallbackChars);
        if (fallbackRequests.length + plan.segments.length > MAX_TEXT_FALLBACK_SEGMENTS ||
          fallbackChars > MAX_TEXT_FALLBACK_CHARS) {
          throw new UserFacingError("markdownFallbackLimit");
        }
        const segmentIds = plan.segments.map((sourceMarkdown, index) => {
          const id = `${request.id}:text:${index + 1}`;
          fallbackRequests.push({ id, sourceMarkdown });
          return id;
        });
        pending.push({ id: request.id, plan, segmentIds });
      }
    }
    let fallbackResults: TranslationResponsePayload["blocks"] = [];
    if (fallbackRequests.length > 0) {
      this.fallbackUsedByCommand.add(authorization!);
      fallbackResults = (await this.requestBlocks(settings, fallbackRequests, "text", signal)).blocks;
    }
    const fallbackById = new Map(fallbackResults.map((block) => [block.id, block.translatedMarkdown]));
    for (const { id, plan, segmentIds } of pending) {
      results.set(id, plan.render(segmentIds.map((segmentId) => fallbackById.get(segmentId)!)));
    }
    return { blocks: blocks.map(({ id }) => ({ id, translatedMarkdown: results.get(id)! })) };
  }

  private async requestBlocks(
    settings: PluginSettingsData,
    blocks: TranslationRequestPayload[],
    mode: "markdown" | "text",
    signal?: AbortSignal
  ): Promise<TranslationResponsePayload> {
    const baseUrl = normalizeAndValidateBaseUrl(settings.baseUrl);
    const url = `${baseUrl}/chat/completions`;
    let lastError: Error | null = null;

    const maxAttempts = mode === "text" ? 1 : MAX_ATTEMPTS;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
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
        controller.abort(new UserFacingError("requestTimeout"));
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
              { role: "system", content: buildSystemPrompt(settings, mode) },
              {
                role: "user",
                content: JSON.stringify({
                  targetLang: settings.targetLang,
                  blocks
                })
              }
            ]
          }),
          signal: controller.signal
        });

        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          const values = { status: response.status, statusText: response.statusText };
          if (this.isRetryableStatus(response.status)) {
            throw new RetryableTranslationError(
              "apiStatus",
              values,
              this.parseRetryAfter(response.headers.get("Retry-After"))
            );
          }
          throw new UserFacingError("apiStatus", values);
        }

        const responseText = await this.readResponseText(response, controller);
        let payload: { choices?: Array<{ message?: { content?: unknown } }> };
        try {
          payload = JSON.parse(responseText) as typeof payload;
        } catch {
          throw new UserFacingError("responseInvalid");
        }
        const content = payload?.choices?.[0]?.message?.content;
        if (typeof content !== "string") {
          throw new UserFacingError("responseInvalid");
        }
        if (content.length > MAX_TRANSLATION_RESPONSE_CHARS) {
          throw new UserFacingError("responseTooLarge");
        }

        let parsed: TranslationResponsePayload;
        try {
          parsed = JSON.parse(content) as TranslationResponsePayload;
        } catch {
          throw new UserFacingError("responseInvalid");
        }
        if (!Array.isArray(parsed.blocks)) {
          throw new UserFacingError("responseInvalid");
        }

        this.validateResponse(parsed, blocks);
        return parsed;
      } catch (error) {
        throwIfTranslationCancelled(signal);
        const normalizedError = error instanceof Error ? error : new Error(String(error));
        if (timedOut) {
          lastError = new RetryableTranslationError("requestTimeout");
        } else if (normalizedError instanceof RetryableTranslationError || normalizedError instanceof TypeError) {
          lastError =
            normalizedError instanceof RetryableTranslationError
              ? normalizedError
              : new RetryableTranslationError("requestFailed");
        } else {
          throw normalizedError;
        }
      } finally {
        this.runtime.clearTimeout(timer);
        signal?.removeEventListener("abort", abortFromCaller);
      }
    }

    throw lastError ?? new UserFacingError("requestFailed");
  }

  private validateResponse(response: TranslationResponsePayload, requests: TranslationRequestPayload[]): void {
    const expectedIds = new Set(requests.map((request) => request.id));
    const receivedIds = new Set<string>();

    for (const block of response.blocks) {
      if (!block || typeof block.id !== "string" || typeof block.translatedMarkdown !== "string") {
        throw new UserFacingError("responseBlockInvalid", { detail: "invalid block shape" });
      }
      if (!expectedIds.has(block.id)) {
        throw new UserFacingError("responseBlockInvalid", { detail: `unknown block ${block.id}` });
      }
      if (receivedIds.has(block.id)) {
        throw new UserFacingError("responseBlockInvalid", { detail: `duplicate block ${block.id}` });
      }
      if (RESERVED_CONTROL_COMMENT.test(block.translatedMarkdown)) {
        throw new UserFacingError("responseBlockInvalid", { detail: `reserved control in block ${block.id}` });
      }
      receivedIds.add(block.id);
    }

    const missingIds = [...expectedIds].filter((id) => !receivedIds.has(id));
    if (missingIds.length > 0) {
      throw new UserFacingError("responseBlockInvalid", { detail: `${missingIds.length} missing block(s)` });
    }
  }

  private async readResponseText(response: Response, controller: AbortController): Promise<string> {
    const contentLength = Number.parseInt(response.headers.get("Content-Length") ?? "", 10);
    if (Number.isFinite(contentLength) && contentLength > MAX_TRANSLATION_RESPONSE_BYTES) {
      controller.abort();
      throw new UserFacingError("responseTooLarge");
    }

    if (!response.body) {
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > MAX_TRANSLATION_RESPONSE_BYTES) {
        throw new UserFacingError("responseTooLarge");
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
          throw new UserFacingError("responseTooLarge");
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
