// Remembers a successful sign-in check for a few seconds.
// Every request used to ask the database twice (is the session active? who is this, what role?) before doing
// its own work. A page that opens with 6 requests asked 12 times. With a few database connections and a
// trip to London each, that was most of the wait when many people arrived at once.
// A remembered check is dropped when it's 3 seconds old, and straight away when that person signs out,
// signs in elsewhere, is suspended, removed, changes role or resets their password (forgetUser / forgetSession).

export type CachedUser = { userId: string; sessionId: string; email: string; role: string; fullName: string };

const TTL_MS = Number(process.env.AUTH_CACHE_MS ?? 3000);
const MAX_ENTRIES = 5000;
const byToken = new Map<string, { user: CachedUser; at: number }>();

export function getCachedSignIn(token: string): CachedUser | null {
  if (TTL_MS <= 0) return null;
  const hit = byToken.get(token);
  if (!hit) return null;
  if (Date.now() - hit.at > TTL_MS) {
    byToken.delete(token);
    return null;
  }
  return hit.user;
}

export function rememberSignIn(token: string, user: CachedUser) {
  if (TTL_MS <= 0) return;
  if (byToken.size >= MAX_ENTRIES) byToken.clear();
  byToken.set(token, { user, at: Date.now() });
}

/** Someone's role, status or sessions changed: their next request checks the database again */
export function forgetUser(userId: string) {
  for (const [token, hit] of byToken) if (hit.user.userId === userId) byToken.delete(token);
}

/** One session ended (signed out, or replaced by a sign-in elsewhere) */
export function forgetSession(sessionId: string) {
  for (const [token, hit] of byToken) if (hit.user.sessionId === sessionId) byToken.delete(token);
}
