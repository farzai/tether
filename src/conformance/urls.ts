const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/**
 * The protocol's rule for a URL an app hands the client: HTTPS, or plain HTTP only while the app
 * itself runs on loopback (development and tests). The schemas already keep plain HTTP on
 * loopback hosts; this adds the dependence on where the app runs.
 */
export function isAllowedUrl(appOrigin: string, value: string): boolean {
  const { protocol } = new URL(value);
  const loopbackApp = LOOPBACK_HOSTS.includes(new URL(appOrigin).hostname);
  return protocol === "https:" || (loopbackApp && protocol === "http:");
}
