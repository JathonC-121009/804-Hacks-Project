/**
 * Firebase Auth + Firestore over plain REST, with no SDK and no dependencies.
 *
 * Why REST instead of the firebase npm package:
 *   1. the free Spark plan has no Cloud Functions, so every surface has to talk
 *      to Firestore directly as the signed-in user, and the security rules are
 *      the only thing standing between a client and the database;
 *   2. a content script cannot be an ES module and the extension has no
 *      bundler, so pulling in the modular SDK would mean adding a build system
 *      whose only job is this file;
 *   3. the CLI runs on Node with zero installs. `fetch` and `crypto` are all
 *      three surfaces share, so that is the whole API surface used here.
 *
 * Nothing in this file knows what a usage event is. It moves documents.
 */

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
}

/** A signed-in user. `expiresAt` is epoch milliseconds, not a duration. */
export interface AuthSession {
  uid: string;
  idToken: string;
  refreshToken: string;
  expiresAt: number;
}

export type FirestoreValue =
  | string
  | number
  | boolean
  | null
  | FirestoreValue[]
  | { [key: string]: FirestoreValue };

const IDENTITY = "https://identitytoolkit.googleapis.com/v1";
const SECURE_TOKEN = "https://securetoken.googleapis.com/v1";
const FIRESTORE = "https://firestore.googleapis.com/v1";

/** Every host this module contacts. The extension manifest needs all of them. */
export const FIREBASE_ORIGINS = [
  "https://identitytoolkit.googleapis.com/*",
  "https://securetoken.googleapis.com/*",
  "https://firestore.googleapis.com/*",
];

/**
 * Google's error bodies are `{error:{message:"INVALID_LOGIN_CREDENTIALS"}}`.
 * Shouting that at a user is not an error message, so map the ones that are
 * actually the user's problem and pass anything else through unchanged.
 */
const AUTH_MESSAGES: Record<string, string> = {
  EMAIL_EXISTS: "That email already has an account. Sign in instead.",
  EMAIL_NOT_FOUND: "No account with that email.",
  INVALID_PASSWORD: "Wrong password.",
  INVALID_LOGIN_CREDENTIALS: "Wrong email or password.",
  INVALID_EMAIL: "That is not a valid email address.",
  WEAK_PASSWORD: "Password must be at least 6 characters.",
  TOKEN_EXPIRED: "Session expired. Sign in again.",
  INVALID_REFRESH_TOKEN: "Session is no longer valid. Sign in again.",
  TOO_MANY_ATTEMPTS_TRY_LATER: "Too many attempts. Wait a minute and try again.",
  OPERATION_NOT_ALLOWED:
    "Email/password sign-in is switched off in the Firebase console (Authentication > Sign-in method).",
};

