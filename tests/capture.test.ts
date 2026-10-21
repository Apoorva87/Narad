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
  it('blocks capture when the article references numbered figures but exposes no visual assets', async () => {
    const captured = await captureArticle('https://example.com/paper', async url => ({ bytes: Buffer.from('<article><h1>Paper</h1><p>Figure 1 shows the wafer layout.</p><p>As shown in Fig. 2, bandwidth scales linearly.</p></article>'), type: 'text/html', url }));
    expect(captured.source.assets).toEqual([]);
    expect(captured.source.warnings).toEqual([expect.objectContaining({
      kind: 'blocking',
      message: expect.stringMatching(/references numbered figures.*no visual assets were captured/i),
    })]);
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
  it('links a Not captured note to the original page when its http(s) address is known', () => {
    const markdown = 'Before.\n\n![Interactive figure](source-note-0)\n\nAfter.';
    const linked = renderToStaticMarkup(createElement(Markdown, { children: markdown, sourceUrl: 'https://example.com/page' } as any));
    expect(linked).toContain('Not captured: Interactive figure.');
    expect(linked).toMatch(/<a href="https:\/\/example\.com\/page"[^>]*>Open the original ↗<\/a>/);
    for (const sourceUrl of [undefined, 'javascript:alert(1)'])
      expect(renderToStaticMarkup(createElement(Markdown, { children: markdown, sourceUrl } as any))).not.toContain('Open the original');
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


describe('Next.js pages with Sanity portable text figures', () => {
  // Synthetic stand-in for a server-rendered Next.js/Sanity blog: the article text is in the HTML,
  // but the figures exist only in the React Server Components payload (self.__next_f.push chunks).
  const H1 = '1111111111111111111111111111111111111111', H2 = '2222222222222222222222222222222222222222', DECOY = '9999999999999999999999999999999999999999';
  const span = (text: string, marks: string[] = []) => ({ _key: 'k' + text.length, _type: 'span', marks, text });
  const block = (text: string, style = 'normal', extra: object = {}) => ({ _key: 'b' + text.length, _type: 'block', style, markDefs: [], children: [span(text)], ...extra });
  const body = [
    block('Neural networks have grown exponentially, and the memory they need has grown with them.'),
    { _key: 'i1', _type: 'imageBlock', caption: 'Figure 1. The compute core.', image: { altText: 'Core diagram', asset: { _id: `image-${H1}-800x600-png`, _type: 'sanity.imageAsset' } } },
    block('$1f'), // Long strings move to an RSC text row and are referenced as "$<id>".
    block('Memory design', 'h2'),
    { _key: 'p2', _type: 'block', style: 'normal', markDefs: [{ _key: 'lnk', _type: 'link', href: 'https://example.org/paper' }],
      children: [span('Weights stream from '), span('external storage', ['strong']), span(' while activations stay '), span('on chip', ['em', 'lnk']), span('.')] },
    { _key: 'i2', _type: 'image', alt: 'Fabric layout', caption: 'Figure 2. The wafer fabric.', asset: { _ref: `image-${H2}-2400x1200-jpg`, _type: 'reference' } },
    block('Scaling out therefore needs no model partitioning at all.'),
    block('Fewer moving parts', 'normal', { listItem: 'bullet', level: 1 }),
    block('Linear scaling', 'normal', { listItem: 'bullet', level: 1 }),
  ];
  const decoy = [block('Another post about networking chips'), { _key: 'd1', _type: 'image', asset: { _ref: `image-${DECOY}-400x300-png` } }];
  const LONG = 'Each core’s memory is local — so bandwidth scales with the number of cores. 🚀';
  // Text rows are length-prefixed in UTF-8 bytes and the next row follows with no newline, as on real pages.
  const payloadOf = (body: object[]) => '0:["$","html",null,{}]\n1f:T' + Buffer.byteLength(LONG).toString(16) + ',' + LONG + '5:' + JSON.stringify({ page: { title: 'Inside the wafer', mainImage: { url: `https://cdn.sanity.io/images/abc123/production/${'8'.repeat(40)}-1200x630.png` }, body },
    related: [{ title: 'Another post about networking chips', body: decoy, thumbnail: { url: `https://cdn.sanity.io/images/abc123/production/${DECOY}-400x300.png` } }] }) + '\n';
  const payload = payloadOf(body);
  // The payload is split across several chunks, mid-array, as Next.js does.
  const pushes = (text: string) => [0, 300, 900, text.length].slice(0, -1).map((start, i, starts) => '<script>self.__next_f.push([1,' + JSON.stringify(text.slice(start, starts[i + 1] ?? text.length)) + '])</script>').join('');
  const ssr = '<main><h1>Inside the wafer</h1><p>Neural networks have grown exponentially, and the memory they need has grown with them.</p><p>Figure 1. The compute core.</p>'
    + '<p>Each core’s memory is local — so bandwidth scales with the number of cores. 🚀</p><h2>Memory design</h2><p>Weights stream from <b>external storage</b> while activations stay on chip.</p><p>Figure 2. The wafer fabric.</p>'
    + '<p>Scaling out therefore needs no model partitioning at all.</p><ul><li>Fewer moving parts</li><li>Linear scaling</li></ul><aside><h3>Related</h3><a href="/blog/other">Another post about networking chips</a></aside></main>';
  const page = (scripts: string, main = ssr) => '<html><head><title>Inside the wafer | Blog</title></head><body>' + main + scripts + '</body></html>';
  const run = async (html: string, failImages = false) => {
    const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: 'red' } }).png().toBuffer();
    const requested: string[] = [];
    const captured = await captureArticle('https://blog.example.com/post', async url => {
      requested.push(url);
      if (url === 'https://blog.example.com/post') return { bytes: Buffer.from(html), type: 'text/html', url };
      if (failImages) throw new Error('Image unavailable');
      return { bytes: png, type: 'image/png', url };
    });
    return { ...captured, requested };
  };

  it('places the article figures from the payload between the right paragraphs, ignoring related-post images', async () => {
    const { source, requested, blobs } = await run(page(pushes(payload)));
    expect(requested).toEqual(['https://blog.example.com/post',
      `https://cdn.sanity.io/images/abc123/production/${H1}-800x600.png`,
      `https://cdn.sanity.io/images/abc123/production/${H2}-2400x1200.jpg?w=1600&fit=max`]);
    expect(source.markdown).toMatch(/grown with them\.\s+!\[Core diagram\]\(source-asset-0\)\s+Figure 1\. The compute core\.\s+Each core’s memory is local — so bandwidth scales with the number of cores\. 🚀\s+## Memory design\s+Weights stream from \*\*external storage\*\* while activations stay \[_on chip_\]\(https:\/\/example\.org\/paper\)\.\s+!\[Fabric layout\]\(source-asset-1\)\s+Figure 2\. The wafer fabric\.\s+Scaling out[\s\S]*\*\s+Fewer moving parts\s+\*\s+Linear scaling/);
    expect(source.markdown).not.toContain(DECOY);
    expect(source.markdown).not.toContain('Another post about networking');
    expect(source.assets.map(a => [a.id, a.kind, a.alt, a.caption])).toEqual([['source-asset-0', 'image', 'Core diagram', 'Figure 1. The compute core.'], ['source-asset-1', 'image', 'Fabric layout', 'Figure 2. The wafer fabric.']]);
    expect(source.assets[1].originalUrl).toBe(`https://cdn.sanity.io/images/abc123/production/${H2}-2400x1200.jpg?w=1600&fit=max`);
    expect(source.assets[0].credit).toMatchObject({ pageTitle: 'Inside the wafer', pageUrl: 'https://blog.example.com/post', mediaUrl: `https://cdn.sanity.io/images/abc123/production/${H1}-800x600.png`, caption: 'Figure 1. The compute core.' });
    expect(source.inventory).toMatchObject({ images: 2, savedVisuals: 2 });
    expect(blobs).toHaveLength(2); // One preserved raster per figure, as for <img> figures.
    expect(source.warnings).toEqual([]);
  });
  it('leaves a page whose HTML already has figures unchanged', async () => {
    const withImg = ssr.replace('<p>Figure 1. The compute core.</p>', '<figure><img src="/fig.png" alt="Static"><figcaption>Figure 1.</figcaption></figure>');
    const { source, requested } = await run(page(pushes(payload), withImg));
    expect(requested).toEqual(['https://blog.example.com/post', 'https://blog.example.com/fig.png']);
    expect(source.assets.map(a => a.alt)).toEqual(['Static']);
    expect(source.markdown).toContain('Related');
  });
  it('falls back to the plain text capture when the payload is malformed', async () => {
    const broken = payload.replace(/"body":\[/, '"body":[{"_type":"block",,');
    for (const scripts of [pushes(broken), '<script>self.__next_f.push([1,"5:[{\\"_type\\":\\"block\\"']) {
      const { source, requested } = await run(page(scripts));
      const plain = await run(page(''));
      expect(requested).toEqual(['https://blog.example.com/post']);
      expect(source.assets).toEqual([]);
      expect(source.warnings.map(warning => warning.kind)).toEqual(['blocking']);
      expect(source.markdown).toBe(plain.source.markdown);
    }
  });
  it('ignores a payload whose best match has no figures, even if a decoy does', async () => {
    const noFigures = payloadOf(body.filter(item => item._type === 'block'));
    expect(noFigures).not.toContain(H1);
    const { source, requested } = await run(page(pushes(noFigures)));
    expect(requested).toEqual(['https://blog.example.com/post']);
    expect(source.assets).toEqual([]);
  });
  it('raises normal blocking warnings when payload figures cannot be downloaded', async () => {
    const { source } = await run(page(pushes(payload)), true);
    expect(source.assets).toHaveLength(2);
    expect(source.warnings.map(w => w.kind)).toEqual(['blocking', 'blocking']);
    expect(isBlocking(source)).toBe(true);
    expect(source.markdown).toMatch(/source-asset-0[\s\S]*Memory design[\s\S]*source-asset-1/);
  });
  it('bounds the work on deeply nested hostile payloads and falls back to the text capture', async () => {
    const level = '[{"_type":"block","style":"normal","markDefs":[],"children":[{"_type":"span","text":"Neural networks have grown exponentially memory bandwidth cores"}],"x":';
    const depth = 4000; // ~400 KB of nested portable-text arrays
    const hostile = '5:' + level.repeat(depth) + 'null' + '}]'.repeat(depth) + '\n';
    const started = performance.now();
    const { source, requested } = await run(page(pushes(hostile)));
    expect(performance.now() - started).toBeLessThan(1000);
    expect(requested).toEqual(['https://blog.example.com/post']);
    expect(source.warnings.map(warning => warning.kind)).toEqual(['blocking']);
    expect(source.markdown).toContain('Scaling out therefore');
    const oversized = '<script>self.__next_f.push([1,' + JSON.stringify('9:"' + 'a'.repeat(11 * 1024 * 1024) + '"\n') + '])</script>';
    const huge = await run(page(oversized + pushes(payload)));
    expect(huge.requested).toEqual(['https://blog.example.com/post']);
    expect(huge.source.warnings.map(warning => warning.kind)).toEqual(['blocking']);
  });
  it('never lets javascript: or data: link annotations into the markdown', async () => {
    const unsafe = body.map(item => item._key === 'p2' ? { ...item, markDefs: [{ _key: 'lnk', _type: 'link', href: 'javascript:alert(1)' }, { _key: 'd', _type: 'link', href: 'data:text/html,<script>alert(1)</script>' }],
      children: [...(item as { children: object[] }).children, span(' more', ['d'])] } : item);
    const { source } = await run(page(pushes(payloadOf(unsafe))));
    expect(source.assets).toHaveLength(2);
    expect(source.markdown).toContain('on chip');
    expect(source.markdown).not.toMatch(/javascript:|data:/i);
  });
  it('renders code blocks, keeps GIF originals, and names unknown content blocks in an info warning', async () => {
    const extra = [...body.slice(0, 3),
      { _key: 'c', _type: 'code', language: 'python', code: 'print("wafer")' },
      { _key: 'g', _type: 'image', asset: { _ref: `image-${'3'.repeat(40)}-2000x1000-gif` } },
      { _key: 'x', _type: 'callout', text: 'Remember the fabric.' },
      { _key: 'y', _type: 'spacer' },
      { _key: 'v', _type: 'videoBlock', caption: 'Talk', url: 'https://www.youtube.com/watch?v=abc123XYZ_-' },
      ...body.slice(3)];
    const { source, requested } = await run(page(pushes(payloadOf(extra))));
    expect(source.markdown).toMatch(/```python\nprint\("wafer"\)\n```/);
    expect(requested).toContain(`https://cdn.sanity.io/images/abc123/production/${'3'.repeat(40)}-2000x1000.gif`);
    expect(source.warnings).toEqual([{ kind: 'info', message: expect.stringMatching(/"callout"[\s\S]*https:\/\/blog\.example\.com\/post/) }]);
    expect(source.assets.find(a => a.kind === 'video')).toMatchObject({ alt: 'Talk', video: { provider: 'youtube', embedUrl: 'https://www.youtube-nocookie.com/embed/abc123XYZ_-' } });
    expect(requested.some(url => url.includes('youtube'))).toBe(false);
  });
});
