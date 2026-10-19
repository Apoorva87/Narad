import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { captureArticle } from '../server/capture';
import { isPublicAddress } from '../server/download';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown } from '../src/components/Markdown';

describe('source preservation', () => {
  it('preserves ordered figures, inline mathematics, tables, and the original snapshot', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } }).png().toBuffer();
    const html = '<html><title>A paper</title><nav>Ignore menu</nav><article><h1>Exact results</h1><p>First 42.</p><img src="fig.png" alt="Measured data"><p>Next <svg xmlns="http://www.w3.org/2000/svg" width="2em" height="1em" viewBox="0 0 32 16"><path d="M0 0L32 16" stroke="black"/></svg> equals 7.</p><table><tr><th>Value</th></tr><tr><td>3.14159</td></tr></table></article></html>';
    const captured = await captureArticle('https://example.com/paper/', async url => ({ bytes: url.endsWith('fig.png') ? png : Buffer.from(html), url, type: url.endsWith('fig.png') ? 'image/png' : 'text/html' }));
    expect(captured.source.rawHtml).toBe(html);
    expect(captured.source.inventory).toMatchObject({ images: 1, inlineSvg: 1, tables: 1, savedVisuals: 2 });
    expect(captured.source.markdown).toMatch(/First 42[\s\S]*source-asset-[\s\S]*Next[\s\S]*source-asset-[\s\S]*equals 7[\s\S]*3\.14159/);
    expect(captured.source.markdown).not.toContain('Ignore menu');
    expect(captured.source.assets.map(a => a.kind)).toEqual(['image', 'inline-svg']);
    expect(captured.blobs).toHaveLength(3); // PNG figure, SVG original, rasterized equation.
    expect(captured.source.warnings).toEqual([]);
  });
  it('keeps a visible placeholder and warning for missing visuals', async () => {
    const captured = await captureArticle('https://example.com/', async url => {
      if (url.endsWith('.png')) throw new Error('Image unavailable');
      return { bytes: Buffer.from('<article><p>Before</p><img src="lost.png"><p>After</p></article>'), type: 'text/html', url };
    });
    expect(captured.source.inventory.savedVisuals).toBe(0);
    expect(captured.source.assets[0].error).toContain('unavailable');
    expect(captured.source.markdown).toMatch(/Before[\s\S]*source-asset-[\s\S]*After/);
    expect(captured.source.warnings).toHaveLength(1);
  });
  it('does not rasterize SVGs that reference outside resources', async () => {
    const captured = await captureArticle('https://example.com/', async url => ({ bytes: Buffer.from('<article><svg width="20" height="20"><image href="file:///etc/passwd"/></svg></article>'), type: 'text/html', url }));
    expect(captured.source.inventory.savedVisuals).toBe(0);
    expect(captured.source.warnings.length).toBeGreaterThan(0);
  });
  it('keeps local SVG arrowhead references while blocking external paint resources', async () => {
    const svg = '<svg width="40" height="40"><defs><marker id="arrow"><path d="M0 0L4 4"/></marker></defs><path d="M0 0L40 40" marker-end="url(#arrow)"/></svg>';
    const captured = await captureArticle('https://example.com/', async url => ({ bytes: Buffer.from('<article>' + svg + '</article>'), type: 'text/html', url }));
    expect(captured.source.inventory.savedVisuals).toBe(1);
    const unsafe = svg.replace('url(#arrow)', 'url(https://example.com/external.svg)');
    const rejected = await captureArticle('https://example.com/', async url => ({ bytes: Buffer.from('<article>' + unsafe + '</article>'), type: 'text/html', url }));
    expect(rejected.source.inventory.savedVisuals).toBe(0);
  });
  it('renders headerless table cells, superscripts, subscripts, and MathJax equations', async () => {
    const html = '<article><p>E = mc<sup>2</sup>, H<sub>2</sub>O</p><script type="math/tex; mode=display">x = 42</script><table><tr><td>Throughput</td><td>3.14159</td></tr><tr><td>Latency</td><td>12 ms</td></tr></table></article>';
    const { source } = await captureArticle('https://example.com/', async url => ({ bytes: Buffer.from(html), type: 'text/html', url }));
    const rendered = renderToStaticMarkup(createElement(Markdown, { children: source.markdown }));
    expect(rendered).toContain('<table>');
    expect(rendered).toContain('3.14159');
    expect(rendered).toContain('12 ms');
    expect(rendered).toContain('katex');
    expect(source.markdown).toContain('^{2}');
    expect(source.markdown).toContain('_{2}');
    expect(source.markdown).toContain('x = 42');
    expect(source.warnings).toEqual([]);
  });
  it('preserves GIF original bytes rather than replacing the original with a PNG', async () => {
    const gif = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } }).gif().toBuffer();
    const { source, blobs } = await captureArticle('https://example.com/', async url => ({ bytes: url.endsWith('.gif') ? gif : Buffer.from('<article><img src="plot.gif"></article>'), type: url.endsWith('.gif') ? 'image/gif' : 'text/html', url }));
    const id = source.assets[0].originalSrc?.split('/').at(-1);
    expect(blobs.find(blob => blob.id === id)?.bytes).toEqual(gif);
  });
  it('displays equations nested inside code-styled prose', async () => {
    const html = '<article><code>Provision for <svg width="32" height="16"><path d="M0 0L32 16"/></svg> then continue.</code></article>';
    const { source } = await captureArticle('https://example.com/', async url => ({ bytes: Buffer.from(html), type: 'text/html', url }));
    const rendered = renderToStaticMarkup(createElement(Markdown, { children: source.markdown, assets: source.assets }));
    expect(rendered).toContain('<img');
    expect(rendered).not.toContain('<code>');
  });
  it('preserves AVIF originals using the actual AVIF media type', async () => {
    const avif = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } }).avif().toBuffer();
    const { source, blobs } = await captureArticle('https://example.com/', async url => ({ bytes: url.endsWith('.avif') ? avif : Buffer.from('<article><img src="plot.avif"></article>'), type: url.endsWith('.avif') ? 'image/avif' : 'text/html', url }));
    expect(source.inventory.savedVisuals).toBe(1);
    expect(blobs[0].type).toBe('image/avif');
    expect(blobs[0].bytes).toEqual(avif);
  });
});

describe('public source requests', () => {
  it('blocks loopback, LAN, link-local, mapped IPv4, and reserved addresses', () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.1.2', '169.254.169.254', '100.64.0.1', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1', '2001:db8::1']) expect(isPublicAddress(address), address).toBe(false);
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('2606:4700:4700::1111')).toBe(true);
  });
});
