import type { SyncUsageEvent } from "../../packages/core/src/index.ts";

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  functionsBaseUrl: string;
}

export interface PortalUser {
  uid: string;
  email: string;
}

type FirebaseFn = (...args: any[]) => any;

interface AuthApi {
  getAuth: FirebaseFn;
  onAuthStateChanged: FirebaseFn;
  createUserWithEmailAndPassword: FirebaseFn;
  signInWithEmailAndPassword: FirebaseFn;
  signOut: FirebaseFn;
}

interface FirestoreApi {
  getFirestore: FirebaseFn;
  collection: FirebaseFn;
  query: FirebaseFn;
  orderBy: FirebaseFn;
  limit: FirebaseFn;
  onSnapshot: FirebaseFn;
  setDoc: FirebaseFn;
  doc: FirebaseFn;
  serverTimestamp: FirebaseFn;
}

interface FirebaseModules {
  auth: AuthApi;
  firestore: FirestoreApi;
  authInstance: unknown;
  db: unknown;
}

const VERSION = "11.0.2";
let modules: FirebaseModules | null = null;
let config: FirebaseWebConfig | null = null;

async function importModule(url: string): Promise<Record<string, FirebaseFn>> {
  return (await import(url)) as Record<string, FirebaseFn>;
}

export async function initializeFirebase(nextConfig: FirebaseWebConfig): Promise<void> {
  if (!nextConfig.apiKey || !nextConfig.projectId || !nextConfig.appId) {
    throw new Error("Firebase is not configured. Add your web app values to config/firebase.json.");
  }
  config = nextConfig;
  const [app, auth, firestore] = await Promise.all([
    importModule(`https://www.gstatic.com/firebasejs/${VERSION}/firebase-app.js`),
    importModule(`https://www.gstatic.com/firebasejs/${VERSION}/firebase-auth.js`),
    importModule(`https://www.gstatic.com/firebasejs/${VERSION}/firebase-firestore.js`),
  ]);
  const firebaseApp = app.initializeApp!(nextConfig);
  modules = {
    auth: auth as unknown as AuthApi,
    firestore: firestore as unknown as FirestoreApi,
    authInstance: auth.getAuth!(firebaseApp),
    db: firestore.getFirestore!(firebaseApp),
  };
}

function ready(): FirebaseModules {
  if (!modules) throw new Error("Firebase has not initialized.");
  return modules;
}

function cleanAuthError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(message.replace(/^Firebase:\s*/i, "").replace(/\s*\(auth\/[\w-]+\)\.?$/i, ""));
}

export function observeUser(callback: (user: PortalUser | null) => void): () => void {
  const m = ready();
  return m.auth.onAuthStateChanged(m.authInstance, (raw: unknown) => {
    const user = raw as { uid?: string; email?: string } | null;
    callback(user?.uid ? { uid: user.uid, email: user.email ?? "Account" } : null);
  }) as () => void;
}

export async function createAccount(email: string, password: string): Promise<void> {
  const m = ready();
  try {
    await m.auth.createUserWithEmailAndPassword(m.authInstance, email, password);
  } catch (error) {
    throw cleanAuthError(error);
  }
}

export async function signIn(email: string, password: string): Promise<void> {
  const m = ready();
  try {
    await m.auth.signInWithEmailAndPassword(m.authInstance, email, password);
  } catch (error) {
    throw cleanAuthError(error);
  }
}

export async function signOut(): Promise<void> {
  const m = ready();
  await m.auth.signOut(m.authInstance);
}

export function observeEvents(uid: string, callback: (events: SyncUsageEvent[]) => void): () => void {
  const m = ready();
  const ref = m.firestore.collection(m.db, "users", uid, "events");
  const q = m.firestore.query(ref, m.firestore.orderBy("timestamp", "desc"), m.firestore.limit(500));
  return m.firestore.onSnapshot(q, (snapshot: unknown) => {
    const docs = (snapshot as { docs: { data(): unknown }[] }).docs;
    callback(docs.map((entry) => entry.data() as SyncUsageEvent));
  }, (error: unknown) => console.error("Usage subscription failed", error)) as () => void;
}

export async function saveEvent(uid: string, event: SyncUsageEvent): Promise<void> {
  const m = ready();
  await m.firestore.setDoc(m.firestore.doc(m.db, "users", uid, "events", event.id), event);
}

function randomKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createDeviceKey(uid: string, label: string): Promise<{ key: string; endpoint: string }> {
  const m = ready();
  if (!config?.functionsBaseUrl) throw new Error("functionsBaseUrl is missing from config/firebase.json.");
  const key = randomKey();
  const hash = await sha256(key);
  await m.firestore.setDoc(m.firestore.doc(m.db, "deviceTokens", hash), {
    uid,
    label: label.trim().slice(0, 60) || "Linked device",
    createdAt: m.firestore.serverTimestamp(),
  });
  return { key, endpoint: `${config.functionsBaseUrl.replace(/\/$/, "")}/ingestUsage` };
}
