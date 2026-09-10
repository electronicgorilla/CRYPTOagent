// Anthropic client + one call helper shared by every agent.
//
// Two cost levers are baked in here:
//   1. Prompt caching. Each agent's system prompt (role + rubric) is frozen and
//      cached with a 1h TTL. Caching is a PREFIX match, so the volatile per-token
//      feature JSON must go in the user message - never in `system`, or every
//      request invalidates the cache. Verify with usage.cache_read_input_tokens.
//   2. Structured outputs. `output_config.format` with a JSON schema means no
//      retry loop for malformed JSON, and no wasted prose tokens.
import Anthropic from "@anthropic-ai/sdk";

let _client = null;
function client() {
  // Zero-arg constructor: resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or
  // an `ant auth login` profile. Never hardcode a key.
  if (!_client) _client = new Anthropic();
  return _client;
}

export function available() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

// $ per million tokens. Cache writes bill ~1.25x input, cache reads ~0.1x.
const PRICES = {
  "claude-opus-5": { in: 5, out: 25 },
  "claude-sonnet-5": { in: 2, out: 10 },
  "claude-haiku-4-5": { in: 1, out: 5 },
};

export function costOf(model, usage) {
  const p = PRICES[model] || PRICES["claude-sonnet-5"];
  const inTok = usage?.input_tokens || 0;
  const cacheWrite = usage?.cache_creation_input_tokens || 0;
  const cacheRead = usage?.cache_read_input_tokens || 0;
  const outTok = usage?.output_tokens || 0;
  return (
    (inTok * p.in + cacheWrite * p.in * 1.25 + cacheRead * p.in * 0.1 + outTok * p.out) / 1e6
  );
}

/**
 * Run one agent against one token's data slice.
 * Returns { ok, output, usage, cost, model, ms } or { ok: false, error }.
 */
export async function runAgent(agent, payload) {
  const t0 = Date.now();
  try {
    const res = await client().messages.create({
      model: agent.model,
      max_tokens: 4000,
      // Frozen prefix -> cached. 1h TTL keeps it warm across 5-minute scans.
      system: [
        { type: "text", text: agent.system, cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
      output_config: {
        effort: agent.effort,
        format: { type: "json_schema", schema: agent.schema },
      },
      // Volatile content last, after the cache breakpoint.
      messages: [{ role: "user", content: JSON.stringify(payload) }],
    });

    if (res.stop_reason === "refusal") {
      return { ok: false, error: `refusal: ${res.stop_details?.category ?? "unknown"}`, model: agent.model };
    }

    const text = res.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("");
    let output;
    try {
      output = JSON.parse(text);
    } catch {
      return { ok: false, error: "unparseable output", model: agent.model };
    }

    return {
      ok: true,
      output,
      usage: res.usage,
      cost: costOf(agent.model, res.usage),
      cacheHit: (res.usage?.cache_read_input_tokens || 0) > 0,
      model: agent.model,
      ms: Date.now() - t0,
    };
  } catch (e) {
    // Typed classes, most specific first - never string-match error messages.
    let error;
    if (e instanceof Anthropic.AuthenticationError) error = "auth failed - check ANTHROPIC_API_KEY";
    else if (e instanceof Anthropic.RateLimitError) error = "rate limited";
    else if (e instanceof Anthropic.BadRequestError) error = `bad request: ${e.message}`;
    else if (e instanceof Anthropic.APIError) error = `api error ${e.status}: ${e.message}`;
    else error = e.message;
    return { ok: false, error, model: agent.model, ms: Date.now() - t0 };
  }
}
