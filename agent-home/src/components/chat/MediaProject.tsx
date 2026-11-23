"use client";

import { createContext, useContext } from "react";

/** The project whose group chat the media on screen was attached in. */
export const MediaProjectContext = createContext<string | undefined>(undefined);

export function useMediaProject(): string | undefined {
  return useContext(MediaProjectContext);
}
