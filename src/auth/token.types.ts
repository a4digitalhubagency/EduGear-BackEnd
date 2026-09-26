/**
 * Access token payload. Ids only — no email, no role names, no permissions.
 * Everything else is resolved server-side from `mid` on each request, which also
 * means a revoked membership or changed role takes effect without waiting for
 * the token to expire.
 */
export interface AccessTokenPayload {
  /** User id */
  sub: string;
  /** Membership id — the server derives the active tenant from this. */
  mid: string;
  /** User.tokenVersion at issue time; a bump invalidates outstanding tokens. */
  ver: number;
  typ: 'access';
  jti: string;
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string;
}

/**
 * A platform operator's access token. A separate `typ` and a separate id field,
 * not a reused `mid`: the two scopes must never be confusable, because a bug
 * that read one as the other would hand a school user the platform.
 */
export interface PlatformTokenPayload {
  /** User id */
  sub: string;
  /** PlatformAdmin id — authority comes from this row, not from a membership. */
  pid: string;
  /** User.tokenVersion at issue time. */
  ver: number;
  typ: 'platform';
  jti: string;
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string;
}

/** What the JWT strategy receives before it knows which kind of token it is. */
export type TokenPayload = AccessTokenPayload | PlatformTokenPayload;

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}
