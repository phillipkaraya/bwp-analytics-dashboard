// Provider registry (section 1.6): PROVIDERS, getProvider() and the one
// createSession() the panel calls. The panel never touches an SDK type; it
// hands in settings, the loaded dataset and its deps, and gets a ChatSession.
//
// Relative imports only: tsx runs this in Node without the Next alias.

import type { ChatData } from "../data";
import { STATIC_RULES, buildDataCard } from "../system-prompt";
import { TOOL_DEFS } from "../tools/defs";
import type { ChatProvider, ChatSession, ChatSettings, ProviderId, ToolDef, ToolRunner } from "../types";
import { anthropicKeyProvider } from "./anthropic-key";
import { localCliProvider } from "./local-cli";

export const PROVIDERS: readonly ChatProvider[] = [anthropicKeyProvider, localCliProvider];

export function getProvider(id: ProviderId): ChatProvider {
  return PROVIDERS.find((p) => p.id === id) ?? anthropicKeyProvider;
}

export interface SessionDeps {
  /** Read at send time; never captured. settings.getKey in the app. */
  getKey(): string | null;
  /** createToolRunner(data, hooks) from tools/run.ts in the app; a stub in tests. */
  runTool: ToolRunner;
  /** Dev mock or test fetch. Undefined in production. */
  fetch?: typeof fetch;
  /** A provider instance to use instead of the registry entry (the dev mock
   *  builds one with createAnthropicKeyProvider({ fetch })). */
  provider?: ChatProvider;
  /** Defaults to TOOL_DEFS in their fixed order. */
  tools?: ToolDef[];
}

/** Build a session for the provider named in settings. The data card is a
 *  closure over `data`, re-evaluated per send so the provider can detect a
 *  date rollover or a data refresh and rebuild its history. */
export function createSession(settings: ChatSettings, data: ChatData, deps: SessionDeps): ChatSession {
  const provider = deps.provider ?? getProvider(settings.provider);
  return provider.createSession({
    settings,
    getKey: deps.getKey,
    system: { rules: STATIC_RULES, dataCard: () => buildDataCard(data) },
    tools: deps.tools ?? TOOL_DEFS,
    runTool: deps.runTool,
    fetch: deps.fetch,
  });
}
