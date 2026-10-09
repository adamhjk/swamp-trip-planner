import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import { callClaude } from "./anthropic_client.ts";
import { deriveRequirements } from "./anthropic.ts";
import { type FlightOption, normalizeFlights } from "./flights.ts";
import { pickBest, renderItinerary } from "./itinerary.ts";

const flight = (
  price: number,
  stops: number,
  minutes: number,
  airline = "ANA",
): FlightOption => ({
  price,
  totalDurationMinutes: minutes,
  stops,
  airlines: [airline],
  googleBest: false,
  legs: [{
    from: "SFO",
    to: "HND",
    departAt: "2027-04-05 11:00",
    arriveAt: "2027-04-06 15:00",
    airline,
    flightNumber: "NH 7",
    durationMinutes: minutes,
  }],
  layovers: [],
});

const hotel = (name: string, price: number | null, rating: number | null, city = "Tokyo") => ({
  name,
  url: `https://hotelist.com/${name}`,
  city,
  ai_rating: rating,
  price_per_night_usd: price,
});

const base = {
  flights: [flight(900, 0, 660, "ANA"), flight(600, 2, 1300, "Cheap Air")],
  hotels: [hotel("luxe", 250, 9.4), hotel("basic", 80, 6.5)],
  budgetUsd: 4000,
  nights: 10,
  travelers: 1,
};

Deno.test("pick never exceeds the budget", () => {
  const sel = pickBest({ ...base, budgetUsd: 1500, priority: "comfort" });
  assert(sel.costs.totalUsd <= 1500);
  // luxe (2500) can't fit, so comfort still has to take basic
  assertEquals(sel.hotel.name, "basic");
});

Deno.test("budget priority takes the cheapest pair", () => {
  const sel = pickBest({ ...base, priority: "budget" });
  assertEquals(sel.flight.price, 600);
  assertEquals(sel.hotel.name, "basic");
  assertEquals(sel.costs.totalUsd, 1400);
  assertEquals(sel.costs.remainingUsd, 2600);
});

Deno.test("comfort priority takes the nonstop flight and best hotel", () => {
  const sel = pickBest({ ...base, priority: "comfort" });
  assertEquals(sel.flight.stops, 0);
  assertEquals(sel.hotel.name, "luxe");
  assertEquals(sel.costs.totalUsd, 3400);
});

Deno.test("rooms default to one per two travelers", () => {
  const sel = pickBest({ ...base, travelers: 3, priority: "budget" });
  assertEquals(sel.rooms, 2);
  assertEquals(sel.costs.hotelTotalUsd, 80 * 10 * 2);
});

Deno.test("prefers hotels in the requested city, skips unpriced ones", () => {
  const sel = pickBest({
    ...base,
    hotels: [
      hotel("nearby", 50, 9.9, "Yokohama"),
      hotel("unpriced", null, 9.9),
      hotel("tokyo", 120, 7),
    ],
    city: "tokyo",
    priority: "budget",
  });
  assertEquals(sel.hotel.name, "tokyo");
});

Deno.test("explains the shortfall when nothing fits", () => {
  assertThrows(
    () => pickBest({ ...base, budgetUsd: 1000, priority: "balanced" }),
    Error,
    "cheapest flight + hotel for 10 nights is $1400",
  );
});

const extracted = {
  originCity: "San Francisco",
  originAirports: "SFO",
  destinationCountry: "Japan",
  destinationCity: "Tokyo",
  destinationAirports: "HND,NRT",
  startDate: "2027-04-05",
  endDate: "2027-04-15",
  travelers: 3,
  budgetUsd: 4000,
  priority: "balanced" as const,
  cabin: "economy" as const,
  interests: [],
  assumptions: [],
};

Deno.test("derives nights, rooms, and the hotel cap", () => {
  assertEquals(deriveRequirements(extracted, "2026-10-08"), {
    nights: 10,
    rooms: 2,
    hotelNightlyCapUsd: 120,
    missing: [],
  });
});

