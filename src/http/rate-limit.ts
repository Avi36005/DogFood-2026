/**
 * Fixed-window counters in memory. One process serves the portal, so this is enough to slow
 * password guessing and sign-up floods; it resets on restart, which is stated in THREAT-MODEL.md.
 */
export class RateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #hits = new Map<string, { count: number; resetAt: number }>();

  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  /** Counts one attempt; returns seconds to wait if over the limit, otherwise 0. */
  hit(key: string, now = Date.now()): number {
    if (this.#hits.size > 10_000) this.#sweep(now);
    const entry = this.#hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.#hits.set(key, { count: 1, resetAt: now + this.#windowMs });
      return 0;
    }
    entry.count++;
    return entry.count > this.#limit ? Math.ceil((entry.resetAt - now) / 1000) : 0;
  }

  reset(key: string): void {
    this.#hits.delete(key);
  }

  #sweep(now: number): void {
    for (const [key, entry] of this.#hits) if (entry.resetAt <= now) this.#hits.delete(key);
  }
}
