import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';

export function Markdown({ children }: { children: string }) {
  return <div className="prose"><ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[[rehypeKatex, { strict: false, trust: false }]]}
    skipHtml components={{
      a: ({ href, children }) => <a href={href && /^https?:\/\//i.test(href) ? href : undefined} target="_blank" rel="noopener noreferrer">{children}</a>,
      img: ({ alt }) => <span className="inline-image-notice">[Image: {alt || 'unlabeled'}. Attach it as a lesson figure to display it.]</span>,
      table: ({ children }) => <div className="table-scroll"><table>{children}</table></div>,
    }}>{children}</ReactMarkdown></div>;
}