Deno.test("flags missing origin, budget, and past dates", () => {
  const d = deriveRequirements(
    { ...extracted, originAirports: "", budgetUsd: 0 },
    "2027-05-01",
  );
  assertEquals(d.missing.length, 3);
  assertEquals(d.hotelNightlyCapUsd, 0);
});

Deno.test("normalizes SerpApi results and drops unpriced options", () => {
  const { options, googleFlightsUrl } = normalizeFlights({
    best_flights: [{
      flights: [
        {
          departure_airport: { id: "SFO", time: "2027-04-05 11:00" },
          arrival_airport: { id: "ICN", time: "2027-04-06 16:00" },
          duration: 700,
          airline: "Korean Air",
          flight_number: "KE 24",
        },
        {
          departure_airport: { id: "ICN", time: "2027-04-06 18:00" },
          arrival_airport: { id: "HND", time: "2027-04-06 20:20" },
          duration: 140,
          airline: "Korean Air",
          flight_number: "KE 719",
        },
      ],
      layovers: [{ id: "ICN", duration: 120 }],
      total_duration: 960,
      price: 812,
    }],
    other_flights: [{ flights: [{ airline: "X" }] }],
    search_metadata: { google_flights_url: "https://g.co/f" },
  });
  assertEquals(options.length, 1);
  assertEquals(options[0].stops, 1);
  assertEquals(options[0].airlines, ["Korean Air"]);
  assertEquals(options[0].layovers[0], {
    airport: "ICN",
    durationMinutes: 120,
    overnight: false,
  });
  assertEquals(googleFlightsUrl, "https://g.co/f");
});

Deno.test("surfaces SerpApi errors", () => {
  assertThrows(
    () => normalizeFlights({ error: "Invalid API key" }),
    Error,
    "Invalid API key",
  );
});

const fakeFetch = (body: unknown, status = 200) => () =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

const claudeOpts = {
  apiKey: "k",
  model: "claude-haiku-4-5",
  maxTokens: 100,
  prompt: "hi",
  timeoutMs: 1000,
};

