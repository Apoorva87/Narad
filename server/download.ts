import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001::', 23, 'ipv6'); blocked.addSubnet('2001:db8::', 32, 'ipv6'); blocked.addSubnet('2002::', 16, 'ipv6');
export function isPublicAddress(address: string) {
  if (isIP(address) === 4) return !blocked.check(address, 'ipv4');
  return isIP(address) === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export async function downloadPublic(input: string, redirects = 0): Promise<{ bytes: Buffer; type: string; url: string }> {
  const url = new URL(input);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (url.port && url.port !== '80' && url.port !== '443')) throw new Error('Use a public HTTP or HTTPS link on a standard web port.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('Local and private network addresses cannot be captured.');
  const address = addresses[0];
  const result = await new Promise<{ bytes: Buffer; type: string; redirect?: string }>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).get(url, {
      headers: { 'User-Agent': 'Narad/0.2 (local source reader)', Accept: 'text/html,image/*;q=0.9,*/*;q=0.5', 'Accept-Encoding': 'identity' },
      lookup: (_hostname, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family),
    }, response => {
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume(); resolve({ bytes: Buffer.alloc(0), type: '', redirect: new URL(response.headers.location, url).href }); return;
      }
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume(); reject(new Error('Source returned HTTP ' + response.statusCode + '.')); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > 20 * 1024 * 1024) { request.destroy(new Error('This source exceeds the 20 MB per-file capture limit.')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ bytes: Buffer.concat(chunks), type: response.headers['content-type'] ?? '' }));
    });
    const timer = setTimeout(() => request.destroy(new Error('This source took too long to respond.')), 20_000);
    request.on('close', () => clearTimeout(timer)); request.on('error', reject);
  });
  if (result.redirect) {
    if (redirects >= 4) throw new Error('Too many source redirects.');
    return downloadPublic(result.redirect, redirects + 1);
  }
  return { bytes: result.bytes, type: result.type, url: url.href };
}
