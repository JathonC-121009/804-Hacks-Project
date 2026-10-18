import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FirestoreClient,
  cleanAlias,
  decodeFields,
  defaultAlias,
  encodeFields,
  encodeValue,
  isFirebaseConfigured,
  isValidEventId,
  leaderboardEntry,
  paths,
  pushUsageEvent,
  putLeaderboardEntry,
  rankLeaderboard,
  syncUsageEvent,
  type AuthSession,
  type Estimate,
  type FirebaseWebConfig,
  type LeaderboardEntry,
  type SyncUsageEvent,
} from "../src/index.ts";

const config: FirebaseWebConfig = {
  apiKey: "test-key",
  authDomain: "demo.firebaseapp.com",
  projectId: "demo-project",
  appId: "1:2:web:3",
};

function session(overrides: Partial<AuthSession> = {}): AuthSession {
  return {
    uid: "uid123",
    idToken: "id-token",
    refreshToken: "refresh-token",
    expiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

const range = (unit: string, low = 1, high = 2) => ({ low, high, unit });
const estimate: Estimate = {
  energyWh: range("Wh"), waterMl: range("mL"), co2g: range("g"), cost: range("USD"),
  wasted: { energyWh: range("Wh"), waterMl: range("mL"), co2g: range("g"), cost: range("USD") },
  provenance: { unverified: [], assumptions: [], gridSource: "fallback" },
};

function event(overrides: Partial<SyncUsageEvent> = {}): SyncUsageEvent {
  return {
    ...syncUsageEvent({
      id: "evt_1",
      timestamp: "2026-10-18T12:00:00.000Z",
      surface: "cli",
      tool: "gemini",
      modelClass: "large",
      tokens: { input: 10, output: 40, reasoning: 0, cache_read: 0, cache_write: 0 },
      totalOutputTokens: 40,
      wastedOutputTokens: 10,
      efficiency: 0.75,
      flags: [],
      estimate,
    }),
    ...overrides,
  };
}

/** Replace global fetch for one call and record what was sent. */
function captureFetch(response: { status?: number; body?: unknown } = {}) {
  const calls: { url: string; init: RequestInit }[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return {
      ok: (response.status ?? 200) < 400,
      status: response.status ?? 200,
      text: async () => JSON.stringify(response.body ?? {}),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("values survive a round trip through Firestore's typed encoding", () => {
  const original = {
    name: "anon-abc123",
    replies: 12,
    efficiency: 0.8125,
    nested: { low: 0, high: 2.5, unit: "Wh" },
    surfaces: ["cli", "web"],
    missing: null,
    flag: true,
  };
  const round = decodeFields(encodeFields(original as never));
  assert.deepEqual(round, original);
});

test("whole numbers stay integers so token counts come back exact", () => {
  assert.deepEqual(encodeValue(40), { integerValue: "40" });
  assert.deepEqual(encodeValue(0.5), { doubleValue: 0.5 });
  assert.throws(() => encodeValue(Number.NaN), /NaN/);
});

test("placeholder config is treated as unconfigured", () => {
  assert.equal(isFirebaseConfigured(config), true);
  assert.equal(isFirebaseConfigured({ ...config, apiKey: "YOUR_FIREBASE_WEB_API_KEY" }), false);
  assert.equal(isFirebaseConfigured(null), false);
});

test("an event is written to its own document id, which makes a retry idempotent", async () => {
  const fetchStub = captureFetch();
  try {
    const client = new FirestoreClient(config, session());
    await pushUsageEvent(client, event());
    assert.equal(fetchStub.calls.length, 1);
    const call = fetchStub.calls[0]!;
    assert.match(call.url, /projects\/demo-project\/databases\/\(default\)\/documents\/users\/uid123\/events\/evt_1$/);
    assert.equal(call.init.method, "PATCH");
    const sent = JSON.parse(String(call.init.body));
    assert.deepEqual(sent.fields.totalOutputTokens, { integerValue: "40" });
    assert.equal(sent.fields.resources.mapValue.fields.wasted.mapValue.fields.energyWh.mapValue.fields.unit.stringValue, "Wh");
  } finally {
    fetchStub.restore();
  }
});

test("a document id that could escape its path is refused before any request", async () => {
  const fetchStub = captureFetch();
  try {
    const client = new FirestoreClient(config, session());
    await assert.rejects(() => pushUsageEvent(client, event({ id: "../../leaderboard/someone" })), /Unsafe event id/);
    assert.equal(fetchStub.calls.length, 0);
  } finally {
    fetchStub.restore();
  }
  assert.equal(isValidEventId("evt_2026-10-18T12:00:00.000Z"), true);
  assert.equal(isValidEventId("a/b"), false);
  assert.equal(isValidEventId(""), false);
});

test("an expired session is refreshed once and the new token is handed back for storage", async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  let saved: AuthSession | null = null;
  globalThis.fetch = (async (url: string) => {
    urls.push(String(url));
    if (String(url).includes("securetoken")) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ user_id: "uid123", id_token: "fresh", refresh_token: "r2", expires_in: "3600" }),
      } as unknown as Response;
    }
    return { ok: true, status: 200, text: async () => "{}" } as unknown as Response;
  }) as unknown as typeof fetch;
  try {
    const client = new FirestoreClient(config, session({ expiresAt: Date.now() - 1000 }), {
      onSession: (next) => { saved = next; },
    });
    // Two writes at once: one refresh, not two, or the second spends a token
    // that the first has already replaced.
    await Promise.all([pushUsageEvent(client, event()), pushUsageEvent(client, event({ id: "evt_2" }))]);
    assert.equal(urls.filter((url) => url.includes("securetoken")).length, 1);
    assert.equal(client.snapshot().idToken, "fresh");
    assert.equal((saved as AuthSession | null)?.refreshToken, "r2");
  } finally {
    globalThis.fetch = original;
  }
});

