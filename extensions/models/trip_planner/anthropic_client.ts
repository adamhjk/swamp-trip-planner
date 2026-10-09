/**
 * Minimal Anthropic Messages API client shared by the trip-planner behaviors.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** A fetch-compatible function, injectable for tests. */
export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

/** Token usage in the shape every trip-planner resource records. */
export const UsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
});

/** Token usage reported for one Claude call. */
export type Usage = z.infer<typeof UsageSchema>;

const MessagesResponseSchema = z.object({
  content: z.array(
    z.object({ type: z.string(), text: z.string().optional() }).passthrough(),
  ),
  stop_reason: z.string().nullable().optional(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative().default(0),
    output_tokens: z.number().int().nonnegative().default(0),
  }).passthrough().optional(),
});

/** Options for a single Messages API call. */
export interface CallClaudeOptions {
  apiKey: string;
  model: string;
  maxTokens: number;
  system?: string;
  prompt: string;
  /** JSON schema to constrain the response with structured outputs. */
  jsonSchema?: Record<string, unknown>;
  timeoutMs: number;
  fetch?: FetchLike;
}

/** The text Claude returned plus what it cost. */
export interface ClaudeResult {
  text: string;
  usage: Usage;
}

/**
 * Sends one user message to Claude and returns the concatenated text.
 * Throws on HTTP errors, refusals, and truncated output so a failed call
 * never persists partial data.
 */
export async function callClaude(
  opts: CallClaudeOptions,
): Promise<ClaudeResult> {
  const doFetch = opts.fetch ?? fetch;
  const response = await doFetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // Keys pasted into a vault often carry a trailing newline, which is
      // not a legal header value.
      "x-api-key": opts.apiKey.trim(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: opts.model,
      max_tokens: opts.maxTokens,
      messages: [{ role: "user", content: opts.prompt }],
      ...(opts.system ? { system: opts.system } : {}),
      ...(opts.jsonSchema
        ? {
          output_config: {
            format: { type: "json_schema", schema: opts.jsonSchema },
          },
        }
        : {}),
    }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });

  if (!response.ok) {
    const body = (await response.text().catch(() => "")).slice(0, 2000);
    throw new Error(
      `Anthropic Messages API failed with HTTP ${response.status}${
        body ? `: ${body}` : ""
      }`,
    );
  }

  const parsed = MessagesResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error(
      `Anthropic Messages API returned an invalid response: ${parsed.error.message}`,
    );
  }
  const { content, stop_reason, usage } = parsed.data;
  if (stop_reason === "refusal") {
    throw new Error("Claude declined the request (stop_reason: refusal)");
  }
  if (stop_reason === "max_tokens") {
    throw new Error(
      `Claude hit max_tokens (${opts.maxTokens}) before finishing; raise maxTokens`,
    );
  }
  const text = content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
  if (!text) {
    throw new Error("Anthropic Messages API response contained no text");
  }

  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  return {
    text,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
  };
}
