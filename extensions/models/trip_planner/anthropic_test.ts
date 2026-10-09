import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import { callClaude } from "./anthropic_client.ts";
import { deriveRequirements, model } from "./anthropic.ts";

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

Deno.test("extract stores Claude's answer plus derived fields", async () => {
  const written: Array<{ spec: string; name: string; data: Record<string, unknown> }> = [];
  let sentBody: Record<string, unknown> = {};
  await model.methods.extract.execute(
    { request: "plan a trip to japan from SFO, $4000", name: "latest" },
    {
      globalArgs: {
        apiKey: "k\n",
        model: "claude-haiku-4-5",
        maxTokens: 2048,
      },
      _fetch: (_url, init) => {
        sentBody = JSON.parse(String(init?.body));
        return fakeFetch({
          content: [{ type: "text", text: JSON.stringify(extracted) }],
          stop_reason: "end_turn",
          usage: { input_tokens: 900, output_tokens: 150 },
        })();
      },
      logger: { info() {} },
      writeResource: (spec, name, data) => {
        written.push({ spec, name, data });
        return Promise.resolve({ name });
      },
    },
  );
  assert("output_config" in sentBody, "uses structured outputs");
  assertEquals(written.length, 1);
  assertEquals(written[0].spec, "requirements");
  assertEquals(written[0].name, "requirements-latest");
  assertEquals(written[0].data.rooms, 2);
  assertEquals(written[0].data.destinationAirports, "HND,NRT");
});

Deno.test("extract writes nothing when Claude returns non-JSON", async () => {
  let writes = 0;
  await assertRejects(
    () =>
      model.methods.extract.execute(
        { request: "plan a trip", name: "latest" },
        {
          globalArgs: { apiKey: "k", model: "claude-haiku-4-5", maxTokens: 2048 },
          _fetch: fakeFetch({
            content: [{ type: "text", text: "not json" }],
            stop_reason: "end_turn",
          }),
          logger: { info() {} },
          writeResource: () => {
            writes++;
            return Promise.resolve({ name: "x" });
          },
        },
      ),
    Error,
    "non-JSON",
  );
  assertEquals(writes, 0);
});