async function post(url: string, body: unknown, idToken?: string): Promise<any> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(idToken ? { authorization: `Bearer ${idToken}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) throw firebaseError(parsed, response.status);
  return parsed;
}

function firebaseError(payload: any, status: number): Error {
  const raw = String(payload?.error?.message ?? payload?.error ?? `HTTP ${status}`);
  const code = raw.split(/\s*:\s*/)[0] ?? raw;
  return new Error(AUTH_MESSAGES[code] ?? raw);
}

function sessionFrom(payload: any): AuthSession {
  const uid = payload.localId ?? payload.user_id;
  const idToken = payload.idToken ?? payload.id_token;
  const refreshToken = payload.refreshToken ?? payload.refresh_token;
  const seconds = Number(payload.expiresIn ?? payload.expires_in ?? 3600);
  if (!uid || !idToken || !refreshToken) throw new Error("Firebase returned an incomplete session.");
  return { uid, idToken, refreshToken, expiresAt: Date.now() + seconds * 1000 };
}

export async function signUp(
  apiKey: string,
  email: string,
  password: string,
): Promise<AuthSession> {
  return sessionFrom(
    await post(`${IDENTITY}/accounts:signUp?key=${encodeURIComponent(apiKey)}`, {
      email,
      password,
      returnSecureToken: true,
    }),
  );
}

export async function signInWithPassword(
  apiKey: string,
  email: string,
  password: string,
): Promise<AuthSession> {
  return sessionFrom(
    await post(`${IDENTITY}/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`, {
      email,
      password,
      returnSecureToken: true,
    }),
  );
}

export async function refreshSession(apiKey: string, refreshToken: string): Promise<AuthSession> {
  return sessionFrom(
    await post(`${SECURE_TOKEN}/token?key=${encodeURIComponent(apiKey)}`, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  );
}

// --- document values --------------------------------------------------------

/**
 * Firestore's REST shape is `{stringValue:"a"}` rather than `"a"`, so plain
 * objects have to be walked on the way in and on the way out.
 *
 * Integers and doubles are separate types in Firestore, and a token count that
 * arrives back as 1.0000000000000002 is a worse outcome than a slightly longer
 * encoder, so whole numbers are sent as integerValue.
 */
export function encodeValue(value: FirestoreValue): any {
  if (value === null) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Firestore cannot store NaN or Infinity.");
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  return { mapValue: { fields: encodeFields(value) } };
}

export function encodeFields(value: Record<string, FirestoreValue>): Record<string, any> {
  const fields: Record<string, any> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    fields[key] = encodeValue(entry);
  }
  return fields;
}

export function decodeValue(value: any): FirestoreValue {
  if (!value || typeof value !== "object") return null;
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return Boolean(value.booleanValue);
  if ("stringValue" in value) return String(value.stringValue);
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("timestampValue" in value) return String(value.timestampValue);
  if ("arrayValue" in value) return (value.arrayValue.values ?? []).map(decodeValue);
  if ("mapValue" in value) return decodeFields(value.mapValue.fields ?? {});
  return null;
}

export function decodeFields(fields: Record<string, any>): Record<string, FirestoreValue> {
  const out: Record<string, FirestoreValue> = {};
  for (const [key, value] of Object.entries(fields)) out[key] = decodeValue(value);
  return out;
}

// --- client -----------------------------------------------------------------

export interface FirestoreClientOptions {
  /** Called whenever the session is replaced, so the caller can persist it. */
  onSession?: (session: AuthSession) => void | Promise<void>;
}

/**
 * A signed-in handle on one project's default database.
 *
 * Holds the session and refreshes it a minute before expiry. An ID token lasts
 * an hour; a CLI invocation or a chat tab left open overnight will outlive it,
 * and a sync that fails at 3am with "token expired" is a sync that silently
 * stops working.
 */
export class FirestoreClient {
  readonly config: FirebaseWebConfig;
  private session: AuthSession;
  private readonly onSession: FirestoreClientOptions["onSession"];
  private refreshing: Promise<void> | null = null;

  constructor(config: FirebaseWebConfig, session: AuthSession, options: FirestoreClientOptions = {}) {
    this.config = config;
    this.session = session;
    this.onSession = options.onSession;
  }

  get uid(): string {
    return this.session.uid;
  }

  /** The current session, for persisting after a refresh. */
  snapshot(): AuthSession {
    return { ...this.session };
  }

  private async token(): Promise<string> {
    if (this.session.expiresAt - Date.now() > 60_000) return this.session.idToken;
    // One refresh at a time: a page that finishes three replies at once would
    // otherwise spend three refresh tokens and keep only the last.
    this.refreshing ??= (async () => {
      const next = await refreshSession(this.config.apiKey, this.session.refreshToken);
      this.session = next;
      await this.onSession?.(next);
    })().finally(() => {
      this.refreshing = null;
    });
    await this.refreshing;
    return this.session.idToken;
  }

  private documentUrl(path: string): string {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return `${FIRESTORE}/projects/${encodeURIComponent(this.config.projectId)}/databases/(default)/documents/${encoded}`;
  }

  /**
   * Replace a document, creating it if absent: the REST equivalent of the
   * SDK's setDoc. PATCH with no updateMask replaces the whole document, which
   * is what every caller here wants.
   */
  async setDocument(path: string, data: Record<string, FirestoreValue>): Promise<void> {
    const idToken = await this.token();
    const response = await fetch(this.documentUrl(path), {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
      body: JSON.stringify({ fields: encodeFields(data) }),
    });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw firebaseError(text ? JSON.parse(text) : {}, response.status);
    }
  }

  /**
   * Query a subcollection as the signed-in user.
   *
   * `parentPath` is the document the collection hangs off ("users/abc"), empty
   * for a root collection. Only single-field ordering is used so that Firestore's
   * automatic indexes cover it and no composite index has to be deployed.
   */
  async queryCollection(
    parentPath: string,
    options: { collectionId: string; orderBy?: { field: string; direction: "ASCENDING" | "DESCENDING" }[]; limit?: number },
  ): Promise<Record<string, FirestoreValue>[]> {
    const idToken = await this.token();
    const parent = parentPath ? `/${parentPath.split("/").map(encodeURIComponent).join("/")}` : "";
    const url =
      `${FIRESTORE}/projects/${encodeURIComponent(this.config.projectId)}/databases/(default)/documents${parent}:runQuery`;
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: options.collectionId }],
          ...(options.orderBy?.length
            ? { orderBy: options.orderBy.map((o) => ({ field: { fieldPath: o.field }, direction: o.direction })) }
            : {}),
          ...(options.limit ? { limit: options.limit } : {}),
        },
      }),
    });
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : [];
    if (!response.ok) throw firebaseError(Array.isArray(parsed) ? parsed[0] : parsed, response.status);
    return (Array.isArray(parsed) ? parsed : [])
      .filter((row: any) => row?.document?.fields)
      .map((row: any) => decodeFields(row.document.fields));
  }

  async getDocument(path: string): Promise<Record<string, FirestoreValue> | null> {
    const idToken = await this.token();
    const response = await fetch(this.documentUrl(path), {
      headers: { authorization: `Bearer ${idToken}` },
    });
    if (response.status === 404) return null;
    const text = await response.text();
    const parsed = text ? JSON.parse(text) : {};
    if (!response.ok) throw firebaseError(parsed, response.status);
    return decodeFields(parsed.fields ?? {});
  }
}

export interface QueryOptions {
  collection: string;
  orderBy?: { field: string; direction: "ASCENDING" | "DESCENDING" }[];
  limit?: number;
  /** An ID token, when the rules require one. Public collections need none. */
  idToken?: string;
}

/**
 * Read a collection without being signed in.
 *
 * The leaderboard is world-readable by rule, so a visitor who has not made an
 * account can still see it. Only single-field ordering is used, because
 * Firestore indexes those automatically and a composite index is one more
 * thing to have forgotten to deploy.
 */
export async function runQuery(
  config: FirebaseWebConfig,
  options: QueryOptions,
): Promise<Record<string, FirestoreValue>[]> {
  const url =
    `${FIRESTORE}/projects/${encodeURIComponent(config.projectId)}/databases/(default)/documents:runQuery` +
    `?key=${encodeURIComponent(config.apiKey)}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(options.idToken ? { authorization: `Bearer ${options.idToken}` } : {}),
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: options.collection }],
        ...(options.orderBy?.length
          ? { orderBy: options.orderBy.map((o) => ({ field: { fieldPath: o.field }, direction: o.direction })) }
          : {}),
        ...(options.limit ? { limit: options.limit } : {}),
      },
    }),
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : [];
  if (!response.ok) throw firebaseError(Array.isArray(parsed) ? parsed[0] : parsed, response.status);
  // runQuery streams; rows without a `document` are readTime-only heartbeats.
  return (Array.isArray(parsed) ? parsed : [])
    .filter((row: any) => row?.document?.fields)
    .map((row: any) => decodeFields(row.document.fields));
}

export function isFirebaseConfigured(config: Partial<FirebaseWebConfig> | null): boolean {
  if (!config) return false;
  const values = [config.apiKey, config.projectId, config.appId];
  return values.every((value) => typeof value === "string" && value.length > 0 && !value.startsWith("YOUR_"));
}
