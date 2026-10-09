/**
 * Anthropic behavior for the trip planner: one `extract` method that turns a
 * plain-English trip request into a structured `requirements` resource the
 * rest of the workflow can wire to. It is the trip planner's only LLM call.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { callClaude, type FetchLike, UsageSchema } from "./anthropic_client.ts";

const REQUEST_TIMEOUT_MS = 120_000;
// Hotels may use at most this share of the budget when deriving the nightly
// price cap passed to hotel search. It only narrows the search; the itinerary
// behavior's pick enforces the real budget.
const HOTEL_BUDGET_SHARE = 0.6;

const PRIORITIES = ["budget", "balanced", "comfort"] as const;
const CABINS = ["economy", "premium_economy", "business", "first"] as const;

const GlobalArgsSchema = z.object({
  apiKey: z.string().min(1).meta({ sensitive: true }).describe(
    "Anthropic API key.",
  ),
  model: z.string().min(1).default("claude-haiku-4-5").describe(
    "Claude model that extracts the requirements.",
  ),
  maxTokens: z.number().int().positive().default(2048).describe(
    "Maximum tokens for the extracted requirements.",
  ),
});

const ExtractArgsSchema = z.object({
  request: z.string().min(1).describe(
    'The trip request in plain English, e.g. "plan a trip to japan".',
  ),
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/).default("latest")
    .describe("Suffix for the stored requirements instance."),
});

/** What Claude is asked to fill in; derived fields are computed in code. */
const ExtractedSchema = z.object({
  originCity: z.string(),
  originAirports: z.string(),
  destinationCountry: z.string(),
  destinationCity: z.string(),
  destinationAirports: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  travelers: z.number().int(),
  budgetUsd: z.number(),
  priority: z.enum(PRIORITIES),
  cabin: z.enum(CABINS),
  interests: z.array(z.string()),
  assumptions: z.array(z.string()),
});

type Extracted = z.infer<typeof ExtractedSchema>;

const EXTRACT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: Object.keys(ExtractedSchema.shape),
  properties: {
    originCity: {
      type: "string",
      description:
        "City the traveler departs from; empty string if not stated.",
    },
    originAirports: {
      type: "string",
      description:
        "Comma-separated IATA codes for the origin city (e.g. SFO or JFK,EWR,LGA); empty string if origin not stated.",
    },
    destinationCountry: { type: "string" },
    destinationCity: {
      type: "string",
      description:
        "The single main city to stay in. If only a country is given, choose its most popular city for visitors.",
    },
    destinationAirports: {
      type: "string",
      description:
        "Comma-separated IATA codes serving destinationCity (e.g. HND,NRT).",
    },
    startDate: { type: "string", description: "YYYY-MM-DD departure date." },
    endDate: { type: "string", description: "YYYY-MM-DD return date." },
    travelers: {
      type: "integer",
      description: "Number of adults; 1 if unstated.",
    },
    budgetUsd: {
      type: "number",
      description: "Total trip budget in USD; 0 if not stated.",
    },
    priority: {
      type: "string",
      enum: [...PRIORITIES],
      description:
        "budget if they stress cheapness, comfort if they stress comfort/luxury, otherwise balanced.",
    },
    cabin: {
      type: "string",
      enum: [...CABINS],
      description: "Flight cabin; economy unless they ask otherwise.",
    },
    interests: {
      type: "array",
      items: { type: "string" },
      description:
        "Activities or themes they mention (food, temples, hiking...).",
    },
    assumptions: {
      type: "array",
      items: { type: "string" },
      description:
        "Every value you inferred rather than read from the request.",
    },
  },
} as const;

const SYSTEM_PROMPT =
  `You extract structured trip requirements from a traveler's request.
Read only what the request says. When a value is not stated:
- origin and budget: leave empty / 0. Never guess these.
- dates: if a month or season is given, pick dates in its next occurrence; if only a length is given, start about 30 days from today; if nothing is given, plan 7 nights starting about 30 days from today.
- destination city: if only a country is given, use its most visited city.
Record every inferred value in assumptions.`;

