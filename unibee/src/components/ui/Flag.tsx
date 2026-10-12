/** Tiny inline flags (emoji flags don't render on Windows). */
export function Flag({ country, className = "h-3.5 w-5" }: { country: "bd" | "lt"; className?: string }) {
  if (country === "bd") {
    return (
      <svg viewBox="0 0 20 12" className={`${className} shrink-0 rounded-[2px]`} aria-hidden="true">
        <rect width="20" height="12" fill="#006a4e" />
        <circle cx="9" cy="6" r="4" fill="#f42a41" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 20 12" className={`${className} shrink-0 rounded-[2px]`} aria-hidden="true">
      <rect width="20" height="4" fill="#fdb913" />
      <rect y="4" width="20" height="4" fill="#006a44" />
      <rect y="8" width="20" height="4" fill="#c1272d" />
    </svg>
  );
}
