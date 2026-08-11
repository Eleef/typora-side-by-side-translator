import type en from "./locales/lang.en.json";

export type UserFacingErrorCode = keyof typeof en.errors;

export class UserFacingError extends Error {
  public constructor(
    public readonly code: UserFacingErrorCode,
    public readonly values: Record<string, string | number> = {}
  ) {
    super(code);
    this.name = "UserFacingError";
  }
}
