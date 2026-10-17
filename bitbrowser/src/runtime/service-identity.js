/** Normalize local service identities for coordination without changing request routing. */
export function serviceIdentity(service) {
  // Internal callers may use opaque test/service keys; preserve their identity.
  if (!URL.canParse(service)) return service;
  const url = new URL(service);
  // A dual-stack local service must share locks across all supported loopback aliases.
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    url.hostname = '127.0.0.1';
  }
  return url.origin;
}
