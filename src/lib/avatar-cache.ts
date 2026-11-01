// Short-lived signed links to private profile photos, reused for 50 minutes (they last an hour).
const cache = new Map<string, { url: string | null; expires: number }>();

export function cachedAvatar(path: string): string | null | undefined {
  const hit = cache.get(path);
  return hit && hit.expires > Date.now() ? hit.url : undefined;
}
export function rememberAvatar(path: string, url: string | null) {
  cache.set(path, { url, expires: Date.now() + 50 * 60 * 1000 });
}
/** Forget a link (after the photo changes or is removed). */
export function forgetAvatar(path: string | null | undefined) {
  if (path) cache.delete(path);
}
