/** The same valid actions drive both Pi engines' management dialogs. */
export function goalActions(status: string): string[] {
  return ["status", ...(status === "active" ? ["pause"] : status === "paused" || status === "blocked" ? ["resume"] : []), "clear"];
}
export function planActions(status: string): string[] {
  return ["status", ...(status === "ready" ? ["execute"] : []), ...(status === "complete" ? ["new"] : []), ...(status !== "executing" ? ["refine"] : []), "exit"];
}
