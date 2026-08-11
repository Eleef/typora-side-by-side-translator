import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { CacheMaintenanceService } from "../src/cache/CacheMaintenanceService";
import { TRANSLATION_BLOCK_ID_ALGORITHM } from "../src/markdown/BlockIdentity";
import { sanitizeDiagnosticMeta } from "../src/security/DiagnosticSanitizer";
import { normalizeAndValidateBaseUrl } from "../src/security/EndpointPolicy";
import { SessionCredentialStore } from "../src/security/SessionCredentialStore";
import { ExplicitTranslationAuthorizer } from "../src/translation/ExplicitTranslationAuthorizer";
import {
  MAX_TRANSLATION_RESPONSE_CHARS,
  MAX_TRANSLATION_RESPONSE_BYTES,
  OpenAICompatibleProvider,
  TranslationProviderRuntime
} from "../src/translation/OpenAICompatibleProvider";
import {
  hashTranslation,
  migrateStoredTranslationHash,
  storedTranslationMatches,
  TRANSLATION_HASH_ALGORITHM,
  TRANSLATION_MAP_SCHEMA_VERSION,
  usesTranslationDigests
} from "../src/translation/TranslationIntegrity";
import { TranslationMap } from "../src/types";
import { TranslationCancelledError } from "../src/translation/TranslationTaskCoordinator";
import {
  getTargetLanguageDefinition,
  normalizeTargetLanguage,
  TARGET_LANGUAGES
} from "../src/translation/TargetLanguage";

const TRANSLATION_SETTINGS = {
  baseUrl: "https://api.example.com/v1",
  apiKey: "session-secret",
  model: "test-model",
  timeoutMs: 1000,
  targetLang: "zh-CN" as const,
  credentialStorageMode: "session" as const,
  storedApiKey: "",
  paneWidthPercent: 50,
  toolbarDisplayMode: "compact" as const
};

const TRANSLATION_BLOCKS = [{ id: "block-1", sourceMarkdown: "Hello" }];

function createRuntime(
  fetchImplementation: TranslationProviderRuntime["fetch"],
  timeoutHandler?: (handler: () => void) => void
): TranslationProviderRuntime {
  return {
    fetch: fetchImplementation,
    async delay() {},
    setTimeout(handler) {
      timeoutHandler?.(handler);
      return 0 as unknown as ReturnType<typeof globalThis.setTimeout>;
    },
    clearTimeout() {},
    random() {
      return 0;
    }
  };
}

function createApiResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content } }]
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }
  );
}

function createMap(overrides: Partial<TranslationMap> = {}): TranslationMap {
  return {
    schemaVersion: TRANSLATION_MAP_SCHEMA_VERSION,
    translatedHashAlgorithm: TRANSLATION_HASH_ALGORITHM,
    blockIdAlgorithm: TRANSLATION_BLOCK_ID_ALGORITHM,
    sourcePath: "source.md",
    targetPath: "target.md",
    targetLang: "zh-CN",
    provider: "openai-compatible",
    model: "test",
    updatedAt: "2026-08-01T00:00:00.000Z",
    blocks: [],
    ...overrides
  };
}

