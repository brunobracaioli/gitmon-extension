/**
 * Client-side LLM caller for the GitMon browser extension.
 *
 * Ported from `src/lib/world/llm-client.ts` to keep the extension bundle
 * fully self-contained (no cross imports from the Next.js app). Kept
 * byte-identical in behavior so fallback semantics stay consistent with
 * the world canvas.
 *
 * SECURITY: the API key is sent directly to the LLM provider from the
 * content script's origin. It never round-trips through the GitMon
 * backend. The key comes from `gitmon_ai_config.llm_api_key_encrypted`
 * (plaintext today) via the `/api/extension/ai-config` authenticated
 * endpoint and is cached in `chrome.storage.local`.
 */

export type LLMProvider = "anthropic" | "openai";

export interface LLMConfig {
  provider: LLMProvider;
  apiKey: string;
  model: string;
  maxTokens: number;
}

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMResult {
  ok: boolean;
  content: string;
  tokens: number;
  error?: string;
}

const DEFAULT_MODELS: Record<LLMProvider, string> = {
  anthropic: "claude-haiku-4-5-20251001",
  openai: "gpt-4o-mini",
};

/**
 * Make a single LLM completion call. **Never rejects** — all network and
 * API errors are captured and returned as `{ ok: false, error }`.
 */
export async function callExtLLM(
  config: LLMConfig,
  systemPrompt: string,
  userMessage: string,
): Promise<LLMResult> {
  const model = config.model || DEFAULT_MODELS[config.provider];
  const messages: LLMMessage[] = [{ role: "user", content: userMessage }];

  try {
    if (config.provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: JSON.stringify({
          model,
          max_tokens: config.maxTokens,
          system: systemPrompt,
          messages,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!data || data.error) {
        return {
          ok: false,
          content: "",
          tokens: 0,
          error: data?.error?.message ?? `HTTP ${res.status}`,
        };
      }
      return {
        ok: true,
        content: data.content?.[0]?.text ?? "...",
        tokens: data.usage?.output_tokens ?? 0,
      };
    }

    // openai
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_tokens: config.maxTokens,
        messages: [{ role: "system", content: systemPrompt }, ...messages],
      }),
    });
    const data = await res.json().catch(() => null);
    if (!data || data.error) {
      return {
        ok: false,
        content: "",
        tokens: 0,
        error: data?.error?.message ?? `HTTP ${res.status}`,
      };
    }
    return {
      ok: true,
      content: data.choices?.[0]?.message?.content ?? "...",
      tokens: data.usage?.completion_tokens ?? 0,
    };
  } catch (err) {
    return {
      ok: false,
      content: "",
      tokens: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
