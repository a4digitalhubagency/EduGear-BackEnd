/**
 * Throttle budgets for credential endpoints.
 *
 * These are read from the environment at module load because `@Throttle()` is a
 * decorator — it is evaluated before the DI container (and ConfigService) exist.
 * This is the one place outside `src/config` allowed to touch `process.env`.
 */
function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Login, refresh, reset-password, verify-email. */
export const AUTH_THROTTLE = {
  default: {
    limit: int(process.env.AUTH_THROTTLE_LIMIT, 10),
    ttl: int(process.env.AUTH_THROTTLE_TTL_SECONDS, 60) * 1000,
  },
};

/** Account creation and email-sending endpoints — abuse targets, so tighter. */
export const STRICT_THROTTLE = {
  default: {
    limit: int(process.env.STRICT_THROTTLE_LIMIT, 5),
    ttl: int(process.env.STRICT_THROTTLE_TTL_SECONDS, 3600) * 1000,
  },
};
