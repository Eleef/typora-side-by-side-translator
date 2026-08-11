export type TranslationBlockType =
  | "heading"
  | "paragraph"
  | "list"
  | "blockquote"
  | "table"
  | "html"
  | "code"
  | "math"
  | "passthrough";

export type TargetLanguage = "zh-CN" | "zh-TW" | "en" | "ja" | "ko";
export type CredentialStorageMode = "session" | "plugin-settings";

export interface TranslationBlock {
  id: string;
  type: TranslationBlockType;
  sourceMarkdown: string;
  headingPath: string[];
  order: number;
  translatable: boolean;
  sourceHash: string;
  anchorSlug?: string;
}

export interface TranslationMapBlock {
  id: string;
  type?: TranslationBlockType;
  order: number;
  headingPath: string[];
  sourceHash: string;
  translatedHash: string;
  stale: boolean;
  manuallyEdited: boolean;
}

export interface TranslationMap {
  schemaVersion?: 2 | 3 | 4;
  translatedHashAlgorithm?: "sha256";
  blockIdAlgorithm?: "position-v1";
  cacheGeneration?: string;
  sourcePath: string;
  targetPath: string;
  targetLang: TargetLanguage;
  provider: "openai-compatible";
  model: string;
  updatedAt: string;
  blocks: TranslationMapBlock[];
}

export interface PluginSettingsData {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  targetLang: TargetLanguage;
  credentialStorageMode: CredentialStorageMode;
  storedApiKey: string;
  paneWidthPercent: number;
  toolbarDisplayMode: "compact" | "collapsed";
}

export interface FileAssociation {
  sourcePath: string;
  cacheTargetPath: string;
  cacheMapPath: string;
  exportTargetPath: string;
  targetLang: TargetLanguage;
  isSupportedSource: boolean;
  reason?: string;
}

export interface TranslationResult {
  markdown: string;
  map: TranslationMap;
  blocks: TranslationBlock[];
  translatedBlocks: Map<string, string>;
}

export interface TranslationRequestPayload {
  id: string;
  sourceMarkdown: string;
}

export interface TranslationResponsePayload {
  blocks: Array<{
    id: string;
    translatedMarkdown: string;
  }>;
}

export interface PaneRenderState {
  association: FileAssociation | null;
  targetMarkdown: string | null;
  translatedBlocks: Map<string, string>;
  blocks: TranslationBlock[];
  isVisible: boolean;
  staleCount: number;
  targetLang: TargetLanguage;
  paneWidthPercent: number;
  toolbarDisplayMode: "compact" | "collapsed";
  isTranslating: boolean;
  errorMessage?: string;
  warningMessage?: string;
  infoMessage?: string;
}