const RequirementsSchema = ExtractedSchema.extend({
  request: z.string(),
  nights: z.number().int(),
  rooms: z.number().int(),
  hotelNightlyCapUsd: z.number(),
  missing: z.array(z.string()),
  model: z.string(),
  usage: UsageSchema,
  extractedAt: z.iso.datetime(),
});

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Computes nights, rooms, the hotel price cap, and anything the workflow
 * needs that the request left out. Pure so it can be tested directly.
 */
export function deriveRequirements(
  extracted: Extracted,
  today: string,
): {
  nights: number;
  rooms: number;
  hotelNightlyCapUsd: number;
  missing: string[];
} {
  const missing: string[] = [];
  if (!extracted.originAirports.trim()) {
    missing.push('origin (e.g. "from SFO")');
  }
  if (!(extracted.budgetUsd > 0)) missing.push('budget (e.g. "$4000")');
  if (!extracted.destinationAirports.trim()) {
    missing.push("destination airport");
  }

  let nights = 0;
  if (!DATE_RE.test(extracted.startDate) || !DATE_RE.test(extracted.endDate)) {
    missing.push("valid travel dates");
  } else {
    nights = Math.round(
      (Date.parse(extracted.endDate) - Date.parse(extracted.startDate)) /
        86_400_000,
    );
    if (!(nights > 0)) missing.push("an end date after the start date");
    if (extracted.startDate <= today) {
      missing.push("a start date in the future");
    }
  }

  const travelers = Math.max(1, extracted.travelers);
  const rooms = Math.ceil(travelers / 2);
  const hotelNightlyCapUsd = nights > 0 && extracted.budgetUsd > 0
    ? Math.floor(extracted.budgetUsd * HOTEL_BUDGET_SHARE / nights / rooms)
    : 0;
  return { nights: Math.max(0, nights), rooms, hotelNightlyCapUsd, missing };
}

async function extract(
  args: z.infer<typeof ExtractArgsSchema>,
  context: {
    globalArgs: z.infer<typeof GlobalArgsSchema>;
    _fetch?: FetchLike;
    logger: { info(message: string, props?: Record<string, unknown>): void };
    writeResource(
      specName: string,
      instanceName: string,
      data: Record<string, unknown>,
    ): Promise<{ name: string }>;
  },
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const { request, name } = ExtractArgsSchema.parse(args);
  const { apiKey, model, maxTokens } = GlobalArgsSchema.parse(
    context.globalArgs,
  );
  const today = new Date().toISOString().slice(0, 10);
  context.logger.info("Extracting trip requirements with {model}", { model });

  const result = await callClaude({
    apiKey,
    model,
    maxTokens,
    system: SYSTEM_PROMPT,
    prompt: `Today is ${today}.\n\nTrip request:\n${request}`,
    jsonSchema: EXTRACT_JSON_SCHEMA,
    timeoutMs: REQUEST_TIMEOUT_MS,
    fetch: context._fetch,
  });

  let json: unknown;
  try {
    json = JSON.parse(result.text);
  } catch {
    throw new Error(
      `Claude returned non-JSON requirements: ${result.text.slice(0, 500)}`,
    );
  }
  const extracted = ExtractedSchema.parse(json);
  const derived = deriveRequirements(extracted, today);

  const handle = await context.writeResource(
    "requirements",
    `requirements-${name}`,
    {
      ...extracted,
      travelers: Math.max(1, extracted.travelers),
      ...derived,
      request,
      model,
      usage: result.usage,
      extractedAt: new Date().toISOString(),
    },
  );
  context.logger.info("Requirements extracted: {city}, {nights} nights", {
    city: extracted.destinationCity,
    nights: derived.nights,
  });
  return { dataHandles: [handle] };
}

/** Anthropic behavior: extract structured requirements with Claude. */
export const model = {
  type: "@adam/trip-planner/anthropic",
  version: "2026.10.08.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    requirements: {
      description:
        "Structured trip requirements extracted from a plain-English request.",
      schema: RequirementsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    extract: {
      description:
        "Turn a plain-English trip request into structured requirements: origin, destination, dates, travelers, budget, priority, and interests.",
      arguments: ExtractArgsSchema,
      execute: extract,
    },
  },
};
