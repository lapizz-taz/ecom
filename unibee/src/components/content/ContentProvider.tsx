"use client";

import { createContext, useContext, type ReactNode } from "react";
import { defaultContent } from "@/lib/content/defaults";
import type { SiteContent } from "@/lib/content/types";

const ContentContext = createContext<SiteContent>(defaultContent);

/** Makes the CMS content available to interactive (client) components. */
export function ContentProvider({ content, children }: { content: SiteContent; children: ReactNode }) {
  return <ContentContext.Provider value={content}>{children}</ContentContext.Provider>;
}

export const useContent = () => useContext(ContentContext);
