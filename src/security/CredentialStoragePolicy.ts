import { CredentialStorageMode } from "../types";

export const CURRENT_CREDENTIAL_STORAGE_VERSION = 1;

export interface CredentialStoragePolicy {
  mode: CredentialStorageMode;
  version: number;
  migrated: boolean;
}

export function resolveCredentialStoragePolicy(value: unknown, versionValue: unknown): CredentialStoragePolicy {
  const version = Number(versionValue);
  if (!Number.isFinite(version) || version < CURRENT_CREDENTIAL_STORAGE_VERSION) {
    return {
      mode: "plugin-settings",
      version: CURRENT_CREDENTIAL_STORAGE_VERSION,
      migrated: true
    };
  }

  return {
    mode: value === "session" ? "session" : "plugin-settings",
    version: CURRENT_CREDENTIAL_STORAGE_VERSION,
    migrated: false
  };
}
