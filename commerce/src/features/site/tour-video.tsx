import { Play } from 'lucide-react'
import { useRef, useState } from 'react'
import { cn } from '@/lib/utils'

const SOURCES = [['/media/fullfilio-tour.mp4', 'video/mp4'], ['/media/fullfilio-tour.webm', 'video/webm']] as const
const POSTER = '/media/fullfilio-tour.jpg'

/** The 30-second product tour: a poster with a play button; plays with sound on click. */
export function TourVideo({ className }: { className?: string }) {
  const video = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [failed, setFailed] = useState(false)

  const play = () => {
    setPlaying(true)
    // Started by the click, so the browser lets it play with sound.
    void video.current?.play().catch(() => setFailed(true))
  }

  return (
    <div className={cn('relative overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0f1011] shadow-[0_30px_80px_-20px_rgb(0_0_0/.8)]', className)}>
      {/* MP4 for Safari and most browsers, WebM where H.264 is missing. */}
      <video ref={video} poster={POSTER} preload="none" playsInline controls={playing} onEnded={() => setPlaying(false)}
        className="aspect-video w-full bg-[#eef2fb] object-cover" aria-label="Fullfilio product tour">
        {SOURCES.map(([src, type], i) => <source key={src} src={src} type={type} onError={i === SOURCES.length - 1 ? () => setFailed(true) : undefined} />)}
      </video>
      {!playing && (
        <button type="button" onClick={play} className="group absolute inset-0 grid place-items-center bg-black/10 transition-colors hover:bg-black/0" aria-label="Play the product tour">
          <span className="flex items-center gap-2 rounded-full bg-[#08090a]/85 py-2.5 pr-5 pl-3 text-sm font-medium text-white shadow-2xl ring-1 ring-white/15 backdrop-blur transition-transform group-hover:scale-105">
            <span className="grid size-8 place-items-center rounded-full bg-[#2142e7]"><Play className="size-3.5 translate-x-px fill-current" /></span>
            Watch the tour · 0:32
          </span>
        </button>
      )}
      {failed && <p className="absolute inset-x-0 bottom-0 bg-black/70 p-2 text-center text-xs text-white">The video could not be played here. <a href={SOURCES[0][0]} className="underline">Open it directly</a>.</p>}
    </div>
  )
}
