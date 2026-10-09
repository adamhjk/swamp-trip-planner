# swamp-trip-planner

Plan a trip from one sentence with [swamp](https://github.com/swamp-club/swamp):

```bash
swamp workflow run @adam/plan-trip \
  --input request="plan a comfortable trip to japan, 10 days in april, \$4000, from SFO, love food and temples"
```

You get a day-by-day itinerary with a real flight, a rated hotel, and a budget
that adds up:

```markdown
# Tokyo, Japan: Thu, Apr 1 – Sun, Apr 11

10 nights · 1 traveler · priority: comfort

## Flight
Round trip **$1,185** · nonstop · outbound 11h 10m

## Hotel
**Metropolitan Marunouchi Hotel** · Tokyo · rated 9/10

## Budget
| Item | Cost |
| ---- | ---: |
| Flight (round trip) | $1,185 |
| Hotel ($211 × 10 nights × 1 room) | $2,110 |
| **Total** | **$3,295** |
| Left for food, transit, activities | $705 (~$64/day) |

### Day 3 — Sat, Apr 3
- Explore Tokyo, focusing on food.
...
```

This repository is both the swamp repo the planner was built in and the source
of the [`@adam/trip-planner`](extensions/models/trip_planner/README.md)
extension.

## How it works

The planner is four **behaviors** (swamp model types), each with a small set of
**methods**, wired together by the `@adam/plan-trip` workflow:

```
request ─▶ Anthropic.extract ─▶ ┬─ Flight.search ─┐
                                └─ Hotel.search ──┴─▶ Itinerary.pick ─▶ Itinerary.generate ─▶ itinerary
```

| Behavior | Type | Method | What it does |
| -------- | ---- | ------ | ------------ |
| Anthropic | `@adam/trip-planner/anthropic` | `extract` | Claude Haiku 5.5 turns the sentence into structured requirements: origin and destination airports, dates, travelers, budget, priority, interests. |
| Flight | `@adam/trip-planner/flights` | `search` | Priced round trips from Google Flights via [SearchApi.io](https://www.searchapi.io) or [SerpApi](https://serpapi.com). |
| Hotel | `@keeb/hotelist` | `search_hotels` | Rated hotels with nightly prices from hotelist.com. |
| Itinerary | `@adam/trip-planner/itinerary` | `pick` | Chooses the best flight + hotel that fits the budget, weighted by priority (`budget`, `balanced`, `comfort`). |
| | | `generate` | Renders the Markdown itinerary from the pick. |

**Only `extract` calls an LLM** (about $0.0005 per run). Searching, picking,
and rendering are plain code, so the same search results always produce the
same itinerary, and `pick` can never go over budget. If the request leaves out
the origin, budget, or usable dates, the workflow stops after `extract` and
says what to add.

The extension's [README](extensions/models/trip_planner/README.md) covers the
scoring weights, workflow inputs, and caveats.

## Use the published extension

```bash
swamp extension pull @adam/trip-planner

swamp vault create local_encryption trip-planner
swamp vault put trip-planner ANTHROPIC_API_KEY
swamp vault put trip-planner FLIGHTS_API_KEY    # SearchApi.io key (or SerpApi, see below)

swamp workflow run @adam/plan-trip --input request="..."
```

The workflow creates its own models on first run. For a SerpApi key, add
`--input flights_provider=serpapi`.

Read the result:

```bash
swamp data query 'modelName == "trip-itinerary" && name == "itinerary-latest"' \
  --select 'attributes.markdown'
```

## Work on this repo

```bash
git clone git@github.com:adamhjk/swamp-trip-planner.git
cd swamp-trip-planner
swamp extension install    # restores @keeb/hotelist from upstream_extensions.json
```

Then create the vault and keys as above. Swamp loads the extension straight
from `extensions/models/trip_planner/`, so edits take effect on the next run.

| Path | Contents |
| ---- | -------- |
| `extensions/models/trip_planner/` | The `@adam/trip-planner` extension: models, tests, manifest, README |
| `workflows/workflow-plan-trip.yaml` | The `@adam/plan-trip` workflow (published with the extension) |
| `vaults/` | Vault definitions; secrets themselves live in `.swamp/`, which is gitignored |

Run the tests with swamp's bundled Deno:

```bash
~/.swamp/deno/deno test extensions/models/trip_planner/
```

Check and publish the extension:

```bash
swamp extension fmt extensions/models/trip_planner/manifest.yaml
swamp extension quality extensions/models/trip_planner/manifest.yaml
swamp extension push extensions/models/trip_planner/manifest.yaml --dry-run
```

## License

[Apache-2.0](LICENSE)
