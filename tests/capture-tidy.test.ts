import { describe, expect, it } from 'vitest';
import { captureArticle } from '../server/capture';
import { withoutTracking } from '../server/capture-tidy';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEklEQVR4nGP4z8DAwMDAxMAAAA0eAQOTLSkPAAAAAElFTkSuQmCC', 'base64');
const capture = (html: string, url = 'https://blog.example.com/post?utm_source=chatgpt.com') =>
  captureArticle(url, async u => u === url ? { bytes: Buffer.from(html), type: 'text/html', url } : { bytes: png, type: 'image/png', url: u });
const body = (count: number) => Array.from({ length: count }, (_v, i) => `<p>Paragraph ${i + 1} explains how the accelerator streams weights from memory into its compute tiles.</p>`).join('');

describe('article tidying', () => {
  it('keeps only the article from a WordPress-style page: no breadcrumbs, language picker, share bar, AI summary, tags, bios, comments or related posts', async () => {
    const html = `<main><div class="post-card"><span class="category-name"><a href="/blog/category/robotics/">Robotics</a></span>
      <div class="language-switcher"><a href="/en">English</a><a href="/ko">한국어</a></div>
      <h1>Inside the accelerator</h1><a href="#entry-content-comments">Discuss (0)</a>
      <ul class="post-tools"><li><a href="https://twitter.com/intent/tweet?url=x">T</a></li><li><a href="https://www.facebook.com/sharer/sharer.php?u=x">F</a></li><li>E</li></ul></div>
      <details class="nv-ai-summary"><summary><h2>AI-Generated Summary</h2></summary><ul><li>A machine-written recap.</li></ul><h3>Next Steps</h3><p>Buy the kit.</p></details>
      <div class="entry-content">${body(4)}<h2>How it works<a class="heading-anchor-link" href="#how"><i class="fas fa-link"></i></a></h2>${body(3)}
        <figure><img src="/chart.png" alt="Throughput chart" width="1200" height="600"><figcaption>Throughput by batch size.</figcaption></figure>
        <p>See the <a href="https://docs.example.com/guide?utm_source=newsletter&amp;utm_medium=email&amp;page=2">guide</a>.</p></div>
      <div class="tags"><div class="caption">Tags</div><a href="/tag/chips">Chips</a></div>
      <div class="post-authors-list"><h2>About the Authors</h2><img class="avatar avatar-131" alt="Avatar photo" src="/a.png" width="131" height="131"><p>Jane writes about chips.</p></div>
      <div id="entry-content-comments"><h2>Comments</h2></div>
      <section><div class="title"><h2>Related content</h2></div><div class="grid"><a href="/other">Read more</a></div></section></main>`;
    const { source } = await capture(html);
    expect(source.url).toBe('https://blog.example.com/post');
    expect(source.markdown.startsWith('Paragraph 1 explains')).toBe(true);
    expect(source.markdown).toContain('## How it works\n');
    expect(source.markdown).toContain('https://docs.example.com/guide?page=2');
    for (const junk of ['Robotics', 'English', 'Discuss', 'twitter.com', 'AI-Generated', 'Buy the kit', 'Tags', 'Chips', 'About the Authors', 'Jane writes', 'Comments', 'Related content', 'Read more', 'utm_', 'heading-anchor', '](#how)'])
      expect(source.markdown, junk).not.toContain(junk);
    expect(source.assets.map(asset => asset.alt)).toEqual(['Throughput chart']);
  });
  it('removes chrome sections on a plain page without a marked body, but keeps the article intact', async () => {
    const html = `<article><nav class="breadcrumbs"><a href="/">Home</a> › <a href="/blog">Blog</a></nav><h1>Plain page</h1>${body(5)}
      <h2>Results</h2>${body(2)}<h2>Share this post</h2><ul><li><a href="https://www.linkedin.com/sharing/share-offsite/?url=x">LinkedIn</a></li></ul>
      <h2>Leave a Reply</h2><p>You must be logged in to post a comment.</p></article>`;
    const { source } = await capture(html);
    expect(source.markdown).toContain('# Plain page');
    expect(source.markdown).toContain('## Results');
    expect(source.markdown.match(/Paragraph \d/g)).toHaveLength(7);
    for (const junk of ['Home', 'Share this post', 'LinkedIn', 'Leave a Reply', 'logged in']) expect(source.markdown, junk).not.toContain(junk);
  });
  it('never removes a wrapper that holds most of the article, whatever its class name says', async () => {
    const html = `<article class="post has-comments social-ready"><div class="related-wrapper"><h1>Wrapped</h1>${body(6)}</div></article>`;
    const { source } = await capture(html);
    expect(source.markdown).toContain('# Wrapped');
    expect(source.markdown.match(/Paragraph \d/g)).toHaveLength(6);
  });
  it('strips only tracking parameters from links', () => {
    expect(withoutTracking('https://a.example/x?utm_source=chatgpt.com&id=7&fbclid=abc#part')).toBe('https://a.example/x?id=7#part');
    expect(withoutTracking('/relative?gclid=1', 'https://a.example/post')).toBe('https://a.example/relative');
    expect(withoutTracking('not a url')).toBe('not a url');
  });
});
