/**
 * Itinerary behavior for the trip planner: `pick` chooses the best-fit
 * flight and hotel algorithmically, never exceeding the budget; `generate`
 * renders a day-by-day Markdown itinerary from that choice. Neither method
 * calls an LLM: the same inputs always produce the same output.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { FlightOptionSchema } from "./flights.ts";

const PRIORITIES = ["budget", "balanced", "comfort"] as const;
type Priority = typeof PRIORITIES[number];

/** How much each factor counts toward a candidate's score, per priority. */
export const WEIGHTS: Record<
  Priority,
  { price: number; hotel: number; flight: number }
> = {
  budget: { price: 0.7, hotel: 0.2, flight: 0.1 },
  balanced: { price: 0.4, hotel: 0.35, flight: 0.25 },
  comfort: { price: 0.15, hotel: 0.5, flight: 0.35 },
};

// Hotels without a rating score as middling rather than being excluded.
const DEFAULT_HOTEL_RATING = 5;

const GlobalArgsSchema = z.object({});

/**
 * The hotel fields pick and generate use, from @keeb/hotelist search output.
 * Other fields are dropped on parse.
 */
const HotelSchema = z.object({
  name: z.string(),
  url: z.string(),
  city: z.string(),
  country: z.string().optional(),
  ai_rating: z.number().nullable(),
  price_per_night_usd: z.number().nullable(),
  km_from_center: z.number().nullable().optional(),
  pros: z.array(z.string()).optional(),
  cons: z.array(z.string()).optional(),
});

type Hotel = z.infer<typeof HotelSchema>;
type Flight = z.infer<typeof FlightOptionSchema>;

const NameSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/)
  .default("latest");

const PickArgsSchema = z.object({
  flights: z.array(FlightOptionSchema).describe(
    "Flight options from the flight behavior's search.",
  ),
  hotels: z.array(HotelSchema).describe(
    "Hotels from the hotel behavior's search.",
  ),
  budgetUsd: z.number().positive(),
  nights: z.number().int().positive(),
  travelers: z.number().int().positive().default(1),
  rooms: z.number().int().positive().optional().describe(
    "Hotel rooms; defaults to one per two travelers.",
  ),
  priority: z.enum(PRIORITIES).default("balanced"),
  city: z.string().optional().describe(
    "Prefer hotels actually in this city (searches can return nearby ones).",
  ),
  name: NameSchema,
});

const GenerateArgsSchema = z.object({
  destinationCity: z.string().min(1),
  destinationCountry: z.string().default(""),
  startDate: z.string(),
  endDate: z.string(),
  travelers: z.number().int().positive().default(1),
  interests: z.array(z.string()).default([]).describe(
    "Each free day takes the next interest as its focus.",
  ),
  assumptions: z.array(z.string()).default([]).describe(
    "Values inferred from the request, listed so the reader can check them.",
  ),
  request: z.string().default("").describe("The original trip request."),
  name: NameSchema.describe("Which selection to build around."),
});

const CostsSchema = z.object({
  flightUsd: z.number(),
  hotelPerNightUsd: z.number(),
  hotelTotalUsd: z.number(),
  totalUsd: z.number(),
  remainingUsd: z.number(),
});

const SelectionSchema = z.object({
  priority: z.enum(PRIORITIES),
  budgetUsd: z.number(),
  nights: z.number().int(),
  travelers: z.number().int(),
  rooms: z.number().int(),
  flight: FlightOptionSchema,
  hotel: HotelSchema,
  costs: CostsSchema,
  score: z.number(),
  scoreBreakdown: z.object({
    price: z.number(),
    hotel: z.number(),
    flight: z.number(),
  }),
  alternatives: z.array(z.object({
    hotel: z.string(),
    airlines: z.array(z.string()),
    stops: z.number().int(),
    totalUsd: z.number(),
    score: z.number(),
  })),
  candidatesConsidered: z.number().int(),
  candidatesWithinBudget: z.number().int(),
  pickedAt: z.iso.datetime(),
});

type Selection = z.infer<typeof SelectionSchema>;

const TripDaySchema = z.object({
  day: z.number().int(),
  date: z.string(),
  kind: z.enum(["travel", "arrival", "free", "departure"]),
  plan: z.array(z.string()),
});

