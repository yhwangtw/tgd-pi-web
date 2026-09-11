"use client";

import { useMemo } from "react";
import { pendingWorkspaceIdentity, type WorkspaceIdentity } from "@/lib/workspace-identity";
import { fetchJson, useRequestResource } from "./useRequestResource";

interface IdentityResponse {
  identities?: Record<string, WorkspaceIdentity>;
}

const BATCH_SIZE = 128;
const EMPTY_IDENTITIES: Record<string, WorkspaceIdentity> = {};

/**
 * Resolve repo/branch labels in batches for cross-project conversation rows.
 * A basename fallback is returned immediately, then upgraded when Git identity
 * data arrives. The API owns the short-lived cache and process concurrency.
 */
export function useWorkspaceIdentities(cwds: string[], refreshKey = 0): Record<string, WorkspaceIdentity> {
  const uniqueCwds = useMemo(() => [...new Set(cwds.filter(Boolean))].sort(), [cwds]);
  const requestKey = uniqueCwds.join("\u0000");
  const resource = useRequestResource<Record<string, WorkspaceIdentity>>(
    uniqueCwds.length ? `workspace-identities:${refreshKey}:${requestKey}` : null,
    async (signal) => {
      const batches: string[][] = [];
      for (let index = 0; index < uniqueCwds.length; index += BATCH_SIZE) {
        batches.push(uniqueCwds.slice(index, index + BATCH_SIZE));
      }
      const responses = await Promise.all(batches.map((batch) => fetchJson<IdentityResponse>("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwds: batch }),
      }, signal)));
      return Object.assign({}, ...responses.map((response) => response.identities ?? {}));
    },
    { staleTimeMs: 60_000, retries: 1 },
  );
  return useMemo(() => Object.fromEntries(uniqueCwds.map((cwd) => [
    cwd,
    (resource.data ?? EMPTY_IDENTITIES)[cwd]?.sourceCwd === cwd
      ? (resource.data ?? EMPTY_IDENTITIES)[cwd]
      : pendingWorkspaceIdentity(cwd, resource.error ? "unknown" : "loading"),
  ])), [resource.data, resource.error, uniqueCwds]);
}
