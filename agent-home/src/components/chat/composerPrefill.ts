"use client";

import { createContext, useContext } from "react";

/**
 * Lets something rendered inside a chat message (a picked option card) put
 * text in that chat's composer. Null where no composer takes it.
 */
export const ComposerPrefillContext = createContext<((text: string) => void) | null>(null);

export function useComposerPrefill(): ((text: string) => void) | null {
  return useContext(ComposerPrefillContext);
}
