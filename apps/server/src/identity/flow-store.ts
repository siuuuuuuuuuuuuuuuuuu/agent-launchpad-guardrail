// In-memory, single-process TTL maps for the two short-lived handoffs in the
// OIDC dance: `state -> pending login` between /login and /callback (5 min,
// covers a slow IdP consent screen), and `handoff code -> session token`
// between /callback and the browser's POST /auth/exchange (60s — the browser
// redirect is immediate). Consistent with JsonStore's own "one process only"
// scope; a multi-replica control plane needs this in Redis (see ADR 0001).

interface Entry<T> {
  value: T;
  expiresAt: number;
}

class TtlStore<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(private readonly ttlMs: number) {}

  set(key: string, value: T): void {
    this.sweep();
    this.entries.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** One-time read: a key is consumed whether or not it was still valid. */
  takeOnce(key: string): T | null {
    const entry = this.entries.get(key);
    this.entries.delete(key);
    if (!entry || entry.expiresAt < Date.now()) return null;
    return entry.value;
  }

  private sweep(): void {
    if (this.entries.size < 200) return; // cheap bound; avoids unbounded growth
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt < now) this.entries.delete(key);
    }
  }
}

export interface PendingLogin {
  codeVerifier: string;
}

export const pendingLogins = new TtlStore<PendingLogin>(5 * 60_000);
export const handoffCodes = new TtlStore<{ token: string }>(60_000);