test("remote endpoints require HTTPS while loopback HTTP remains available", () => {
  assert.equal(normalizeAndValidateBaseUrl("https://api.example.com/v1/"), "https://api.example.com/v1");
  assert.equal(normalizeAndValidateBaseUrl("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1");
  assert.equal(normalizeAndValidateBaseUrl("http://localhost:1234/v1"), "http://localhost:1234/v1");
  assert.throws(() => normalizeAndValidateBaseUrl("http://api.example.com/v1"), /HTTPS/);
  assert.throws(() => normalizeAndValidateBaseUrl("https://user:pass@example.com/v1"), /用户名或密码/);
  assert.throws(() => normalizeAndValidateBaseUrl("https://api.example.com/v1?key=secret"), /查询参数/);
});

test("diagnostics redact credentials, local paths and URL details", () => {
  const sanitized = sanitizeDiagnosticMeta({
    apiKey: "sk-secret-value",
    storedApiKey: "plain-saved-value",
    authorization: "Bearer private-token",
    sourcePath: "C:\\Users\\alice\\private\\article.md",
    baseUrl: "https://api.example.com/v1?token=private",
    stack: "Error at C:\\Users\\alice\\private\\main.ts with sk-another-secret and https://api.example.com/v1/private"
  }) as Record<string, unknown>;

  assert.equal(sanitized.apiKey, "<redacted>");
  assert.equal(sanitized.storedApiKey, "<redacted>");
  assert.equal(sanitized.authorization, "<redacted>");
  assert.equal(sanitized.sourcePath, "<local-path>");
  assert.equal(sanitized.baseUrl, "https://api.example.com");
  assert.doesNotMatch(String(sanitized.stack), /alice|sk-another-secret/);
  assert.doesNotMatch(String(sanitized.stack), /\/v1\/private/);
});

test("session credentials are scoped to one endpoint origin", () => {
  const credentials = new SessionCredentialStore();
  credentials.set("https://api.example.com/v1", "secret-key");

  assert.equal(credentials.get("https://api.example.com/compatible/v1"), "secret-key");
  assert.equal(credentials.get("https://another.example.com/v1"), "");
  credentials.clearIfEndpointChanged("https://another.example.com/v1");
  assert.equal(credentials.get("https://api.example.com/v1"), "");
  assert.throws(() => credentials.set("", "secret-key"), /先配置 baseUrl/);
});

test("target languages use a fixed allowlist and stable export suffixes", () => {
  assert.deepEqual(
    TARGET_LANGUAGES.map((language) => language.code),
    ["zh-CN", "zh-TW", "en", "ja", "ko"]
  );
  assert.equal(getTargetLanguageDefinition("zh-CN").fileSuffix, "zh");
  assert.equal(getTargetLanguageDefinition("zh-TW").fileSuffix, "zh-TW");
  assert.equal(getTargetLanguageDefinition("ja").promptName, "Japanese");
  assert.equal(normalizeTargetLanguage("unsupported"), "zh-CN");
});

test("translation network authorization cannot be replaced by a plain object", () => {
  const authorizer = new ExplicitTranslationAuthorizer();
  const authorization = authorizer.authorize("translate-current-file");

  assert.doesNotThrow(() => authorizer.assertAuthorized(authorization));
  assert.throws(
    () => authorizer.assertAuthorized({ reason: "translate-current-file" } as typeof authorization),
    /缺少显式用户授权/
  );
  assert.throws(() => authorizer.assertAuthorized(undefined), /缺少显式用户授权/);
});

test("translation provider rejects implicit requests before fetch", async () => {
  const authorizer = new ExplicitTranslationAuthorizer();
  const provider = new OpenAICompatibleProvider(authorizer);
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("fetch should not run");
  }) as typeof fetch;

  try {
    await assert.rejects(
      provider.translateBlocks(
        {
          baseUrl: "https://api.example.com/v1",
          apiKey: "session-secret",
          model: "test-model",
          timeoutMs: 1000,
          targetLang: "zh-CN",
          credentialStorageMode: "session",
          storedApiKey: "",
          paneWidthPercent: 50,
          toolbarDisplayMode: "compact"
        },
        [{ id: "block-1", sourceMarkdown: "Hello" }]
      ),
      /缺少显式用户授权/
    );
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("translation provider rejects missing credentials before fetch", async () => {
  const authorizer = new ExplicitTranslationAuthorizer();
  let fetchCalls = 0;
  const provider = new OpenAICompatibleProvider(
    authorizer,
    createRuntime(async () => {
      fetchCalls += 1;
      return createApiResponse('{"blocks":[]}');
    })
  );

  await assert.rejects(
    provider.translateBlocks(
      { ...TRANSLATION_SETTINGS, apiKey: "" },
      TRANSLATION_BLOCKS,
      authorizer.authorize("translate-current-file")
    ),
    /填写 baseUrl、apiKey 和 model/
  );
  assert.equal(fetchCalls, 0);
});

test("translation provider sends the selected target language in the prompt and payload", async () => {
  const authorizer = new ExplicitTranslationAuthorizer();
  let requestBody = "";
  const provider = new OpenAICompatibleProvider(
    authorizer,
    createRuntime(async (_input, init) => {
      requestBody = String(init?.body ?? "");
      return createApiResponse('{"blocks":[{"id":"block-1","translatedMarkdown":"こんにちは"}]}');
    })
  );

  await provider.translateBlocks(
    { ...TRANSLATION_SETTINGS, targetLang: "ja" },
    TRANSLATION_BLOCKS,
    authorizer.authorize("translate-current-file")
  );

  const payload = JSON.parse(requestBody) as { messages: Array<{ role: string; content: string }> };
  const systemPrompt = payload.messages.find((message) => message.role === "system")?.content ?? "";
  const userPayload = JSON.parse(payload.messages.find((message) => message.role === "user")?.content ?? "{}") as {
    targetLang?: string;
  };
  assert.match(systemPrompt, /Japanese.*ja/);
  assert.equal(userPayload.targetLang, "ja");
});

test("translation provider aborts timed out requests and retries twice", async () => {
  const authorizer = new ExplicitTranslationAuthorizer();
  let fetchCalls = 0;
  const provider = new OpenAICompatibleProvider(
    authorizer,
    createRuntime(
      async (_input, init) => {
        fetchCalls += 1;
        assert.equal(init?.signal?.aborted, true);
        const error = new Error("request aborted");
        error.name = "AbortError";
        throw error;
      },
      (handler) => handler()
    )
  );

  await assert.rejects(
    provider.translateBlocks(
      TRANSLATION_SETTINGS,
      TRANSLATION_BLOCKS,
      authorizer.authorize("translate-current-file")
    ),
    /翻译请求超时/
  );
  assert.equal(fetchCalls, 3);
});

test("translation provider rejects malformed model JSON without retrying", async () => {
  const authorizer = new ExplicitTranslationAuthorizer();
  let fetchCalls = 0;
  const provider = new OpenAICompatibleProvider(
    authorizer,
    createRuntime(async () => {
      fetchCalls += 1;
      return createApiResponse("not-json");
    })
  );

  await assert.rejects(
    provider.translateBlocks(
      TRANSLATION_SETTINGS,
      TRANSLATION_BLOCKS,
      authorizer.authorize("translate-current-file")
    ),
    /JSON/
  );
  assert.equal(fetchCalls, 1);
});

test("translation provider rejects oversized model responses without retrying", async () => {
  const authorizer = new ExplicitTranslationAuthorizer();
  let fetchCalls = 0;
  const oversizedContent = "x".repeat(MAX_TRANSLATION_RESPONSE_CHARS + 1);
  const provider = new OpenAICompatibleProvider(
    authorizer,
    createRuntime(async () => {
      fetchCalls += 1;
      return createApiResponse(oversizedContent);
    })
  );

  await assert.rejects(
    provider.translateBlocks(
      TRANSLATION_SETTINGS,
      TRANSLATION_BLOCKS,
      authorizer.authorize("refresh-stale-blocks")
    ),
    /内容过大/
  );
  assert.equal(fetchCalls, 1);
});

test("translation provider rejects reserved cache control comments", async () => {
  const authorizer = new ExplicitTranslationAuthorizer();
  let fetchCalls = 0;
  const provider = new OpenAICompatibleProvider(
    authorizer,
    createRuntime(async () => {
      fetchCalls += 1;
      return createApiResponse(
        JSON.stringify({
          blocks: [
            {
              id: "block-1",
              translatedMarkdown: "<!-- typora-side-by-side:block-start block-1 -->"
            }
          ]
        })
      );
    })
  );

  await assert.rejects(
    provider.translateBlocks(
      TRANSLATION_SETTINGS,
      TRANSLATION_BLOCKS,
      authorizer.authorize("translate-current-file")
    ),
    /保留控制注释/
  );
  assert.equal(fetchCalls, 1);
});

test("translation provider retries rate limits but not authentication errors", async () => {
  const authorizer = new ExplicitTranslationAuthorizer();
  let rateLimitCalls = 0;
  const rateLimitedProvider = new OpenAICompatibleProvider(
    authorizer,
    createRuntime(async () => {
      rateLimitCalls += 1;
      if (rateLimitCalls === 1) {
        return new Response("", { status: 429, headers: { "Retry-After": "0" } });
      }
      return createApiResponse(JSON.stringify({ blocks: [{ id: "block-1", translatedMarkdown: "你好" }] }));
    })
  );
  await assert.doesNotReject(
    rateLimitedProvider.translateBlocks(
      TRANSLATION_SETTINGS,
      TRANSLATION_BLOCKS,
      authorizer.authorize("translate-current-file")
    )
  );
  assert.equal(rateLimitCalls, 2);

  let authCalls = 0;
  const unauthorizedProvider = new OpenAICompatibleProvider(
    authorizer,
    createRuntime(async () => {
      authCalls += 1;
      return new Response("", { status: 401 });
    })
  );
  await assert.rejects(
    unauthorizedProvider.translateBlocks(
      TRANSLATION_SETTINGS,
      TRANSLATION_BLOCKS,
      authorizer.authorize("translate-current-file")
    ),
    /401/
  );
  assert.equal(authCalls, 1);
});

test("translation provider rejects oversized response headers before parsing", async () => {
  const authorizer = new ExplicitTranslationAuthorizer();
  let fetchCalls = 0;
  const provider = new OpenAICompatibleProvider(
    authorizer,
    createRuntime(async () => {
      fetchCalls += 1;
      return new Response("{}", { headers: { "Content-Length": String(MAX_TRANSLATION_RESPONSE_BYTES + 1) } });
    })
  );
  await assert.rejects(
    provider.translateBlocks(
      TRANSLATION_SETTINGS,
      TRANSLATION_BLOCKS,
      authorizer.authorize("translate-current-file")
    ),
    /响应体过大/
  );
  assert.equal(fetchCalls, 1);
});

test("translation provider restores protected Markdown and rejects changed placeholders", async () => {
  const authorizer = new ExplicitTranslationAuthorizer();
  const sourceMarkdown = "Read [docs](https://example.com/a?q=1), `npm test`, and $x + 1$.";
  let corruptPlaceholders = false;
  const provider = new OpenAICompatibleProvider(
    authorizer,
    createRuntime(async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        messages: Array<{ role: string; content: string }>;
      };
      const userMessage = body.messages.find((message) => message.role === "user");
      const request = JSON.parse(userMessage?.content ?? "{}") as {
        blocks: Array<{ id: string; sourceMarkdown: string }>;
      };
      let translatedMarkdown = request.blocks[0].sourceMarkdown.replace("Read", "阅读").replace("and", "以及");
      if (corruptPlaceholders) {
        translatedMarkdown = translatedMarkdown.replace(/TYPORASIDEBYSIDEPROTECTED\d+TOKEN/, "changed");
      }
      return createApiResponse(JSON.stringify({ blocks: [{ id: "block-1", translatedMarkdown }] }));
    })
  );
  const authorization = authorizer.authorize("translate-current-file");
  const result = await provider.translateBlocks(
    TRANSLATION_SETTINGS,
    [{ id: "block-1", sourceMarkdown }],
    authorization
  );
  assert.match(result.blocks[0].translatedMarkdown, /https:\/\/example\.com\/a\?q=1/);
  assert.match(result.blocks[0].translatedMarkdown, /`npm test`/);
  assert.match(result.blocks[0].translatedMarkdown, /\$x \+ 1\$/);

  corruptPlaceholders = true;
  await assert.rejects(
    provider.translateBlocks(
      TRANSLATION_SETTINGS,
      [{ id: "block-1", sourceMarkdown }],
      authorizer.authorize("translate-current-file")
    ),
    /保护标记|受保护/
  );
});

