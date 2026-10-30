// Auth limits (spec section 5: 30 min idle, 12 h absolute, rate limiting and lockout).
const MINUTE = 60_000;

export const POLICY = {
  idleMs: 30 * MINUTE,
  absoluteMs: 12 * 60 * MINUTE,
  /** Only write lastSeenAt when it is at least this old, to keep session checks cheap. */
  touchMs: MINUTE,
  totpChallengeMs: 5 * MINUTE,
  enrollChallengeMs: 15 * MINUTE,
  setupTokenMs: 24 * 60 * MINUTE,
  maxCodeAttempts: 5,
  lockAfterFailures: 5,
  lockWindowSec: 15 * 60,
  ipAttempts: 30,
  ipWindowSec: 15 * 60,
} as const;
