import { useEffect, useRef } from 'react';
import type { VideoRef } from '../../shared/sources';
import { isWebUrl } from './CreditLine';

/** The only places an embed may load from; the server checks the same rule when a lesson is saved. */
function embeddable(video: VideoRef) {
  if (!URL.canParse(video.embedUrl)) return false;
  const url = new URL(video.embedUrl);
  if (url.protocol !== 'https:') return false;
  return video.provider === 'youtube' ? url.hostname === 'www.youtube-nocookie.com'
    : video.provider === 'vimeo' ? url.hostname === 'player.vimeo.com' : video.embedUrl === video.url;
}

/** Streams a video from its source. Nothing is downloaded or autoplayed; starting it calls `onPlay` so narration can pause. */
export function VideoEmbed({ video, title, poster, onPlay }: { video: VideoRef; title: string; poster?: string; onPlay: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const play = useRef(onPlay); play.current = onPlay;
  useEffect(() => {
    // A page inside an iframe cannot be listened to, but pressing its play button moves focus into it.
    const onBlur = () => { if (frame.current && document.activeElement === frame.current) play.current(); };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);
  const ok = embeddable(video);
  return <div className="video-embed">
    {ok && video.provider !== 'file' && <iframe ref={frame} className="video-frame" src={video.embedUrl} title={title} loading="lazy" allow="encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" />}
    {ok && video.provider === 'file' && <video className="video-frame" src={video.embedUrl} controls preload="none" poster={poster} aria-label={title} onPlay={() => onPlay()} />}
    {isWebUrl(video.url) && <a className="text-link" href={video.url} target="_blank" rel="noopener noreferrer">Watch at the source ↗</a>}
  </div>;
}
