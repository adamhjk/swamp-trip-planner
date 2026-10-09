import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import { type FlightOption, model, normalizeFlights } from "./flights.ts";

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

Deno.test("flight search never leaks the API key in network errors", async () => {
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
