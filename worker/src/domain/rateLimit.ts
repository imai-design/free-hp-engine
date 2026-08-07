export interface RateLimitStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export const RATE_LIMIT = 5;
export const RATE_WINDOW_SECONDS = 60 * 60;

export class RateLimitError extends Error {
  public readonly retryAfter: number;

  constructor(retryAfter: number) {
    super("rate limit exceeded");
    this.name = "RateLimitError";
    this.retryAfter = retryAfter;
  }
}

function rateKey(ip: string, bucket: number): string {
  return `ratelimit:v1:${encodeURIComponent(ip.slice(0, 120))}:${bucket}`;
}

export async function enforceRateLimit(
  store: RateLimitStore,
  ip: string,
  now = Date.now(),
): Promise<{ remaining: number; resetAt: number }> {
  const bucket = Math.floor(now / (RATE_WINDOW_SECONDS * 1000));
  const resetAt = (bucket + 1) * RATE_WINDOW_SECONDS * 1000;
  const key = rateKey(ip || "unknown", bucket);
  const current = Number.parseInt((await store.get(key)) ?? "0", 10);
  if (Number.isFinite(current) && current >= RATE_LIMIT) {
    throw new RateLimitError(Math.max(1, Math.ceil((resetAt - now) / 1000)));
  }
  await store.put(key, String((Number.isFinite(current) ? current : 0) + 1), { expirationTtl: RATE_WINDOW_SECONDS + 60 });
  return { remaining: Math.max(0, RATE_LIMIT - current - 1), resetAt };
}
