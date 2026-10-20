import type { Credit } from '../../shared/sources';

/** Credits come from captured pages (or a hand-edited folder), so only http(s) addresses become links. */
export const isWebUrl = (value?: string): value is string => !!value && /^https?:\/\//i.test(value) && URL.canParse(value);

export function CreditLine({ credit }: { credit: Credit }) {
  const { pageTitle, pageUrl, mediaUrl, license, creditLine } = credit;
  return <span className="credit-line">
    <span>From {isWebUrl(pageUrl) ? <a href={pageUrl} target="_blank" rel="noopener noreferrer">{pageTitle || pageUrl}</a> : (pageTitle || pageUrl)}</span>
    {isWebUrl(mediaUrl) && <> · <a href={mediaUrl} target="_blank" rel="noopener noreferrer">original ↗</a></>}
    {license && <> · {isWebUrl(license) ? <a href={license} target="_blank" rel="noopener noreferrer">licence ↗</a> : license}</>}
    {creditLine && <span className="credit-text"> {creditLine}</span>}
  </span>;
}
