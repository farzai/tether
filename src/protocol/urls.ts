const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

const isLoopback = (url: URL) => LOOPBACK_HOSTS.includes(url.hostname);

/**
 * The protocol's rule for a URL an app hands the client: HTTPS, or plain HTTP only to a loopback
 * host while the app itself runs on loopback (development and tests). A value WHATWG cannot parse
 * is refused, so the check that asks records a failure instead of aborting the run.
 */
export function isAllowedUrl(appOrigin: string, value: string): boolean {
  const url = URL.parse(value);
  if (!url) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLoopback(url) && isLoopback(new URL(appOrigin));
}