/** One day of the trip. */
export type TripDay = z.infer<typeof TripDaySchema>;

const ItinerarySchema = z.object({
  markdown: z.string(),
  destinationCity: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  days: z.array(TripDaySchema),
  totalUsd: z.number(),
  dailySpendingUsd: z.number(),
  generatedAt: z.iso.datetime(),
});

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Scales value into 0..1 where `lo` scores 1 (lower is better). */
function lowerIsBetter(value: number, lo: number, hi: number): number {
  return hi === lo ? 1 : 1 - (value - lo) / (hi - lo);
}

/** Scales value into 0..1 where `hi` scores 1 (higher is better). */
function higherIsBetter(value: number, lo: number, hi: number): number {
  return hi === lo ? 1 : (value - lo) / (hi - lo);
}

function stopScore(stops: number): number {
  return stops <= 0 ? 1 : stops === 1 ? 0.5 : 0.2;
}

/** Input to the pure pick algorithm. */
export interface PickInput {
  flights: Flight[];
  hotels: Hotel[];
  budgetUsd: number;
  nights: number;
  travelers: number;
  rooms?: number;
  priority: Priority;
  city?: string;
}

/**
 * Chooses the best flight + hotel pair within budget.
 *
 * 1. Drop pairs whose total (flight + nightly rate x nights x rooms) exceeds
 *    the budget.
 * 2. Score each remaining pair on price, hotel rating, and flight comfort
 *    (stops and duration), weighted by priority.
 * 3. Return the highest score, preferring the cheaper pair on ties.
 *
 * Throws when no pair fits, reporting the cheapest possible total.
 */
export function pickBest(input: PickInput): Omit<Selection, "pickedAt"> {
  const rooms = input.rooms ?? Math.ceil(input.travelers / 2);
  const priced = input.hotels.filter((h) =>
    typeof h.price_per_night_usd === "number" && h.price_per_night_usd > 0
  );
  const wanted = input.city?.trim().toLowerCase();
  const inCity = wanted
    ? priced.filter((h) => h.city.trim().toLowerCase() === wanted)
    : [];
  const hotels = inCity.length > 0 ? inCity : priced;

  if (input.flights.length === 0) {
    throw new Error("No flight options to pick from");
  }
  if (hotels.length === 0) throw new Error("No priced hotels to pick from");

  const pairs = input.flights.flatMap((flight) =>
    hotels.map((hotel) => {
      const hotelTotalUsd = hotel.price_per_night_usd! * input.nights * rooms;
      return {
        flight,
        hotel,
        hotelTotalUsd,
        totalUsd: flight.price + hotelTotalUsd,
      };
    })
  );
  const fits = pairs.filter((p) => p.totalUsd <= input.budgetUsd);
  if (fits.length === 0) {
    const cheapest = Math.min(...pairs.map((p) => p.totalUsd));
    throw new Error(
      `Nothing fits a $${input.budgetUsd} budget: the cheapest flight + hotel ` +
        `for ${input.nights} nights is $${
          round2(cheapest)
        }. Raise the budget, ` +
        `shorten the trip, or choose a cheaper destination.`,
    );
  }

  // Every factor is scaled across the candidates that fit, so a 8.4 vs 9.0
  // rating gap counts as much as a $1000 price gap would.
  const rating = (h: Hotel) => h.ai_rating ?? DEFAULT_HOTEL_RATING;
  const totals = fits.map((p) => p.totalUsd);
  const durations = fits.map((p) => p.flight.totalDurationMinutes);
  const ratings = fits.map((p) => rating(p.hotel));
  const [minTotal, maxTotal] = [Math.min(...totals), Math.max(...totals)];
  const [minDur, maxDur] = [Math.min(...durations), Math.max(...durations)];
  const [minRating, maxRating] = [Math.min(...ratings), Math.max(...ratings)];
  const w = WEIGHTS[input.priority];

  const scored = fits.map((p) => {
    const price = lowerIsBetter(p.totalUsd, minTotal, maxTotal);
    const hotel = higherIsBetter(rating(p.hotel), minRating, maxRating);
    const flight = 0.6 * stopScore(p.flight.stops) +
      0.4 * lowerIsBetter(p.flight.totalDurationMinutes, minDur, maxDur);
    const score = w.price * price + w.hotel * hotel + w.flight * flight;
    return { ...p, score, breakdown: { price, hotel, flight } };
  }).sort((a, b) => b.score - a.score || a.totalUsd - b.totalUsd);

  const best = scored[0];
  return {
    priority: input.priority,
    budgetUsd: input.budgetUsd,
    nights: input.nights,
    travelers: input.travelers,
    rooms,
    flight: best.flight,
    hotel: best.hotel,
    costs: {
      flightUsd: round2(best.flight.price),
      hotelPerNightUsd: round2(best.hotel.price_per_night_usd!),
      hotelTotalUsd: round2(best.hotelTotalUsd),
      totalUsd: round2(best.totalUsd),
      remainingUsd: round2(input.budgetUsd - best.totalUsd),
    },
    score: round2(best.score),
    scoreBreakdown: {
      price: round2(best.breakdown.price),
      hotel: round2(best.breakdown.hotel),
      flight: round2(best.breakdown.flight),
    },
    alternatives: scored.slice(1, 4).map((p) => ({
      hotel: p.hotel.name,
      airlines: p.flight.airlines,
      stops: p.flight.stops,
      totalUsd: round2(p.totalUsd),
      score: round2(p.score),
    })),
    candidatesConsidered: pairs.length,
    candidatesWithinBudget: fits.length,
  };
}

