/**
 * Typed access to universities.json.
 * To add/remove a university, edit universities.json only (see README).
 */
import data from "./universities.json";

export type University = {
  slug: string;
  name: string;
  shortName: string;
  city: string;
  /** Path to a logo in /public, e.g. "/universities/vu.svg". Leave "" to show a placeholder monogram. */
  logo: string;
  /** Accent colour used for the placeholder monogram. */
  color: string;
  about: string;
  programs: { bachelor: string[]; master: string[] };
  tuition: string;
  intakes: string[];
  requirements: { academic: string; english: string };
  deadline: string;
  website: string;
  /** true until you confirm the details. Shows a "details to be confirmed" note. */
  placeholder?: boolean;
};

export const universities = data as University[];

export const findUniversity = (slug: string) => universities.find((u) => u.slug === slug);