Deno.test("callClaude returns text and usage", async () => {
  const r = await callClaude({
    ...claudeOpts,
    fetch: fakeFetch({
      content: [{ type: "text", text: "hello" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 3, output_tokens: 2 },
    }),
  });
  assertEquals(r, {
    text: "hello",
    usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
  });
});

Deno.test("callClaude rejects truncated and refused output", async () => {
  for (const stop_reason of ["max_tokens", "refusal"]) {
    await assertRejects(() =>
      callClaude({
        ...claudeOpts,
        fetch: fakeFetch({ content: [{ type: "text", text: "x" }], stop_reason }),
      })
    );
  }
  await assertRejects(
    () => callClaude({ ...claudeOpts, fetch: fakeFetch({}, 401) }),
    Error,
    "HTTP 401",
  );
});

const trip = {
  destinationCity: "Tokyo",
  destinationCountry: "Japan",
  startDate: "2027-04-05",
  endDate: "2027-04-08",
  travelers: 1,
  interests: ["food", "temples"],
  assumptions: ["Picked Tokyo as the main city"],
  request: "plan a trip to japan",
  name: "latest",
};

Deno.test("itinerary lays out travel, arrival, focused free days, departure", () => {
  // The fixture flight lands the day after it departs.
  const sel = pickBest({ ...base, nights: 3, priority: "budget" });
  const { days, dailySpendingUsd } = renderItinerary(trip, {
    ...sel,
    pickedAt: "2026-10-08T00:00:00.000Z",
  });
  assertEquals(days.map((d) => d.kind), ["travel", "arrival", "free", "departure"]);
  assertEquals(days.map((d) => d.date), [
    "2027-04-05",
    "2027-04-06",
    "2027-04-07",
    "2027-04-08",
  ]);
  assert(days[2].plan[0].includes("focusing on food"));
  assertEquals(dailySpendingUsd, Math.floor(sel.costs.remainingUsd / 4));
});

Deno.test("itinerary markdown is deterministic and uses the real numbers", () => {
  const sel = { ...pickBest({ ...base, priority: "budget" }), pickedAt: "x" };
  const longTrip = { ...trip, endDate: "2027-04-15" };
  const a = renderItinerary(longTrip, sel).markdown;
  const b = renderItinerary(longTrip, { ...sel, pickedAt: "y" }).markdown;
  assertEquals(a, b);
  assert(a.includes("| **Total** | **$1,400** |"));
  assert(a.includes("[basic](https://hotelist.com/basic)"));
  assert(a.includes("### Day 1 — Mon, Apr 5"));
  assert(a.includes("### Day 11 — Thu, Apr 15"));
  assert(a.includes("- Picked Tokyo as the main city"));
});

Deno.test("comfort pays more for a better hotel when the budget allows", () => {
  const sel = pickBest({
    ...base,
    flights: [flight(1450, 0, 655)],
    hotels: [hotel("haneda", 114, 8.4), hotel("marunouchi", 211, 9.0)],
    priority: "comfort",
  });
  assertEquals(sel.hotel.name, "marunouchi");
});

Deno.test("flight search never leaks the API key in network errors", async () => {
  const { model } = await import("./flights.ts");
  await assertRejects(
    () =>
      model.methods.search.execute(
        {
          departureIds: "SFO",
          arrivalIds: "HND",
          outboundDate: "2027-04-05",
          adults: 1,
          cabin: "economy",
          maxStops: "any",
          name: "latest",
        },
        {
          globalArgs: {
            provider: "serpapi",
            apiKey: "SECRET123",
            currency: "USD",
            hl: "en",
            gl: "us",
          },
          _fetch: (url) =>
            Promise.reject(new TypeError(`error sending request for url (${url})`)),
          logger: { info() {} },
          writeResource: () => Promise.resolve({ name: "x" }),
        },
      ),
    Error,
    "api_key=***",
  );
});

Deno.test("SearchApi.io: key goes in a header, dates and times are joined", async () => {
  const { model } = await import("./flights.ts");
  let seenUrl = "";
  let seenAuth = "";
  const written: Record<string, unknown>[] = [];
  await model.methods.search.execute(
    {
      departureIds: "SFO",
      arrivalIds: "HND",
      outboundDate: "2027-04-05",
      returnDate: "2027-04-15",
      adults: 1,
      cabin: "first",
      maxStops: "one",
      name: "latest",
    },
    {
      globalArgs: {
        provider: "searchapi",
        apiKey: "SECRET123\n",
        currency: "USD",
        hl: "en",
        gl: "us",
      },
      _fetch: (url, init) => {
        seenUrl = String(url);
        seenAuth = new Headers(init?.headers).get("Authorization") ?? "";
        return Promise.resolve(
          new Response(JSON.stringify({
            best_flights: [{
              flights: [{
                departure_airport: { id: "SFO", date: "2027-04-05", time: "11:00" },
                arrival_airport: { id: "HND", date: "2027-04-06", time: "14:55" },
                duration: 655,
                airline: "ANA",
                flight_number: "NH 7",
              }],
              total_duration: 655,
              price: 1450,
            }],
          })),
        );
      },
      logger: { info() {} },
      writeResource: (_spec, _name, data) => {
        written.push(data);
        return Promise.resolve({ name: "x" });
      },
    },
  );
  assert(seenUrl.startsWith("https://www.searchapi.io/api/v1/search?"));
  assert(!seenUrl.includes("SECRET123"));
  assert(seenUrl.includes("travel_class=first_class"));
  assert(seenUrl.includes("stops=one_stop_or_fewer"));
  assert(seenUrl.includes("flight_type=round_trip"));
  assertEquals(seenAuth, "Bearer SECRET123");
  const options = written[0].options as FlightOption[];
  assertEquals(options[0].legs[0].departAt, "2027-04-05 11:00");
  assertEquals(options[0].legs[0].arriveAt, "2027-04-06 14:55");
});
