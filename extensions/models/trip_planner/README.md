# @adam/trip-planner

Plan a trip from one sentence:

```bash
swamp workflow run @adam/plan-trip \
  --input request="plan a comfortable trip to japan, 10 days in april, \$4000, from SFO"
```

## How it works

Each **behavior** is a swamp model, and its **methods** are what it can do.
The `@adam/plan-trip` workflow calls them in order and wires each result into the
next step with CEL.

| Behavior | Model | Method | What it does |
| -------- | ----- | ------ | ------------ |
| Anthropic | `trip-anthropic` (`@adam/trip-planner/anthropic`) | `extract` | Claude Haiku turns the request into structured requirements: origin and destination airports, dates, travelers, budget, priority (`budget` / `balanced` / `comfort`), cabin, interests. Nights, rooms, and a hotel price cap are computed in code. |
| Hotel | `trip-hotels` (`@keeb/hotelist`) | `search_hotels` | Up to 10 rated hotels in the destination city under the price cap. |
| Flight | `trip-flights` (`@adam/trip-planner/flights`) | `search` | Priced round-trip options from Google Flights via SerpApi or SearchApi.io (`provider` setting). |
| Itinerary | `trip-itinerary` (`@adam/trip-planner/itinerary`) | `pick` | Chooses the best flight + hotel. Deterministic, no LLM. |
| | | `generate` | Renders a day-by-day Markdown itinerary from the pick. Deterministic, no LLM. |

Only `extract` uses an LLM. Everything after it is plain code, so the same
search results always produce the same pick and the same itinerary.

### Workflow

1. **understand**: `extract`, then an assert stops the run if the origin,
   budget, or valid dates are missing.
2. **search**: flight `search` and hotel `search_hotels` run in parallel.
3. **plan**: `pick`, an assert that the total is within budget, then `generate`.

### What `generate` produces

A Markdown itinerary with the flight legs, the hotel (link, rating, pros and
cons), a budget table including spending money per day, a day-by-day plan,
the runners-up with scores, and any assumptions `extract` made. Days are laid
out from the flight times: travel days until the outbound lands, an arrival
day, free days that cycle through your interests as each day's focus, and a
departure day. The same data is stored as structured `days` on the
`itinerary` resource.

### How `pick` chooses

1. Drop every flight + hotel pair whose total (flight + nightly rate × nights
   × rooms) is over budget. If nothing fits, the step fails and reports the
   cheapest possible total.
2. Score each remaining pair on three factors, each scaled 0–1 across the
   candidates: total price, hotel rating, and flight comfort (stops, then
   duration).
3. Weight the factors by priority and take the highest score:

   | Priority | Price | Hotel | Flight |
   | -------- | ----- | ----- | ------ |
   | budget   | 0.70  | 0.20  | 0.10   |
   | balanced | 0.40  | 0.35  | 0.25   |
   | comfort  | 0.15  | 0.50  | 0.35   |

Hotels in the destination city are preferred over the nearby ones the search
also returns. Rooms default to one per two travelers.

## Setup

```bash
swamp extension pull @adam/trip-planner

swamp vault create local_encryption trip-planner
swamp vault put trip-planner ANTHROPIC_API_KEY
swamp vault put trip-planner FLIGHTS_API_KEY   # SerpApi or SearchApi.io key

swamp model create @adam/trip-planner/anthropic trip-anthropic \
  --global-arg 'apiKey=${{ vault.get(trip-planner, ANTHROPIC_API_KEY) }}'
swamp model create @keeb/hotelist trip-hotels
swamp model create @adam/trip-planner/flights trip-flights \
  --global-arg provider=searchapi \
  --global-arg 'apiKey=${{ vault.get(trip-planner, FLIGHTS_API_KEY) }}'
swamp model create @adam/trip-planner/itinerary trip-itinerary
```

## Reading the result

```bash
swamp data query 'modelName == "trip-itinerary" && name == "itinerary-latest"' --select 'attributes.markdown'
swamp data query 'modelName == "trip-itinerary" && name == "selection-latest"' --select 'attributes'   # what was picked and why
```

## Caveats

- Flight prices are round-trip fares; only the outbound legs are listed and
  the return flight is chosen at booking time. With more than one traveler,
  neither flight API documents whether `price` covers everyone or one person;
  `pick` treats it as the total.
- Hotel prices are hotelist.com's nightly USD estimates, not live rates.
- Nothing is booked.
