import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { captureArticle } from '../server/capture';
import { isBlocking, legacyWarning } from '../shared/sources';
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
  it('replaces interactive elements with note markers and informational warnings', async () => {
    const captured = await captureArticle('https://example.com/p', async url => ({ bytes: Buffer.from('<article><h1>T</h1><p>Before 1.</p><canvas id="c"></canvas><p>Mid.</p><table><tr><td colspan="2">x</td></tr></table></article>'), type: 'text/html', url }));
    expect(captured.source.markdown).toMatch(/Before 1\.[\s\S]*!\[Interactive figure\]\(source-note-0\)[\s\S]*Mid\./);
    expect(captured.source.warnings.map(w => w.kind)).toEqual(['info', 'info']);
    expect(captured.source.warnings.some(w => w.message.includes('https://example.com/p'))).toBe(true);
    expect(isBlocking(captured.source)).toBe(false);
  });
  it('converts TeX-annotated MathML inline without splitting the sentence', async () => {
    const captured = await captureArticle('https://example.com/p', async url => ({ bytes: Buffer.from('<article><p>Let <math><semantics><mi>x</mi><annotation encoding="application/x-tex">x^2</annotation></semantics></math> be small.</p></article>'), type: 'text/html', url }));
    expect(captured.source.markdown.trim()).toMatch(/^Let \$x\^2\$ be small\.$/);
    expect(captured.source.markdown).not.toContain('source-note');
    expect(captured.source.warnings).toEqual([]);
  });
  it('places a note after the paragraph for MathML without TeX', async () => {
    const captured = await captureArticle('https://example.com/p', async url => ({ bytes: Buffer.from('<article><p>Let <math><mi>x</mi></math> be small.</p><p>Next.</p></article>'), type: 'text/html', url }));
    expect(captured.source.markdown.trim().split(/\n\s*\n/)).toEqual(['Let be small.', '![Interactive figure](source-note-0)', 'Next.']);
    expect(captured.source.warnings).toHaveLength(1);
  });
  it('does not register or download images inside replaced elements', async () => {
    const requested: string[] = [];
    const captured = await captureArticle('https://example.com/p', async url => { requested.push(url); return { bytes: Buffer.from('<article><p>A</p><iframe src="/embed"><img src="fallback.png"></iframe><canvas><img src="c.png"></canvas></article>'), type: 'text/html', url }; });
    expect(captured.source.assets).toEqual([]);
    expect(requested).toEqual(['https://example.com/p']);
    expect(captured.source.warnings.every(w => w.kind === 'info')).toBe(true);
  });
  it('keeps failed visuals blocking', async () => {
    const captured = await captureArticle('https://example.com/', async url => {
      if (url.endsWith('.png')) throw new Error('Image unavailable');
      return { bytes: Buffer.from('<article><p>Before</p><img src="lost.png"></article>'), type: 'text/html', url };
    });
    expect(captured.source.warnings[0].kind).toBe('blocking');
    expect(isBlocking(captured.source)).toBe(true);
  });
  it('classifies legacy string warnings', () => {
    expect(legacyWarning('A table contains merged cells. Its preview is flattened.').kind).toBe('info');
    expect(legacyWarning('Source unavailable').kind).toBe('blocking');
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
  it('keeps currency amounts and linked footnote markers as plain text', async () => {
    const html = '<article><p>It costs $5 to $10 per hour.<sup class="reference"><a href="#cite-1">[1]</a></sup></p></article>';
    const { source } = await captureArticle('https://example.com/', async url => ({ bytes: Buffer.from(html), type: 'text/html', url }));
    const rendered = renderToStaticMarkup(createElement(Markdown, { children: source.markdown }));
    expect(rendered).not.toContain('katex');
    expect(rendered).toContain('$5 to $10 per hour.');
    expect(rendered).toContain('[1]');
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

describe('credits and streamed videos', () => {
  const page = (body: string, head = '') => '<html><head><title>Paper page</title>' + head + '</head><body><article><h1>Heads</h1>' + body + '</article></body></html>';
  const run = async (html: string, png?: Buffer) => {
    const requested: string[] = [];
    const captured = await captureArticle('https://example.com/post', async url => {
      requested.push(url);
      return url === 'https://example.com/post' ? { bytes: Buffer.from(html), type: 'text/html', url } : { bytes: png!, type: 'image/png', url };
    });
    return { ...captured, requested };
  };
  it('records where each image came from, its credit line and a never-guessed licence', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } }).png().toBuffer();
    const { source } = await run(page('<figure><img src="a.png" alt="A"><figcaption>Attention heads. Credit: Jane Doe</figcaption></figure><a href="https://creativecommons.org/licenses/by/4.0/">CC BY</a>'), png);
    expect(source.assets[0].credit).toMatchObject({ pageTitle: 'Heads', pageUrl: 'https://example.com/post', mediaUrl: 'https://example.com/a.png', caption: 'Attention heads. Credit: Jane Doe' });
    expect(source.assets[0].credit?.creditLine).toMatch(/Credit: Jane Doe/);
    expect(source.assets[0].credit?.license).toMatch(/creativecommons/);
    expect(source.assets[0].credit?.capturedAt).toMatch(/^\d{4}-/);
  });
  it('leaves the licence absent and trims long credit lines to 300 characters', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } }).png().toBuffer();
    const { source } = await run(page('<img src="a.png" alt="A"><p>Photo by ' + 'x'.repeat(400) + '</p>'), png);
    expect(source.assets[0].credit?.license).toBeUndefined();
    expect(source.assets[0].credit?.creditLine?.length).toBe(300);
  });
  it('reads a licence from link rel=license or copyright meta', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } }).png().toBuffer();
    expect((await run(page('<img src="a.png">', '<link rel="license" href="https://example.com/terms">'), png)).source.assets[0].credit?.license).toBe('https://example.com/terms');
    expect((await run(page('<img src="a.png">', '<meta name="copyright" content="(c) Example Ltd">'), png)).source.assets[0].credit?.license).toBe('(c) Example Ltd');
  });
  it('streams a YouTube iframe from youtube-nocookie without requesting it, and raises no warning', async () => {
    const { source, requested } = await run(page('<p>Watch.</p><iframe title="Lecture" src="https://www.youtube.com/embed/abc123XYZ_-"></iframe>'));
    expect(source.assets[0]).toMatchObject({ kind: 'video', alt: 'Lecture', src: '/assets/video-poster.svg', video: { provider: 'youtube', embedUrl: 'https://www.youtube-nocookie.com/embed/abc123XYZ_-' } });
    expect(source.markdown).toContain('![Lecture](source-asset-0)');
    expect(requested).toEqual(['https://example.com/post']);
    expect(source.warnings).toEqual([]);
    expect(source.assets[0].credit?.mediaUrl).toBe('https://www.youtube.com/embed/abc123XYZ_-');
  });
  it('streams Vimeo and downloads only a video poster, never the video file', async () => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } }).png().toBuffer();
    const { source, requested, blobs } = await run(page('<video poster="p.png" src="v.mp4"></video><iframe src="https://player.vimeo.com/video/123"></iframe>'), png);
    expect(requested).toEqual(['https://example.com/post', 'https://example.com/p.png']);
    expect(source.assets[0]).toMatchObject({ kind: 'video', video: { provider: 'file', url: 'https://example.com/v.mp4', embedUrl: 'https://example.com/v.mp4' } });
    expect(source.assets[0].src).toMatch(/^\/api\/source-assets\//);
    expect(blobs).toHaveLength(1);
    expect(source.assets[1].video).toMatchObject({ provider: 'vimeo', embedUrl: 'https://player.vimeo.com/video/123' });
    expect(source.warnings).toEqual([]);
  });
  it('treats a video with no source as not streamable', async () => {
    const { source } = await run(page('<p>Before.</p><video controls></video><p>After.</p>'));
    expect(source.assets).toEqual([]);
    expect(source.markdown).toContain('(source-note-0)');
    expect(source.warnings.map(w => w.kind)).toEqual(['info']);
  });
  it('uses video > source and still warns for audio and unknown iframes', async () => {
    const { source } = await run(page('<video><source src="/clip.webm"></video><audio src="a.mp3"></audio><iframe src="https://evil.example/video/1"></iframe>'));
    expect(source.assets).toHaveLength(1);
    expect(source.assets[0].video?.url).toBe('https://example.com/clip.webm');
    expect(source.warnings.map(w => w.message)).toEqual([expect.stringMatching(/audio/i), expect.stringMatching(/interactive figure/i)]);
  });
});

