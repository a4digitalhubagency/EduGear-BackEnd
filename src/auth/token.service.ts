import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import {
  Prisma,
  VerificationToken,
  VerificationTokenType,
} from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { AppConfig } from '../config/configuration';
import { RequestContext } from '../common/context/request-context';
import { AppException } from '../common/errors/app.exception';
import { ErrorCode } from '../common/errors/error-codes';
import { InjectPrisma } from '../database/prisma.tokens';
import { TenantAwarePrisma } from '../database/prisma.service';
import { AccessTokenPayload, IssuedTokens } from './token.types';

export interface SessionMeta {
  ip?: string;
  userAgent?: string;
}

/**
 * Token issuing and rotation.
 *
 * Access tokens are short-lived JWTs. Refresh tokens are opaque random strings
 * stored only as SHA-256 hashes, so a database leak cannot be replayed. Rotation
 * groups tokens by `familyId`: replaying an already-rotated token is treated as
 * theft and kills every session in that family.
 *
 * All of it lives in Postgres because the MVP stack has no Redis.
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    @InjectPrisma() private readonly prisma: TenantAwarePrisma,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private static sha256(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private static randomToken(): string {
    return randomBytes(48).toString('base64url');
  }

  private ttlToMs(ttl: string): number {
    const match = /^(\d+)([smhd])$/.exec(ttl.trim());
    if (!match) throw new Error(`Unsupported TTL format: ${ttl}`);
    const value = Number(match[1]);
    const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[
      match[2]
    ]!;
    return value * unit;
  }

  async issueTokens(params: {
    userId: string;
    membershipId: string;
    tokenVersion: number;
    meta?: SessionMeta;
    familyId?: string;
  }): Promise<IssuedTokens> {
    const jwtConfig = this.config.get('jwt', { infer: true });
    const accessTtlMs = this.ttlToMs(jwtConfig.accessTtl);
    const refreshTtlMs = this.ttlToMs(jwtConfig.refreshTtl);

    const payload: AccessTokenPayload = {
      sub: params.userId,
      mid: params.membershipId,
      ver: params.tokenVersion,
      typ: 'access',
      jti: randomUUID(),
    };

    const accessToken = await this.jwt.signAsync(payload, {
      secret: jwtConfig.accessSecret,
      // Seconds rather than the raw "15m" string: one parser, one source of truth.
      expiresIn: Math.floor(accessTtlMs / 1000),
      issuer: jwtConfig.issuer,
      audience: jwtConfig.audience,
    });

    const refreshToken = TokenService.randomToken();

    await RequestContext.runAsSystem(() =>
      this.prisma.refreshToken.create({
        data: {
          userId: params.userId,
          membershipId: params.membershipId,
          tokenHash: TokenService.sha256(refreshToken),
          familyId: params.familyId ?? randomUUID(),
          expiresAt: new Date(Date.now() + refreshTtlMs),
          createdByIp: params.meta?.ip,
          userAgent: params.meta?.userAgent?.slice(0, 255),
        },
      }),
    );

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: Math.floor(accessTtlMs / 1000),
    };
  }

  /**
   * Validates and rotates a refresh token.
   * @param membershipId optional override, used by "switch school" to move the
   *        session to another tenant the same user belongs to.
   */
  async rotateRefreshToken(
    rawToken: string,
    meta?: SessionMeta,
    membershipId?: string,
  ): Promise<{ tokens: IssuedTokens; userId: string; membershipId: string }> {
    const tokenHash = TokenService.sha256(rawToken);

    const stored = await RequestContext.runAsSystem(() =>
      this.prisma.refreshToken.findUnique({
        where: { tokenHash },
        include: { user: true },
      }),
    );

    if (!stored) {
      throw AppException.unauthorized(
        'Invalid refresh token',
        ErrorCode.TOKEN_INVALID,
      );
    }

    if (stored.revokedAt) {
      // Reuse of a rotated token: assume the token was stolen and drop the family.
      this.logger.warn(
        { userId: stored.userId, familyId: stored.familyId },
        'Refresh token reuse detected — revoking token family',
      );
      await this.revokeFamily(stored.familyId);
      throw AppException.unauthorized(
        'Refresh token has already been used. Please sign in again.',
        ErrorCode.TOKEN_REUSED,
      );
    }

    if (stored.expiresAt.getTime() <= Date.now()) {
      throw AppException.unauthorized(
        'Refresh token has expired',
        ErrorCode.TOKEN_EXPIRED,
      );
    }

    const nextMembershipId = membershipId ?? stored.membershipId;
    if (!nextMembershipId) {
      throw AppException.unauthorized(
        'Session has no school context',
        ErrorCode.TOKEN_INVALID,
      );
    }

    const tokens = await this.issueTokens({
      userId: stored.userId,
      membershipId: nextMembershipId,
      tokenVersion: stored.user.tokenVersion,
      meta,
      familyId: stored.familyId,
    });

    await RequestContext.runAsSystem(() =>
      this.prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date() },
      }),
    );

    return { tokens, userId: stored.userId, membershipId: nextMembershipId };
  }

  async revokeRefreshToken(rawToken: string): Promise<void> {
    const tokenHash = TokenService.sha256(rawToken);
    await RequestContext.runAsSystem(() =>
      this.prisma.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
  }

  async revokeFamily(familyId: string): Promise<void> {
    await RequestContext.runAsSystem(() =>
      this.prisma.refreshToken.updateMany({
        where: { familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
  }

  /** Used by logout-all and password change (which also bumps tokenVersion). */
  async revokeAllForUser(userId: string): Promise<void> {
    await RequestContext.runAsSystem(() =>
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Single-use tokens: email verification, password reset, invitations
  // -------------------------------------------------------------------------

  async createVerificationToken(params: {
    userId: string;
    type: VerificationTokenType;
    ttlMs: number;
    metadata?: Prisma.InputJsonValue;
  }): Promise<{ raw: string; record: VerificationToken }> {
    const raw = TokenService.randomToken();

    const record = await RequestContext.runAsSystem(async () => {
      // Only one live token per purpose, so an older link cannot be replayed.
      await this.prisma.verificationToken.updateMany({
        where: { userId: params.userId, type: params.type, consumedAt: null },
        data: { consumedAt: new Date() },
      });

      return this.prisma.verificationToken.create({
        data: {
          userId: params.userId,
          type: params.type,
          tokenHash: TokenService.sha256(raw),
          expiresAt: new Date(Date.now() + params.ttlMs),
          metadata: params.metadata,
        },
      });
    });

    return { raw, record };
  }

  async consumeVerificationToken(
    rawToken: string,
    type: VerificationTokenType,
  ): Promise<VerificationToken> {
    const tokenHash = TokenService.sha256(rawToken);

    return RequestContext.runAsSystem(async () => {
      const record = await this.prisma.verificationToken.findUnique({
        where: { tokenHash },
      });

      if (!record || record.type !== type) {
        throw AppException.badRequest(
          'This link is invalid',
          ErrorCode.TOKEN_INVALID,
        );
      }
      if (record.consumedAt) {
        throw AppException.badRequest(
          'This link has already been used',
          ErrorCode.TOKEN_INVALID,
        );
      }
      if (record.expiresAt.getTime() <= Date.now()) {
        throw AppException.badRequest(
          'This link has expired',
          ErrorCode.TOKEN_EXPIRED,
        );
      }

      return this.prisma.verificationToken.update({
        where: { id: record.id },
        data: { consumedAt: new Date() },
      });
    });
  }

  ttlHours(hours: number): number {
    return hours * 3_600_000;
  }

  ttlMinutes(minutes: number): number {
    return minutes * 60_000;
  }
}