type WriteResource = (
  specName: string,
  instanceName: string,
  data: Record<string, unknown>,
) => Promise<{ name: string }>;

async function pick(
  args: z.infer<typeof PickArgsSchema>,
  context: {
    logger: { info(message: string, props?: Record<string, unknown>): void };
    writeResource: WriteResource;
  },
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const a = PickArgsSchema.parse(args);
  context.logger.info(
    "Picking from {flights} flights x {hotels} hotels for a ${budget} {priority} trip",
    {
      flights: a.flights.length,
      hotels: a.hotels.length,
      budget: a.budgetUsd,
      priority: a.priority,
    },
  );
  const selection = pickBest(a);
  const handle = await context.writeResource(
    "selection",
    `selection-${a.name}`,
    {
      ...selection,
      pickedAt: new Date().toISOString(),
    },
  );
  context.logger.info(
    "Picked {hotel} + {airlines} for ${total} ({priority})",
    {
      hotel: selection.hotel.name,
      airlines: selection.flight.airlines.join("/"),
      total: selection.costs.totalUsd,
      priority: selection.priority,
    },
  );
  return { dataHandles: [handle] };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function prettyDate(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()]}, ${
    MONTHS[d.getUTCMonth()]
  } ${d.getUTCDate()}`;
}

function usd(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function hm(minutes: number): string {
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** "2027-04-05 11:00" -> "11:00"; returns the input when it has no time. */
function timeOf(stamp: string): string {
  return stamp.length >= 16 ? stamp.slice(11, 16) : stamp;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

/**
 * Lays out each day: travel until the outbound flight lands, then arrival,
 * free days (each focused on the next interest, in order), and departure.
 */
export function planDays(
  trip: z.infer<typeof GenerateArgsSchema>,
  selection: Selection,
): TripDay[] {
  const legs = selection.flight.legs;
  const first = legs[0];
  const last = legs[legs.length - 1];
  const arrivalDate = last && DATE_RE.test(last.arriveAt)
    ? last.arriveAt.slice(0, 10)
    : trip.startDate;
  const departure = first
    ? `Depart ${first.from} at ${
      timeOf(first.departAt)
    } on ${first.airline} ${first.flightNumber}.`
    : "Depart on the outbound flight.";
  const hotel = selection.hotel.name;

  const days: TripDay[] = [];
  let freeDays = 0;
  for (let i = 0; i <= selection.nights; i++) {
    const date = addDays(trip.startDate, i);
    const plan: string[] = [];
    let kind: TripDay["kind"];
    if (i === selection.nights) {
      kind = "departure";
      plan.push(`Check out of ${hotel}.`);
      plan.push(
        "Return flight home (choose its time when booking the round trip).",
      );
    } else if (date < arrivalDate) {
      kind = "travel";
      plan.push(i === 0 ? departure : "In transit.");
    } else if (date === arrivalDate) {
      kind = "arrival";
      if (i === 0) plan.push(departure);
      if (last) plan.push(`Arrive ${last.to} at ${timeOf(last.arriveAt)}.`);
      plan.push(`Check in at ${hotel}.`);
    } else {
      kind = "free";
      const focus = trip.interests.length
        ? trip.interests[freeDays % trip.interests.length]
        : undefined;
      plan.push(
        focus
          ? `Explore ${trip.destinationCity}, focusing on ${focus}.`
          : `Free day to explore ${trip.destinationCity}.`,
      );
      freeDays++;
    }
    days.push({ day: i + 1, date, kind, plan });
  }
  return days;
}

/**
 * Renders the itinerary as Markdown from the trip and the selection alone.
 * Pure: identical inputs produce byte-identical output.
 */
export function renderItinerary(
  trip: z.infer<typeof GenerateArgsSchema>,
  selection: Selection,
): { markdown: string; days: TripDay[]; dailySpendingUsd: number } {
  const { flight: f, hotel: h, costs } = selection;
  const days = planDays(trip, selection);
  const dailySpendingUsd = Math.floor(costs.remainingUsd / days.length);
  const place = trip.destinationCountry
    ? `${trip.destinationCity}, ${trip.destinationCountry}`
    : trip.destinationCity;
  const stops = f.stops === 0
    ? "nonstop"
    : `${f.stops} stop${f.stops > 1 ? "s" : ""}`;
  const plural = (n: number, word: string) =>
    `${n} ${word}${n === 1 ? "" : "s"}`;

  const out: string[] = [
    `# ${place}: ${prettyDate(trip.startDate)} – ${prettyDate(trip.endDate)}`,
    "",
    `${plural(selection.nights, "night")} · ${
      plural(trip.travelers, "traveler")
    } · priority: ${selection.priority}`,
  ];
  if (trip.request) out.push("", `> ${trip.request}`);

  out.push(
    "",
    "## Flight",
    "",
    `Round trip **${usd(costs.flightUsd)}** · ${stops} · outbound ${
      hm(f.totalDurationMinutes)
    }`,
    "",
    "| Flight | From | Departs | To | Arrives |",
    "| ------ | ---- | ------- | -- | ------- |",
    ...f.legs.map((l) =>
      `| ${l.airline} ${l.flightNumber} | ${l.from} | ${l.departAt} | ${l.to} | ${l.arriveAt} |`
    ),
  );
  if (f.layovers.length) {
    out.push(
      "",
      `Layovers: ${
        f.layovers.map((l) =>
          `${l.airport} (${hm(l.durationMinutes)}${
            l.overnight ? ", overnight" : ""
          })`
        ).join(", ")
      }`,
    );
  }
  out.push(
    "",
    "The fare covers both directions; the return flight is chosen at booking.",
  );

  const hotelFacts = [
    h.city,
    h.ai_rating !== null ? `rated ${h.ai_rating}/10` : "unrated",
    typeof h.km_from_center === "number"
      ? `${h.km_from_center} km from the center`
      : "",
  ].filter(Boolean).join(" · ");
  out.push("", "## Hotel", "", `**[${h.name}](${h.url})** · ${hotelFacts}`);
  if (h.pros?.length) out.push("", ...h.pros.map((p) => `- 👍 ${p}`));
  if (h.cons?.length) {
    out.push(
      ...(h.pros?.length ? [] : [""]),
      ...h.cons.map((c) => `- 👎 ${c}`),
    );
  }

  out.push(
    "",
    "## Budget",
    "",
    "| Item | Cost |",
    "| ---- | ---: |",
    `| Flight (round trip) | ${usd(costs.flightUsd)} |`,
    `| Hotel (${usd(costs.hotelPerNightUsd)} × ${
      plural(selection.nights, "night")
    } × ${plural(selection.rooms, "room")}) | ${usd(costs.hotelTotalUsd)} |`,
    `| **Total** | **${usd(costs.totalUsd)}** |`,
    `| Left for food, transit, activities | ${usd(costs.remainingUsd)} (~${
      usd(dailySpendingUsd)
    }/day) |`,
    `| Budget | ${usd(selection.budgetUsd)} |`,
    "",
    "## Day by day",
  );
  for (const d of days) {
    out.push(
      "",
      `### Day ${d.day} — ${prettyDate(d.date)}`,
      "",
      ...d.plan.map((p) => `- ${p}`),
    );
  }

  out.push(
    "",
    "## Why this pick",
    "",
    `Best ${selection.priority} score (${selection.score}) of ${selection.candidatesWithinBudget} flight + hotel pairs within budget (${selection.candidatesConsidered} considered). ` +
      `Price ${selection.scoreBreakdown.price}, hotel ${selection.scoreBreakdown.hotel}, flight ${selection.scoreBreakdown.flight} (each 0–1).`,
  );
  if (selection.alternatives.length) {
    out.push(
      "",
      "Runners-up:",
      "",
      "| Hotel | Airlines | Stops | Total | Score |",
      "| ----- | -------- | ----: | ----: | ----: |",
      ...selection.alternatives.map((a) =>
        `| ${a.hotel} | ${a.airlines.join(", ")} | ${a.stops} | ${
          usd(a.totalUsd)
        } | ${a.score} |`
      ),
    );
  }
  if (trip.assumptions.length) {
    out.push(
      "",
      "## Assumptions",
      "",
      ...trip.assumptions.map((a) => `- ${a}`),
    );
  }
  return { markdown: out.join("\n") + "\n", days, dailySpendingUsd };
}

