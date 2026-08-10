import { normalizeAndValidateBaseUrl } from "./EndpointPolicy";

function endpointOrigin(baseUrl: string): string {
  const normalized = normalizeAndValidateBaseUrl(baseUrl);
  return normalized ? new URL(normalized).origin : "";
}

export class SessionCredentialStore {
  private apiKey = "";
  private origin = "";

  public set(baseUrl: string, apiKey: string): void {
    const trimmedKey = apiKey.trim();
    if (!trimmedKey) {
      this.clear();
      return;
    }

    const origin = endpointOrigin(baseUrl);
    if (!origin) {
      throw new Error("请先配置 baseUrl，再输入 API key。");
    }
    this.apiKey = trimmedKey;
    this.origin = origin;
  }

  public get(baseUrl: string): string {
    if (!this.apiKey || !this.origin) {
      return "";
    }
    try {
      return endpointOrigin(baseUrl) === this.origin ? this.apiKey : "";
    } catch {
      return "";
    }
  }

  public clearIfEndpointChanged(baseUrl: string): void {
    if (this.apiKey && this.get(baseUrl) === "") {
      this.clear();
    }
  }

  public clear(): void {
    this.apiKey = "";
    this.origin = "";
  }
}
