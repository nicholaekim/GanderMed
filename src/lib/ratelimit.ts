// Fixed-window in-memory rate limiter — adequate for a single-instance
// SQLite pilot. Replace with a shared store (Redis or a DB table) the day
// the app runs on more than one process.

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

/** Returns true when the caller is within the limit; false = rejected. */
export function allowRequest(key: string, max: number, windowMs: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= max;
}

export function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  return fwd ? fwd.split(",")[0].trim() : "local";
}

export function __resetRateLimitsForTests(): void {
  buckets.clear();
}