test("a Google error code is turned into a sentence a person can act on", async () => {
  const fetchStub = captureFetch({ status: 400, body: { error: { message: "INVALID_LOGIN_CREDENTIALS" } } });
  try {
    const { signInWithPassword } = await import("../src/firestore.ts");
    await assert.rejects(() => signInWithPassword("k", "a@b.c", "nope"), /Wrong email or password/);
  } finally {
    fetchStub.restore();
  }
});

test("a leaderboard row aggregates a user's own events and nothing else", () => {
  const entry = leaderboardEntry("uid123", "Ryan", [
    event({ totalOutputTokens: 100, wastedOutputTokens: 20 }),
    event({ id: "evt_2", surface: "web", totalOutputTokens: 100, wastedOutputTokens: 40 }),
  ], new Date("2026-10-18T12:00:00.000Z"));
  assert.equal(entry.replies, 2);
  assert.equal(entry.totalOutputTokens, 200);
  assert.equal(entry.wastedOutputTokens, 60);
  assert.equal(entry.efficiency, 0.7);
  assert.deepEqual(entry.surfaces, ["cli", "web"]);
  assert.equal(entry.savedEnergyWhLow, 2);
  assert.doesNotMatch(JSON.stringify(entry), /gemini|prompt|response/);
});

test("the public alias is never an email address", () => {
  assert.equal(defaultAlias("abcdef123456"), "anon-abcdef");
  assert.equal(cleanAlias("ryan@example.com", "abcdef123456"), "ryanexample.com");
  assert.equal(cleanAlias(" a ", "abcdef123456"), "anon-abcdef");
  assert.equal(cleanAlias("x".repeat(80), "abcdef123456").length, 24);
});

test("only the owner may write their leaderboard row", async () => {
  const fetchStub = captureFetch();
  try {
    const client = new FirestoreClient(config, session());
    const entry = leaderboardEntry("someone-else", "Imposter", [event()]);
    await assert.rejects(() => putLeaderboardEntry(client, entry), /only be written by its owner/);
    assert.equal(fetchStub.calls.length, 0);
    await putLeaderboardEntry(client, leaderboardEntry("uid123", "Me", [event()]));
    assert.match(fetchStub.calls[0]!.url, /documents\/leaderboard\/uid123$/);
  } finally {
    fetchStub.restore();
  }
});

test("ranking hides thin samples and breaks ties by how much was measured", () => {
  const row = (uid: string, efficiency: number, replies: number): LeaderboardEntry => ({
    version: 1, uid, alias: uid, replies, totalOutputTokens: replies * 100,
    wastedOutputTokens: Math.round(replies * 100 * (1 - efficiency)), efficiency,
    savedEnergyWhLow: 0, savedEnergyWhHigh: 0, surfaces: ["cli"], updatedAt: "",
  });
  const ranked = rankLeaderboard([
    row("thin", 1, 1),
    row("steady", 0.9, 40),
    row("lucky", 0.9, 6),
    row("worse", 0.6, 90),
  ]);
  assert.deepEqual(ranked.map((entry) => entry.uid), ["steady", "lucky", "worse"]);
});

test("paths are built in one place so the rules file and the clients agree", () => {
  assert.equal(paths.event("u", "e"), "users/u/events/e");
  assert.equal(paths.leaderboard("u"), "leaderboard/u");
  assert.equal(paths.profile("u"), "users/u");
});
