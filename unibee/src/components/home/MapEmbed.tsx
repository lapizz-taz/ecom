"use client";

import { MapPin } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useContent } from "@/components/content/ContentProvider";
import { mapsEmbedUrl, mapsUrl } from "@/lib/content/helpers";

/** Google Map that only loads when scrolled near, keeping the page fast on mobile data. */
export function MapEmbed() {
  const ref = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);
  const content = useContent();
  useEffect(() => {
    const el = ref.current;
    if (!el || !("IntersectionObserver" in window)) return setShow(true);
    const io = new IntersectionObserver(([e]) => e.isIntersecting && (setShow(true), io.disconnect()), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className="relative h-full min-h-[320px] w-full">
      <a href={mapsUrl(content)} target="_blank" rel="noopener noreferrer" className="absolute inset-0 grid place-items-center text-center text-[15px] text-muted">
        <span className="flex flex-col items-center gap-2">
          <MapPin className="size-8 text-brand-dark" aria-hidden="true" />
          Open the map in Google Maps
        </span>
      </a>
      {show && (
        <iframe
          title={`Map showing the UniBee office: ${content.contact.address}`}
          src={mapsEmbedUrl(content)}
          className="absolute inset-0 size-full border-0"
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          allowFullScreen
        />
      )}
    </div>
  );
}
