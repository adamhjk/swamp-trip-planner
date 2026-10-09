/**
 * Flight behavior for the trip planner: searches Google Flights through
 * SerpApi or SearchApi.io and stores normalized, priced options.
 *
 * @module
 */
import { z } from "npm:zod@4";
import type { FetchLike } from "./anthropic_client.ts";

const REQUEST_TIMEOUT_MS = 60_000;

const CABINS = ["economy", "premium_economy", "business", "first"] as const;
const STOPS = ["any", "nonstop", "one", "two"] as const;
type Cabin = typeof CABINS[number];
type Stops = typeof STOPS[number];

/** The two Google Flights APIs share a response shape but not parameters. */
const PROVIDERS = {
  serpapi: {
    label: "SerpApi",
    url: "https://serpapi.com/search.json",
    cabin: { economy: "1", premium_economy: "2", business: "3", first: "4" },
    stops: { any: "0", nonstop: "1", one: "2", two: "3" },
    tripType: (roundTrip: boolean) => ["type", roundTrip ? "1" : "2"],
  },
  searchapi: {
    label: "SearchApi.io",
    url: "https://www.searchapi.io/api/v1/search",
    cabin: {
      economy: "economy",
      premium_economy: "premium_economy",
      business: "business",
      first: "first_class",
    },
    stops: {
      any: "any",
      nonstop: "nonstop",
      one: "one_stop_or_fewer",
      two: "two_stops_or_fewer",
    },
    tripType: (roundTrip: boolean) => [
      "flight_type",
      roundTrip ? "round_trip" : "one_way",
    ],
  },
} satisfies Record<string, {
  label: string;
  url: string;
  cabin: Record<Cabin, string>;
  stops: Record<Stops, string>;
  tripType: (roundTrip: boolean) => string[];
}>;

type Provider = keyof typeof PROVIDERS;

const GlobalArgsSchema = z.object({
  provider: z.enum(Object.keys(PROVIDERS) as [Provider, ...Provider[]])
    .default("serpapi").describe(
      "Which Google Flights API the key belongs to: serpapi or searchapi (SearchApi.io).",
    ),
  apiKey: z.string().min(1).meta({ sensitive: true }).describe(
    "API key for the chosen provider.",
  ),
  currency: z.string().length(3).default("USD").describe(
    "Currency for prices.",
  ),
  hl: z.string().default("en").describe("Result language."),
  gl: z.string().default("us").describe("Country to search from."),
});

const SearchArgsSchema = z.object({
  departureIds: z.string().min(3).describe(
    "Comma-separated origin IATA codes, e.g. SFO or JFK,EWR.",
  ),
  arrivalIds: z.string().min(3).describe(
    "Comma-separated destination IATA codes, e.g. HND,NRT.",
  ),
  outboundDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe(
    "YYYY-MM-DD departure date.",
  ),
  returnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe(
    "YYYY-MM-DD return date; omit for one-way.",
  ),
  adults: z.number().int().positive().default(1),
  cabin: z.enum(CABINS).default("economy"),
  maxStops: z.enum(STOPS).default("any"),
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/).default("latest")
    .describe("Suffix for the stored flights instance."),
});

const SerpAirportSchema = z.object({
  id: z.string().optional(),
  name: z.string().optional(),
  // SerpApi: "2027-04-05 11:00". SearchApi.io: date "2027-04-05", time "11:00".
  date: z.string().optional(),
  time: z.string().optional(),
}).passthrough();

/** Joins SearchApi.io's separate date and time into SerpApi's form. */
function stamp(a: z.infer<typeof SerpAirportSchema> | undefined): string {
  if (!a?.time) return a?.date ?? "";
  return a.date && !a.time.startsWith(a.date) ? `${a.date} ${a.time}` : a.time;
}

const SerpOptionSchema = z.object({
  flights: z.array(
    z.object({
      departure_airport: SerpAirportSchema.optional(),
      arrival_airport: SerpAirportSchema.optional(),
      duration: z.number().optional(),
      airline: z.string().optional(),
      flight_number: z.string().optional(),
      travel_class: z.string().optional(),
    }).passthrough(),
  ),
  layovers: z.array(
    z.object({
      id: z.string().optional(),
      name: z.string().optional(),
      duration: z.number().optional(),
      overnight: z.boolean().optional(),
    }).passthrough(),
  ).optional(),
  total_duration: z.number().optional(),
  price: z.number().optional(),
}).passthrough();

