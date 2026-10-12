"use client";

import { MapPin } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { mapsEmbedUrl, mapsUrl, site } from "@/content/site";

/** Google Map that only loads when scrolled near, keeping the page fast on mobile data. */
export function MapEmbed() {
  const ref = useRef<HTMLDivElement>(null);
  const [show, setShow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || !("IntersectionObserver" in window)) return setShow(true);
    const io = new IntersectionObserver(([e]) => e.isIntersecting && (setShow(true), io.disconnect()), { rootMargin: "300px" });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <div ref={ref} className="relative h-full min-h-[320px] w-full">
      <a href={mapsUrl} target="_blank" rel="noopener noreferrer" className="absolute inset-0 grid place-items-center text-center text-[15px] text-muted">
        <span className="flex flex-col items-center gap-2">
          <MapPin className="size-8 text-brand-dark" aria-hidden="true" />
          Open the map in Google Maps
        </span>
      </a>
      {show && (
        <iframe
          title={`Map showing the UniBee office: ${site.contact.address}`}
          src={mapsEmbedUrl}
          className="absolute inset-0 size-full border-0"
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          allowFullScreen
        />
      )}
    </div>
  );
}
