import { ConvexError } from "convex/values";

/**
 * OpenRouter chat client, shared by every AI action.
 *
 * Lives server-side because the API key must never reach the renderer:
 * Vellum ships as a web app *and* an Electron bundle, so anything inlined
 * at build time (a `VITE_*` variable) is readable in DevTools by every user.
 * The key is a Convex environment variable instead — see AI setup in
 * CLAUDE.md. `fetch` exists in the default Convex runtime, so no "use node".
 */

/**
 * The model, and the OpenRouter **guardrail** on the key that permits it,
 * are a matched pair: ask for a slug the guardrail doesn't allow and every
 * call 404s with "No endpoints available matching your guardrail
 * restrictions". A `:free` suffix is part of the slug's identity — the free
 * and paid variants of one model are two different, separately-allowlisted
 * strings.
 *
 * That pairing has taken AI down twice, because the allowlist changes in a
 * dashboard while the slug lived in code, so a model switch needed a deploy
 * to stay in step. It is an environment variable now: changing models is
 * `npx convex env set OPENROUTER_MODEL <slug> --prod`, with no code change
 * and no deploy. `DEFAULT_MODEL` is only the fallback when it is unset.
 */
const DEFAULT_MODEL = "google/gemini-2.5-flash-lite";

export function aiModel(): string {
  return process.env.OPENROUTER_MODEL || DEFAULT_MODEL;
}

/**
 * Optional provider pin, comma-separated, e.g. "Google AI Studio".
 *
 * OpenRouter load-balances one model across several upstream providers, and
 * they are *not* interchangeable: some apply PII de-identification that
 * rewrites real names to "[PERSON_NAME]" mid-document. In a notes app that
 * silently corrupts what the user wrote, so the provider has to be
 * pinnable. Unset means OpenRouter picks, which is fine for models whose
 * providers all behave.
 */
function providerRouting(): Record<string, unknown> | undefined {
  const pin = process.env.OPENROUTER_PROVIDER?.trim();
  if (!pin) return undefined;
  return {
    order: pin.split(",").map((s) => s.trim()).filter(Boolean),
    // Pinning is a correctness constraint here, not a preference: falling
    // back to a redacting provider is worse than failing loudly.
    allow_fallbacks: false,
  };
}

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/** One request's ceiling. Context is generous (262K) but the free tier is
 *  slow, and a runaway generation would sit on the action's time budget. */
const MAX_OUTPUT_TOKENS = 2000;
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * The free tier allows 20 requests/minute. A burst (autofilling a database
 * column, say) will hit that, and OpenRouter answers 429 with `Retry-After`.
 * Three attempts covers a transient burst without letting one call sit for
 * minutes — the caller sees a clean error and can retry.
 */
const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 1500;

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

function apiKey(): string {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    throw new ConvexError(
      "AI is not configured. Set OPENROUTER_API_KEY with " +
        "`npx convex env set OPENROUTER_API_KEY <key>` (add --prod for the " +
        "live deployment).",
    );
  }
  return key;
}

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Turn a failed response into a message worth showing a user. OpenRouter
 * overloads 404 for "model not on your guardrail allowlist", which reads as
 * a bug rather than a config problem unless it's spelled out.
 */
async function describeFailure(res: Response): Promise<string> {
  let detail = "";
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    detail = body?.error?.message ?? "";
  } catch {
    // Non-JSON error body (a proxy's HTML 502, say) — status alone will do.
  }
  if (res.status === 401) {
    return "OpenRouter rejected the API key. Check OPENROUTER_API_KEY.";
  }
  if (res.status === 402) {
    return "OpenRouter reports insufficient credits for this request.";
  }
  if (res.status === 404 && /guardrail|data policy/i.test(detail)) {
    return (
      `The API key's guardrail does not allow "${aiModel()}". Either add ` +
      "that exact slug (suffix included) to the key's model allowlist, or " +
      "point OPENROUTER_MODEL at a slug the guardrail already permits."
    );
  }
  if (res.status === 429) {
    return "AI rate limit reached (20 requests/minute on the free tier). Try again shortly.";
  }
  return detail || `AI request failed (HTTP ${res.status}).`;
}

/**
 * Send a chat completion and return the assistant's text.
 *
 * Nemotron is a reasoning model: responses carry `reasoning` and
 * `reasoning_details` alongside `content`, and reasoning tokens dominate the
 * completion count on short answers. Only `content` is returned here — the
 * scratchpad must never reach the UI.
 */
export async function chat(
  messages: ChatMessage[],
  opts: { maxTokens?: number } = {},
): Promise<string> {
  const key = apiKey();
  let lastError = "AI request failed.";

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          // OpenRouter attributes traffic with these; both are optional but
          // keep this app identifiable in the dashboard's usage breakdown.
          "HTTP-Referer": "https://vellum-gilt.vercel.app",
          "X-Title": "Vellum",
        },
        body: JSON.stringify({
          model: aiModel(),
          messages,
          max_tokens: opts.maxTokens ?? MAX_OUTPUT_TOKENS,
          temperature: 0.3,
          ...(providerRouting() ? { provider: providerRouting() } : {}),
        }),
      });

      if (res.ok) {
        const body = (await res.json()) as {
          choices?: { message?: { content?: string } }[];
        };
        const text = body.choices?.[0]?.message?.content?.trim();
        if (!text) {
          // A reasoning model can spend its whole budget thinking and return
          // empty content. Retrying is pointless; say so plainly.
          throw new ConvexError(
            "The model returned an empty response. Try a shorter selection.",
          );
        }
        return text;
      }

      lastError = await describeFailure(res);

      // 4xx other than 429 is a configuration problem — retrying just burns
      // the rate limit against a request that will never succeed.
      if (res.status !== 429 && res.status < 500) {
        throw new ConvexError(lastError);
      }

      if (attempt < MAX_ATTEMPTS - 1) {
        const retryAfter = Number(res.headers.get("Retry-After"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? retryAfter * 1000
          : BASE_BACKOFF_MS * 2 ** attempt;
        await sleep(wait);
      }
    } catch (err) {
      // ConvexError is our own deliberate signal — never swallow it into a
      // retry, or a misconfigured key would look like a network blip.
      if (err instanceof ConvexError) throw err;
      lastError =
        err instanceof Error && err.name === "AbortError"
          ? "The AI request timed out."
          : "Could not reach OpenRouter.";
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(BASE_BACKOFF_MS * 2 ** attempt);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw new ConvexError(lastError);
}
