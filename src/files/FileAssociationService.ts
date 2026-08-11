import { path } from "@typora-community-plugin/core";
import { FileAssociation, TargetLanguage } from "../types";
import { getTargetLanguageDefinition } from "../translation/TargetLanguage";
import { createLegacyCacheKey, createStableCacheKey } from "./CacheKey";

export class FileAssociationService {
  public constructor(private readonly cacheRootDir: string) {}

  public resolve(sourcePath: string | null | undefined, targetLang: TargetLanguage): FileAssociation {
    if (!sourcePath) {
      return {
        sourcePath: "",
        cacheTargetPath: "",
        cacheMapPath: "",
        exportTargetPath: "",
        targetLang,
        isSupportedSource: false,
        reason: "no-saved-markdown"
      };
    }

    const normalized = sourcePath.replace(/\//g, path.sep);
    const extension = path.extname(normalized).toLowerCase();
    if (extension !== ".md") {
      return {
        sourcePath: normalized,
        cacheTargetPath: "",
        cacheMapPath: "",
        exportTargetPath: "",
        targetLang,
        isSupportedSource: false,
        reason: "markdown-only"
      };
    }

    const basename = path.basename(normalized, ".md");
    const suffix = getTargetLanguageDefinition(targetLang).fileSuffix;
    const readableKey = createStableCacheKey(normalized, basename);
    const cacheDirectory = path.join(this.cacheRootDir, readableKey);
    const legacyCacheDirectory = path.join(this.cacheRootDir, createLegacyCacheKey(normalized));
    return {
      sourcePath: normalized,
      cacheTargetPath: path.join(cacheDirectory, `${basename}.${suffix}.md`),
      cacheMapPath: path.join(cacheDirectory, `${basename}.${suffix}.map.json`),
      exportTargetPath: path.join(path.dirname(normalized), `${basename}.${suffix}.md`),
      legacyCacheTargetPath: path.join(legacyCacheDirectory, `${basename}.${suffix}.md`),
      legacyCacheMapPath: path.join(legacyCacheDirectory, `${basename}.${suffix}.map.json`),
      targetLang,
      isSupportedSource: true
    };
  }
}
