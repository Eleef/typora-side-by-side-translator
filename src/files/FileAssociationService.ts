import { path } from "@typora-community-plugin/core";
import { FileAssociation } from "../types";

export class FileAssociationService {
  public constructor(private readonly cacheRootDir: string) {}

  public resolve(sourcePath: string | null | undefined): FileAssociation {
    if (!sourcePath) {
      return {
        sourcePath: "",
        cacheTargetPath: "",
        cacheMapPath: "",
        exportTargetPath: "",
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
        isSupportedSource: false,
        reason: "仅支持已保存的本地 .md 文件。"
      };
    }

    if (/\.zh\.md$/i.test(normalized)) {
      return {
        sourcePath: normalized,
        cacheTargetPath: "",
        cacheMapPath: "",
        exportTargetPath: "",
        isSupportedSource: false,
        reason: "当前文件已是译文文件，插件不会对 .zh.md 再进入双语流程。"
      };
    }

    const basename = path.basename(normalized, ".md");
    const readableKey = this.createReadableKey(normalized);
    const cacheDirectory = path.join(this.cacheRootDir, readableKey);
    return {
      sourcePath: normalized,
      cacheTargetPath: path.join(cacheDirectory, `${basename}.zh.md`),
      cacheMapPath: path.join(cacheDirectory, `${basename}.zh.map.json`),
      exportTargetPath: path.join(path.dirname(normalized), `${basename}.zh.md`),
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
