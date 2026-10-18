/**
 * End-to-end proof that the free-plan Firebase setup actually works.
 *
 * Unit tests stub fetch, which proves the client builds the right request but
 * not that your project accepts it. This signs in for real, writes an event,
 * reads it back, publishes a leaderboard row, reads the public board and
 * deletes what it wrote. Run it after configuring Firebase, and again before
 * the demo: it is the difference between "the rules deployed" and "the rules
 * allow what the app does".
 *
 *   npm run firebase:check -- --email you@example.com
 */

import { readFile } from "node:fs/promises";

import {
  FirestoreClient,
  fetchLeaderboard,
  isFirebaseConfigured,
  leaderboardEntry,
  paths,
  pushUsageEvent,
  putLeaderboardEntry,
  signInWithPassword,
  syncUsageEvent,
  type Estimate,
  type FirebaseWebConfig,
} from "../packages/core/src/index.ts";

function flag(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function ok(message: string): void {
  console.log(`  ok    ${message}`);
}

async function askPassword(label: string): Promise<string> {
  if (!process.stdin.isTTY) throw new Error("Set PROMPTFOOTPRINT_PASSWORD or run this in a terminal.");
  process.stderr.write(label);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = "";
  try {
    for await (const chunk of process.stdin) {
      const text = Buffer.from(chunk).toString("utf8");
      if (text.includes("\u0003")) throw new Error("Cancelled.");
      if (text.includes("\r") || text.includes("\n")) break;
      value = text === "\u007f" ? value.slice(0, -1) : value + text.replace(/[\u0000-\u001f]/g, "");
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stderr.write("\n");
  }
  return value;
}

const range = (unit: string) => ({ low: 0.5, high: 1.5, unit });
const estimate: Estimate = {
  energyWh: range("Wh"),
  waterMl: range("mL"),
  co2g: range("g"),
  cost: range("USD"),
  wasted: { energyWh: range("Wh"), waterMl: range("mL"), co2g: range("g"), cost: range("USD") },
  provenance: { unverified: [], assumptions: [], gridSource: "fallback" },
};

const config = JSON.parse(
  await readFile(new URL("../config/firebase.json", import.meta.url), "utf8"),
) as FirebaseWebConfig;

if (!isFirebaseConfigured(config)) {
  console.error("config/firebase.json still holds placeholders. Fill it in first (README > Connect Firebase).");
  process.exit(1);
}
console.log(`Project: ${config.projectId}\n`);

const email = flag("email") ?? process.env.PROMPTFOOTPRINT_EMAIL;
if (!email) {
  console.error("Usage: npm run firebase:check -- --email you@example.com");
  process.exit(1);
}
const password = process.env.PROMPTFOOTPRINT_PASSWORD ?? (await askPassword(`Password for ${email}: `));

const session = await signInWithPassword(config.apiKey, email, password);
ok(`signed in as ${email} (uid ${session.uid.slice(0, 8)}…)`);

const client = new FirestoreClient(config, session);
const event = syncUsageEvent({
  id: `evt_check_${Date.now()}`,
  surface: "cli",
  tool: "firebase-check",
  modelClass: "large",
  tokens: { input: 12, output: 40, reasoning: 0, cache_read: 0, cache_write: 0 },
  totalOutputTokens: 40,
  wastedOutputTokens: 9,
  efficiency: 0.775,
  flags: [],
  estimate,
});

await pushUsageEvent(client, event);
ok("wrote a usage event (rules accepted the document shape)");

const stored = await client.getDocument(paths.event(client.uid, event.id));
if (!stored || stored.efficiency !== event.efficiency) throw new Error("Read back the wrong document.");
ok("read it back with the same numbers");

const history = await client.queryCollection(paths.profile(client.uid), {
  collectionId: "events",
  orderBy: [{ field: "timestamp", direction: "DESCENDING" }],
  limit: 5,
});
ok(`queried your event history (${history.length} recent event${history.length === 1 ? "" : "s"})`);

await putLeaderboardEntry(client, leaderboardEntry(client.uid, "", [event]));
ok("published your public leaderboard row");

const board = await fetchLeaderboard(config, 10);
ok(`read the public leaderboard signed out (${board.length} qualifying row${board.length === 1 ? "" : "s"})`);

// Clean up: this was a synthetic reading and it should not pollute the real
// dashboard. The leaderboard row stays, because it is yours either way.
const response = await fetch(
  `https://firestore.googleapis.com/v1/projects/${config.projectId}/databases/(default)/documents/${paths.event(client.uid, event.id)}`,
  { method: "DELETE", headers: { authorization: `Bearer ${client.snapshot().idToken}` } },
);
if (!response.ok) throw new Error(`Could not delete the test event: HTTP ${response.status}`);
ok("deleted the test event");

console.log("\nEverything the three surfaces need is working on the free plan.");
