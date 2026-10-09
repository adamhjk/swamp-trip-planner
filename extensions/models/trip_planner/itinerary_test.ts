import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import type { FlightOption } from "./flights.ts";
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