test("translation provider propagates user cancellation without retrying", async () => {
  const authorizer = new ExplicitTranslationAuthorizer();
  let fetchCalls = 0;
  const provider = new OpenAICompatibleProvider(
    authorizer,
    createRuntime(
      async (_input, init) => {
        fetchCalls += 1;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
    )
  );
  const controller = new AbortController();
  const request = provider.translateBlocks(
    TRANSLATION_SETTINGS,
    TRANSLATION_BLOCKS,
    authorizer.authorize("translate-current-file"),
    controller.signal
  );
  controller.abort(new TranslationCancelledError("cancelled by test"));
  await assert.rejects(request, /cancelled by test/);
  assert.equal(fetchCalls, 1);
});

test("new maps store translation digests and detect manual edits", async () => {
  const map = createMap();
  const generated = "译文内容";
  const digest = await hashTranslation(generated);

  assert.equal(map.blockIdAlgorithm, TRANSLATION_BLOCK_ID_ALGORITHM);
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(await storedTranslationMatches(map, digest, generated), true);
  assert.equal(await storedTranslationMatches(map, digest, "人工修改后的译文"), false);
});

test("legacy maps compare plaintext once and migrate it to a digest", async () => {
  const legacyMap = createMap({ schemaVersion: undefined, translatedHashAlgorithm: undefined });
  const storedTranslation = "旧版系统译文";

  assert.equal(await storedTranslationMatches(legacyMap, storedTranslation, storedTranslation), true);
  assert.equal(await storedTranslationMatches(legacyMap, storedTranslation, "人工修改"), false);
  assert.equal(await migrateStoredTranslationHash(legacyMap, storedTranslation), await hashTranslation(storedTranslation));
});

test("schema 2 digest maps do not hash existing digests again", async () => {
  const schemaTwoMap = createMap({ schemaVersion: 2, blockIdAlgorithm: undefined });
  const digest = await hashTranslation("existing translation");

  assert.equal(usesTranslationDigests(schemaTwoMap), true);
  assert.equal(await migrateStoredTranslationHash(schemaTwoMap, digest), digest);
});

test("cache maintenance measures text files and removes only the selected cache directory", async () => {
  const removed: string[] = [];
  const directories = new Map<string, string[]>([
    ["/cache", ["doc", "root.map.json"]],
    ["/cache/doc", ["article.zh.md"]]
  ]);
  const files = new Map<string, string>([
    ["/cache/root.map.json", "{}"],
    ["/cache/doc/article.zh.md", "译文"]
  ]);
  const fileSystem = {
    async exists(targetPath: string) {
      return directories.has(targetPath) || files.has(targetPath);
    },
    async stat(targetPath: string) {
      return { isFile: () => files.has(targetPath) };
    },
    async list(targetPath: string) {
      return directories.get(targetPath) ?? [];
    },
    async readText(targetPath: string) {
      return files.get(targetPath) ?? "";
    },
    async remove(targetPath: string) {
      removed.push(targetPath);
    },
    async mkdir() {
      return;
    }
  };
  const service = new CacheMaintenanceService("/cache", fileSystem, path.posix);
  const usage = await service.getUsage();

  assert.deepEqual(usage, { fileCount: 2, byteCount: 8 });
  await service.clearAssociation({
    sourcePath: "/source/article.md",
    cacheTargetPath: "/cache/doc/article.zh.md",
    cacheMapPath: "/cache/doc/article.zh.map.json",
    exportTargetPath: "/source/article.zh.md",
    targetLang: "zh-CN",
    isSupportedSource: true
  });
  assert.deepEqual(removed, ["/cache/doc"]);
});

test("committed map fixtures contain digests and portable paths only", () => {
  for (const fixturePath of ["fixtures/fixture-basic.zh.map.json", "fixtures/fixture-manual-edit.zh.map.json"]) {
    const map = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as TranslationMap;
    assert.ok(map.schemaVersion === 2 || map.schemaVersion === TRANSLATION_MAP_SCHEMA_VERSION);
    assert.equal(map.translatedHashAlgorithm, TRANSLATION_HASH_ALGORITHM);
    if (map.schemaVersion === TRANSLATION_MAP_SCHEMA_VERSION) {
      assert.equal(map.blockIdAlgorithm, TRANSLATION_BLOCK_ID_ALGORITHM);
    }
    assert.equal(path.isAbsolute(map.sourcePath), false);
    assert.equal(path.isAbsolute(map.targetPath), false);
    for (const block of map.blocks) {
      assert.match(block.translatedHash, /^[a-f0-9]{64}$/);
    }
  }
});
