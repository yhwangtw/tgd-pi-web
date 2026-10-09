import { createModels } from "@earendil-works/pi-ai-durable/models";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { HarnessOptions } from "@earendil-works/pi-durable";

/** Keep the coding agent's credential/OAuth resolution and custom endpoints.
 * The alias pins Durable's new model API without upgrading the chat runtime.
 */
export function durableModels(runtime: ModelRuntime): HarnessOptions["models"] {
  const models = createModels();
  // These pinned versions share the chat wire contract, but separate package
  // copies have nominal transcript symbols and private stream class members.
  // Requests still enter ModelRuntime for normalization and credential lookup.
  for (const provider of runtime.getProviders()) {
    models.setProvider(provider as unknown as Parameters<typeof models.setProvider>[0]);
  }
  Object.assign(models, {
    stream: runtime.stream.bind(runtime),
    streamSimple: runtime.streamSimple.bind(runtime),
    complete: runtime.complete.bind(runtime),
    completeSimple: runtime.completeSimple.bind(runtime),
    streamDeferred: runtime.streamDeferred.bind(runtime),
    fetchDeferred: runtime.fetchDeferred.bind(runtime),
    cancelDeferred: runtime.cancelDeferred.bind(runtime),
  });
  return models as unknown as HarnessOptions["models"];
}
