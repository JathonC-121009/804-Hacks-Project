import type { Estimate, Flag, ModelClass, Range, TokenCounts } from "./types.ts";
import {
  runQuery,
  type FirebaseWebConfig,
  type FirestoreClient,
  type FirestoreValue,
} from "./firestore.ts";

export const SYNC_EVENT_VERSION = 1;
export const LEADERBOARD_VERSION = 1;

/** A board entry below this is noise, and one reply at 100% would top the chart. */
export const LEADERBOARD_MIN_REPLIES = 5;

export interface SyncUsageEvent {
  version: typeof SYNC_EVENT_VERSION;
  id: string;
  timestamp: string;
  surface: "paste" | "web" | "cli";
  tool: string;
  modelClass: ModelClass;
  tokens: TokenCounts;
  totalOutputTokens: number;
  wastedOutputTokens: number;
  efficiency: number;
  flagTypes: Flag["type"][];
  resources: {
    total: { energyWh: Range; waterMl: Range; co2g: Range; cost: Range };
    wasted: { energyWh: Range; waterMl: Range; co2g: Range; cost: Range };
  };
}

export interface SyncEventInput {
  id?: string;
  timestamp?: string;
  surface: SyncUsageEvent["surface"];
  tool: string;
  modelClass: ModelClass;
  tokens: TokenCounts;
  totalOutputTokens: number;
  wastedOutputTokens: number;
  efficiency: number;
  flags: Flag[];
  estimate: Estimate;
}

/** Build the privacy-safe record shared by the portal, extension and CLI. */
export function syncUsageEvent(input: SyncEventInput): SyncUsageEvent {
  const timestamp = input.timestamp ?? new Date().toISOString();
  return {
    version: SYNC_EVENT_VERSION,
    id: input.id ?? `evt_${crypto.randomUUID()}`,
    timestamp,
    surface: input.surface,
    tool: input.tool.slice(0, 80),
    modelClass: input.modelClass,
    tokens: { ...input.tokens },
    totalOutputTokens: input.totalOutputTokens,
    wastedOutputTokens: input.wastedOutputTokens,
    efficiency: Math.max(0, Math.min(1, input.efficiency)),
    flagTypes: [...new Set(input.flags.map((flag) => flag.type))],
    resources: {
      total: {
        energyWh: { ...input.estimate.energyWh },
        waterMl: { ...input.estimate.waterMl },
        co2g: { ...input.estimate.co2g },
        cost: { ...input.estimate.cost },
      },
      wasted: {
        energyWh: { ...input.estimate.wasted.energyWh },
        waterMl: { ...input.estimate.wasted.waterMl },
        co2g: { ...input.estimate.wasted.co2g },
        cost: { ...input.estimate.wasted.cost },
      },
    },
  };
}

/** Firestore paths. One place, so the rules file and the clients cannot drift. */
export const paths = {
  profile: (uid: string) => `users/${uid}`,
  event: (uid: string, eventId: string) => `users/${uid}/events/${eventId}`,
  leaderboard: (uid: string) => `leaderboard/${uid}`,
  leaderboardCollection: "leaderboard",
};

/** Event IDs land in a URL path and a rules check, so keep the alphabet small. */
export function isValidEventId(id: string): boolean {
  return /^[A-Za-z0-9_:.-]{1,128}$/.test(id);
}

/**
 * Store one usage event under the signed-in user.
 *
 * On the free plan there is no server to post to, so the client writes the
 * document itself and firestore.rules is the validator. The event ID is the
 * document ID, which makes a retry idempotent instead of duplicating a row.
 */
export async function pushUsageEvent(
  client: FirestoreClient,
  event: SyncUsageEvent,
): Promise<void> {
  if (!isValidEventId(event.id)) throw new Error(`Unsafe event id: ${event.id}`);
  await client.setDocument(
    paths.event(client.uid, event.id),
    event as unknown as Record<string, FirestoreValue>,
  );
}

// --- leaderboard ------------------------------------------------------------

export interface LeaderboardEntry {
  version: typeof LEADERBOARD_VERSION;
  uid: string;
  /** User-chosen display name. Never an email: the board is world-readable. */
  alias: string;
  replies: number;
  totalOutputTokens: number;
  wastedOutputTokens: number;
  efficiency: number;
  savedEnergyWhLow: number;
  savedEnergyWhHigh: number;
  surfaces: string[];
  updatedAt: string;
}

export const ALIAS_MAX = 24;

