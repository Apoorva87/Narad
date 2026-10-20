export type ApiRequestAccess = {
  method: string;
  host?: string;
  origin?: string;
  fetchSite?: string;
};

export function configuredWebOrigin(value?: string) {
  if (!value) return undefined;
  const url = new URL(value);
  const loopbackHttp = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !loopbackHttp) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('NARAD_WEB_ORIGIN must be an HTTPS origin (or loopback HTTP for development) without a path.');
  }
  return url.origin;
}

export function allowsApiRequest(request: ApiRequestAccess, webOrigin?: string) {
  if (!request.host) return false;
  let host: URL;
  try { host = new URL('http://' + request.host); } catch { return false; }

  const localHost = ['localhost', '127.0.0.1', '[::1]'].includes(host.hostname);
  const remoteOrigin = configuredWebOrigin(webOrigin);
  const remoteHost = remoteOrigin ? new URL(remoteOrigin).host : undefined;
  if (!localHost && host.host !== remoteHost) return false;

  const allowedOrigins = new Set([
    'http://' + host.host,
    'http://127.0.0.1:5178',
    'http://localhost:5178',
    remoteOrigin,
  ].filter((value): value is string => Boolean(value)));
  if (request.origin && !allowedOrigins.has(request.origin)) return false;
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && request.fetchSite === 'cross-site') return false;
  return true;
}
