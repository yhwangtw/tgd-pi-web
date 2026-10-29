"use client";
import { useState } from "react";

/** Explicit navigation opens a disclosure once; subsequent user toggles win. */
export function useRequestedDisclosure(request?: number) {
  const [state, setState] = useState({ open: !!request, handled: request });
  if (request !== undefined && request !== state.handled) setState({ open: true, handled: request });
  return [state.open, (value: boolean | ((current: boolean) => boolean)) => setState(previous => ({
    ...previous, open: typeof value === "function" ? value(previous.open) : value,
  }))] as const;
}