const SerpResponseSchema = z.object({
  error: z.string().optional(),
  best_flights: z.array(SerpOptionSchema).optional(),
  other_flights: z.array(SerpOptionSchema).optional(),
  search_metadata: z.object({
    google_flights_url: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

/** One priced flight option, as the itinerary behavior's pick consumes it. */
export const FlightOptionSchema = z.object({
  price: z.number(),
  totalDurationMinutes: z.number(),
  stops: z.number().int(),
  airlines: z.array(z.string()),
  googleBest: z.boolean(),
  legs: z.array(z.object({
    from: z.string(),
    to: z.string(),
    departAt: z.string(),
    arriveAt: z.string(),
    airline: z.string(),
    flightNumber: z.string(),
    durationMinutes: z.number(),
  })),
  layovers: z.array(z.object({
    airport: z.string(),
    durationMinutes: z.number(),
    overnight: z.boolean(),
  })),
});

/** A normalized flight option. */
export type FlightOption = z.infer<typeof FlightOptionSchema>;

const FlightsResourceSchema = z.object({
  query: z.object({
    provider: z.string(),
    departureIds: z.string(),
    arrivalIds: z.string(),
    outboundDate: z.string(),
    returnDate: z.string().optional(),
    adults: z.number().int(),
    cabin: z.string(),
    maxStops: z.string(),
    currency: z.string(),
  }),
  roundTrip: z.boolean(),
  options: z.array(FlightOptionSchema),
  googleFlightsUrl: z.string().optional(),
  searchedAt: z.iso.datetime(),
});

/**
 * Converts a SerpApi or SearchApi.io Google Flights response (same shape)
 * into priced options, dropping
 * any option without a price. For round trips the price covers both
 * directions; the return leg itself is chosen at booking time.
 */
export function normalizeFlights(raw: unknown): {
  options: FlightOption[];
  googleFlightsUrl?: string;
} {
  const parsed = SerpResponseSchema.parse(raw);
  if (parsed.error) throw new Error(`Flight search error: ${parsed.error}`);

  const toOption = (
    o: z.infer<typeof SerpOptionSchema>,
    googleBest: boolean,
  ): FlightOption | null => {
    if (typeof o.price !== "number" || o.flights.length === 0) return null;
    const legs = o.flights.map((f) => ({
      from: f.departure_airport?.id ?? "",
      to: f.arrival_airport?.id ?? "",
      departAt: stamp(f.departure_airport),
      arriveAt: stamp(f.arrival_airport),
      airline: f.airline ?? "",
      flightNumber: f.flight_number ?? "",
      durationMinutes: f.duration ?? 0,
    }));
    return {
      price: o.price,
      totalDurationMinutes: o.total_duration ??
        legs.reduce((sum, l) => sum + l.durationMinutes, 0),
      stops: o.flights.length - 1,
      airlines: [...new Set(legs.map((l) => l.airline).filter(Boolean))],
      googleBest,
      legs,
      layovers: (o.layovers ?? []).map((l) => ({
        airport: l.id ?? l.name ?? "",
        durationMinutes: l.duration ?? 0,
        overnight: l.overnight ?? false,
      })),
    };
  };

  const options = [
    ...(parsed.best_flights ?? []).map((o) => toOption(o, true)),
    ...(parsed.other_flights ?? []).map((o) => toOption(o, false)),
  ].filter((o): o is FlightOption => o !== null);

  return {
    options,
    googleFlightsUrl: parsed.search_metadata?.google_flights_url,
  };
}

async function search(
  args: z.infer<typeof SearchArgsSchema>,
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
  const a = SearchArgsSchema.parse(args);
  const g = GlobalArgsSchema.parse(context.globalArgs);
  // Keys pasted into a vault often carry a trailing newline.
  const apiKey = g.apiKey.trim();
  const roundTrip = a.returnDate !== undefined;

  const p = PROVIDERS[g.provider];

  const params = new URLSearchParams({
    engine: "google_flights",
    departure_id: a.departureIds.replace(/\s+/g, ""),
    arrival_id: a.arrivalIds.replace(/\s+/g, ""),
    outbound_date: a.outboundDate,
    travel_class: p.cabin[a.cabin],
    stops: p.stops[a.maxStops],
    adults: String(a.adults),
    currency: g.currency,
    hl: g.hl,
    gl: g.gl,
  });
  const [tripKey, tripValue] = p.tripType(roundTrip);
  params.set(tripKey, tripValue);
  if (a.returnDate) params.set("return_date", a.returnDate);
  // SearchApi.io takes the key as a header, keeping it out of the URL;
  // SerpApi only accepts it as a query parameter.
  const headers: Record<string, string> = {};
  if (g.provider === "searchapi") headers.Authorization = `Bearer ${apiKey}`;
  else params.set("api_key", apiKey);

  context.logger.info("Searching {provider} flights {from} -> {to} on {date}", {
    provider: p.label,
    from: a.departureIds,
    to: a.arrivalIds,
    date: a.outboundDate,
  });
  let response: Response;
  try {
    response = await (context._fetch ?? fetch)(
      `${p.url}?${params}`,
      { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
    );
  } catch (err) {
    // Network errors embed the request URL, which may carry api_key.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${p.label} request failed: ${message.replaceAll(apiKey, "***")}`,
    );
  }
  if (!response.ok) {
    // Some errors echo the request (including api_key); keep only the
    // provider's error message.
    const body = await response.json().catch(() => ({})) as {
      error?: string;
    };
    throw new Error(
      `${p.label} request failed with HTTP ${response.status}${
        body.error ? `: ${body.error}` : ""
      }`,
    );
  }

  const { options, googleFlightsUrl } = normalizeFlights(
    await response.json(),
  );
  if (options.length === 0) {
    throw new Error(
      `No priced flights found for ${a.departureIds} -> ${a.arrivalIds} on ${a.outboundDate}`,
    );
  }

  const handle = await context.writeResource("flights", `flights-${a.name}`, {
    query: {
      provider: g.provider,
      departureIds: a.departureIds,
      arrivalIds: a.arrivalIds,
      outboundDate: a.outboundDate,
      ...(a.returnDate ? { returnDate: a.returnDate } : {}),
      adults: a.adults,
      cabin: a.cabin,
      maxStops: a.maxStops,
      currency: g.currency,
    },
    roundTrip,
    options,
    ...(googleFlightsUrl ? { googleFlightsUrl } : {}),
    searchedAt: new Date().toISOString(),
  });
  context.logger.info("Found {count} priced flight options", {
    count: options.length,
  });
  return { dataHandles: [handle] };
}

/** Flight behavior: search Google Flights via SerpApi or SearchApi.io. */
export const model = {
  type: "@adam/trip-planner/flights",
  version: "2026.10.08.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    flights: {
      description: "Priced flight options for one route and set of dates.",
      schema: FlightsResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    search: {
      description:
        "Search Google Flights for a route and dates; stores priced options with stops, duration, and legs.",
      arguments: SearchArgsSchema,
      execute: search,
    },
  },
};