async function generate(
  args: z.infer<typeof GenerateArgsSchema>,
  context: {
    logger: { info(message: string, props?: Record<string, unknown>): void };
    readResource(instanceName: string): Promise<Record<string, unknown> | null>;
    writeResource: WriteResource;
    createFileWriter(
      specName: string,
      instanceName: string,
    ): { writeText(text: string): Promise<{ name: string }> };
  },
): Promise<{ dataHandles: Array<{ name: string }> }> {
  const trip = GenerateArgsSchema.parse(args);
  context.logger.info("Rendering itinerary from selection-{name}", {
    name: trip.name,
  });
  const stored = await context.readResource(`selection-${trip.name}`);
  if (!stored) {
    throw new Error(
      `No selection-${trip.name} found; run pick before generate`,
    );
  }
  const selection = SelectionSchema.parse(stored);
  const { markdown, days, dailySpendingUsd } = renderItinerary(trip, selection);

  const resourceHandle = await context.writeResource(
    "itinerary",
    `itinerary-${trip.name}`,
    {
      markdown,
      destinationCity: trip.destinationCity,
      startDate: trip.startDate,
      endDate: trip.endDate,
      days,
      totalUsd: selection.costs.totalUsd,
      dailySpendingUsd,
      generatedAt: new Date().toISOString(),
    },
  );
  const fileHandle = await context.createFileWriter(
    "document",
    `itinerary-md-${trip.name}`,
  ).writeText(markdown);
  context.logger.info("Itinerary written: {days} days in {city}", {
    days: days.length,
    city: trip.destinationCity,
  });
  return { dataHandles: [resourceHandle, fileHandle] };
}

/** Itinerary behavior: pick the best-fit flight and hotel, then render the plan. */
export const model = {
  type: "@adam/trip-planner/itinerary",
  version: "2026.10.08.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    selection: {
      description: "The chosen flight and hotel, with costs and scoring.",
      schema: SelectionSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    itinerary: {
      description: "The day-by-day itinerary as Markdown plus structured days.",
      schema: ItinerarySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  files: {
    document: {
      description: "The itinerary as a Markdown file.",
      contentType: "text/markdown",
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    pick: {
      description:
        "Choose the best flight + hotel within budget, scored by priority (budget, balanced, or comfort). Deterministic; no LLM.",
      arguments: PickArgsSchema,
      execute: pick,
    },
    generate: {
      description:
        "Render a day-by-day Markdown itinerary from the picked flight and hotel. Deterministic; no LLM.",
      arguments: GenerateArgsSchema,
      execute: generate,
    },
  },
};
