"use client";

import { Play } from "lucide-react";
import { useState } from "react";
import { Logo } from "@/components/brand/Logo";

/** Extracts a YouTube ID from an ID or any youtube.com / youtu.be link. */
export function youtubeId(input: string): string | null {
  const s = input.trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:youtu\.be\/|v=|embed\/|shorts\/)([\w-]{11})/);
  return m ? m[1] : null;
}

/**
 * Shows a thumbnail first and only loads the YouTube player after a click,
 * so the page stays fast on mobile data.
 */
export function VideoFacade({ youtube, title }: { youtube: string; title: string }) {
  const id = youtubeId(youtube);
  const [playing, setPlaying] = useState(false);
  const [missing, setMissing] = useState(false);

  if (playing && id) {
    return (
      <iframe
        className="absolute inset-0 size-full"
        src={`https://www.youtube-nocookie.com/embed/${id}?autoplay=1&rel=0&modestbranding=1`}
        title={title}
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
        allowFullScreen
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => (id ? setPlaying(true) : setMissing(true))}
      className="group absolute inset-0 grid size-full place-items-center overflow-hidden bg-night text-white"
      aria-label={`Play video: ${title}`}
    >
      {id ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={`https://i.ytimg.com/vi/${id}/hqdefault.jpg`} alt="" loading="lazy" className="absolute inset-0 size-full object-cover opacity-80 transition duration-500 group-hover:scale-[1.03]" />
      ) : (
        <span className="absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,#e02424_0%,#18181b_60%)]" aria-hidden="true">
          <Logo className="absolute bottom-6 left-6 h-6 w-auto text-white/70" />
        </span>
      )}
      <span className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" aria-hidden="true" />
      <span className="relative flex flex-col items-center gap-4">
        <span className="grid size-20 place-items-center rounded-full bg-brand shadow-[0_10px_40px_rgba(255,51,51,0.45)] ring-8 ring-white/15 transition group-hover:scale-105">
          <Play className="ml-1 size-8 fill-white" aria-hidden="true" />
        </span>
        <span className="px-6 text-center text-[15px] font-medium text-white/90">
          {missing ? "Sample class video coming soon. UniBee will add the YouTube link." : "Play sample class"}
        </span>
      </span>
    </button>
  );
}
