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

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
}
