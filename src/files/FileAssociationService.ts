import { path } from "@typora-community-plugin/core";
import { FileAssociation, TargetLanguage } from "../types";
import { getTargetLanguageDefinition } from "../translation/TargetLanguage";

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
        reason: "当前没有已保存的本地 Markdown 文件。"
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
        reason: "仅支持已保存的本地 .md 文件。"
      };
    }

    const basename = path.basename(normalized, ".md");
    const suffix = getTargetLanguageDefinition(targetLang).fileSuffix;
    const readableKey = this.createReadableKey(normalized);
    const cacheDirectory = path.join(this.cacheRootDir, readableKey);
    return {
      sourcePath: normalized,
      cacheTargetPath: path.join(cacheDirectory, `${basename}.${suffix}.md`),
      cacheMapPath: path.join(cacheDirectory, `${basename}.${suffix}.map.json`),
      exportTargetPath: path.join(path.dirname(normalized), `${basename}.${suffix}.md`),
      targetLang,
      isSupportedSource: true
    };
  }

  private createReadableKey(sourcePath: string): string {
    const sanitized = sourcePath
      .replace(/[:]/g, "")
      .replace(/[\\\/]+/g, "__")
      .replace(/[^\w\-.]+/g, "_")
      .slice(-120);
    return sanitized || "untitled";
  }
}
