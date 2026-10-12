import { BRAND_PATHS } from "./brand-paths";
import type { SocialNetwork } from "@/content/site";

export function SocialIcon({ network, className = "size-5" }: { network: SocialNetwork; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d={BRAND_PATHS[network]} />
    </svg>
  );
}
