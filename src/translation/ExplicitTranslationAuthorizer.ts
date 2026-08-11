const AUTHORIZATION_MARKER = Symbol("typora-side-by-side-explicit-translation");

export type ExplicitTranslationReason = "translate-current-file" | "refresh-stale-blocks";

export interface ExplicitTranslationAuthorization {
  readonly reason: ExplicitTranslationReason;
  readonly [AUTHORIZATION_MARKER]: true;
}

export class ExplicitTranslationAuthorizer {
  public authorize(reason: ExplicitTranslationReason): ExplicitTranslationAuthorization {
    return Object.freeze({
      reason,
      [AUTHORIZATION_MARKER]: true as const
    });
  }

  public assertAuthorized(value: ExplicitTranslationAuthorization | undefined): asserts value is ExplicitTranslationAuthorization {
    if (!value || value[AUTHORIZATION_MARKER] !== true) {
      throw new UserFacingError("authorizationMissing");
    }
  }
}
import { UserFacingError } from "../i18n/UserFacingError";