/**
 * An alias that is not the user's email.
 *
 * The board is public by design (that is the social-ranking feature), so the
 * default must not leak who someone is. A uid prefix is stable, unguessable
 * backwards and means nothing to a stranger.
 */
export function defaultAlias(uid: string): string {
  return `anon-${uid.slice(0, 6).toLowerCase()}`;
}

export function cleanAlias(raw: string, uid: string): string {
  const trimmed = raw.replace(/[^\w .'-]/g, "").trim().slice(0, ALIAS_MAX);
  return trimmed.length >= 2 ? trimmed : defaultAlias(uid);
}

/**
 * Roll a user's own events into their public row.
 *
 * Aggregation runs on the client that already has the full event list, which
 * on the free plan means the portal. The extension and the CLI deliberately do
 * not touch this document: three writers incrementing one counter without a
 * transaction is how a leaderboard ends up disagreeing with its own dashboard.
 */
export function leaderboardEntry(
  uid: string,
  alias: string,
  events: SyncUsageEvent[],
  now = new Date(),
): LeaderboardEntry {
  let total = 0;
  let wasted = 0;
  let savedLow = 0;
  let savedHigh = 0;
  const surfaces = new Set<string>();
  for (const event of events) {
    total += event.totalOutputTokens;
    wasted += event.wastedOutputTokens;
    savedLow += event.resources.wasted.energyWh.low;
    savedHigh += event.resources.wasted.energyWh.high;
    surfaces.add(event.surface);
  }
  return {
    version: LEADERBOARD_VERSION,
    uid,
    alias: cleanAlias(alias, uid),
    replies: events.length,
    totalOutputTokens: total,
    wastedOutputTokens: wasted,
    efficiency: total > 0 ? Math.max(0, Math.min(1, 1 - wasted / total)) : 0,
    savedEnergyWhLow: savedLow,
    savedEnergyWhHigh: savedHigh,
    surfaces: [...surfaces].sort(),
    updatedAt: now.toISOString(),
  };
}

export async function putLeaderboardEntry(
  client: FirestoreClient,
  entry: LeaderboardEntry,
): Promise<void> {
  if (entry.uid !== client.uid) throw new Error("A leaderboard row can only be written by its owner.");
  await client.setDocument(
    paths.leaderboard(entry.uid),
    entry as unknown as Record<string, FirestoreValue>,
  );
}

/**
 * Order the board.
 *
 * Firestore sorts by efficiency alone, so the tie-break happens here: with two
 * users at the same efficiency the one who has measured more replies is ranked
 * higher, because their number is the one that survived more chances to be wrong.
 */
export function rankLeaderboard(
  entries: LeaderboardEntry[],
  minReplies = LEADERBOARD_MIN_REPLIES,
): LeaderboardEntry[] {
  return entries
    .filter((entry) => entry.replies >= minReplies)
    .sort((a, b) => b.efficiency - a.efficiency || b.replies - a.replies || a.uid.localeCompare(b.uid));
}

export function parseLeaderboardEntry(raw: Record<string, FirestoreValue>): LeaderboardEntry | null {
  const number = (key: string): number => (typeof raw[key] === "number" ? (raw[key] as number) : 0);
  const uid = typeof raw.uid === "string" ? raw.uid : "";
  if (!uid) return null;
  return {
    version: LEADERBOARD_VERSION,
    uid,
    alias: typeof raw.alias === "string" ? raw.alias : defaultAlias(uid),
    replies: number("replies"),
    totalOutputTokens: number("totalOutputTokens"),
    wastedOutputTokens: number("wastedOutputTokens"),
    efficiency: number("efficiency"),
    savedEnergyWhLow: number("savedEnergyWhLow"),
    savedEnergyWhHigh: number("savedEnergyWhHigh"),
    surfaces: Array.isArray(raw.surfaces) ? (raw.surfaces as FirestoreValue[]).map(String) : [],
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "",
  };
}

/** Read the public board. Works signed out, because the rules allow it. */
export async function fetchLeaderboard(
  config: FirebaseWebConfig,
  limit = 50,
): Promise<LeaderboardEntry[]> {
  const rows = await runQuery(config, {
    collection: paths.leaderboardCollection,
    orderBy: [{ field: "efficiency", direction: "DESCENDING" }],
    limit,
  });
  return rankLeaderboard(
    rows.map(parseLeaderboardEntry).filter((entry): entry is LeaderboardEntry => entry !== null),
  );
}
