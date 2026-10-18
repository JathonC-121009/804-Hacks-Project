/**
 * The portal's Firebase layer.
 *
 * Runs entirely on the free Spark plan: Authentication, Firestore and Hosting,
 * with no Cloud Functions anywhere. It also uses no Firebase SDK - the same
 * REST client the extension and the CLI use lives in packages/core, so there is
 * one auth implementation and one set of document paths across all three
 * surfaces. The practical reason is the demo: a page that imports the SDK from
 * a CDN is a page that shows a blank dashboard on bad venue wifi.
 *
 * The trade for dropping the SDK is onSnapshot. Live events are polled instead,
 * which is the right shape for the free plan anyway: Spark allows 50,000
 * document reads a day, and a poll has a known cost per minute where an open
 * listener does not.
 */

import {
  FirestoreClient,
  fetchLeaderboard,
  isFirebaseConfigured,
  leaderboardEntry,
  paths,
  pushUsageEvent,
  putLeaderboardEntry,
  refreshSession,
  signInWithPassword,
  signUp,
  type AuthSession,
  type FirebaseWebConfig,
  type LeaderboardEntry,
  type SyncUsageEvent,
} from "../../packages/core/src/index.ts";

export type { FirebaseWebConfig, LeaderboardEntry };

export interface PortalUser {
  uid: string;
  email: string;
}

const SESSION_KEY = "promptfootprint.session";
const EMAIL_KEY = "promptfootprint.email";
/** Spark allows 50k reads a day. One tab polling this often costs ~4.3k. */
const POLL_MS = 20_000;
const EVENT_LIMIT = 500;

let config: FirebaseWebConfig | null = null;
let client: FirestoreClient | null = null;
let currentUser: PortalUser | null = null;
let listener: ((user: PortalUser | null) => void) | null = null;

function store(session: AuthSession | null, email?: string): void {
  try {
    if (!session) {
      localStorage.removeItem(SESSION_KEY);
      localStorage.removeItem(EMAIL_KEY);
      return;
    }
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    if (email) localStorage.setItem(EMAIL_KEY, email);
  } catch {
    // Private browsing denies localStorage. The session still works for this
    // page load; it just will not survive a reload.
  }
}

function restore(): { session: AuthSession; email: string } | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as AuthSession;
    if (!session?.uid || !session.refreshToken) return null;
    return { session, email: localStorage.getItem(EMAIL_KEY) ?? "Your account" };
  } catch {
    return null;
  }
}

function adopt(session: AuthSession, email: string): void {
  const cfg = requireConfig();
  client = new FirestoreClient(cfg, session, { onSession: (next) => store(next, email) });
  currentUser = { uid: session.uid, email };
  store(session, email);
  listener?.(currentUser);
}

function requireConfig(): FirebaseWebConfig {
  if (!config) throw new Error("Firebase has not initialized.");
  return config;
}

export function requireClient(): FirestoreClient {
  if (!client) throw new Error("You are not signed in.");
  return client;
}

/**
 * Validate the config and pick up an existing session.
 *
 * A stored refresh token is traded for a fresh ID token here rather than on
 * first write, so a user whose session has actually been revoked sees the
 * sign-in screen instead of an error after typing a prompt.
 */
export async function initializeFirebase(nextConfig: FirebaseWebConfig): Promise<void> {
  if (!isFirebaseConfigured(nextConfig)) {
    throw new Error(
      "Firebase is not configured. Copy config/firebase.example.json to config/firebase.json and paste your web app values.",
    );
  }
  config = nextConfig;
  const saved = restore();
  if (!saved) return;
  try {
    const session = await refreshSession(nextConfig.apiKey, saved.session.refreshToken);
    adopt(session, saved.email);
  } catch {
    store(null);
  }
}

export function observeUser(callback: (user: PortalUser | null) => void): () => void {
  listener = callback;
  callback(currentUser);
  return () => {
    listener = null;
  };
}

export async function createAccount(email: string, password: string): Promise<void> {
  const session = await signUp(requireConfig().apiKey, email, password);
  adopt(session, email);
}

export async function signIn(email: string, password: string): Promise<void> {
  const session = await signInWithPassword(requireConfig().apiKey, email, password);
  adopt(session, email);
}

export async function signOut(): Promise<void> {
  client = null;
  currentUser = null;
  store(null);
  listener?.(null);
}

function parseEvent(raw: Record<string, unknown>): SyncUsageEvent | null {
  return typeof raw.id === "string" && typeof raw.efficiency === "number"
    ? (raw as unknown as SyncUsageEvent)
    : null;
}

export async function loadEvents(uid: string): Promise<SyncUsageEvent[]> {
  const rows = await requireClient().queryCollection(paths.profile(uid), {
    collectionId: "events",
    orderBy: [{ field: "timestamp", direction: "DESCENDING" }],
    limit: EVENT_LIMIT,
  });
  return rows.map(parseEvent).filter((event): event is SyncUsageEvent => event !== null);
}

/**
 * Load now, then poll, so events written by the extension and the CLI show up
 * in an already-open dashboard. Polling stops while the tab is hidden: a
 * forgotten background tab should not spend the day's free read quota.
 */
export function observeEvents(
  uid: string,
  callback: (events: SyncUsageEvent[]) => void,
): () => void {
  let stopped = false;
  const tick = async (): Promise<void> => {
    if (stopped || document.hidden) return;
    try {
      callback(await loadEvents(uid));
    } catch (error) {
      console.error("Loading usage history failed", error);
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), POLL_MS);
  const onVisible = (): void => {
    if (!document.hidden) void tick();
  };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    stopped = true;
    clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

export async function saveEvent(_uid: string, event: SyncUsageEvent): Promise<void> {
  await pushUsageEvent(requireClient(), event);
}

export async function loadAlias(uid: string): Promise<string> {
  const profile = await requireClient().getDocument(paths.profile(uid));
  return typeof profile?.alias === "string" ? profile.alias : "";
}

export async function saveAlias(uid: string, alias: string): Promise<void> {
  await requireClient().setDocument(paths.profile(uid), {
    alias,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Publish this user's public row.
 *
 * The portal is the only writer: it is the one surface holding the full event
 * list, so its total is the only one that can be right. The extension and CLI
 * write events and let this recompute.
 */
export async function publishLeaderboard(
  uid: string,
  alias: string,
  events: SyncUsageEvent[],
): Promise<LeaderboardEntry> {
  const entry = leaderboardEntry(uid, alias, events);
  await putLeaderboardEntry(requireClient(), entry);
  return entry;
}

/** The board is world-readable, so this works before anyone signs in. */
export async function loadLeaderboard(): Promise<LeaderboardEntry[]> {
  return fetchLeaderboard(requireConfig(), 50);
}
