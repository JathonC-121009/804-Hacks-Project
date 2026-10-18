import { createHash } from "node:crypto";
import { initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { onRequest } from "firebase-functions/v2/https";

initializeApp();
const db = getFirestore();

const allowedSurface = new Set(["paste", "web", "cli"]);
const allowedTier = new Set(["small", "medium", "large"]);

function cors(res) {
  res.set("access-control-allow-origin", "*");
  res.set("access-control-allow-headers", "authorization, content-type");
  res.set("access-control-allow-methods", "POST, OPTIONS");
}

function validEvent(value) {
  return value && value.version === 1 && typeof value.id === "string" && /^[A-Za-z0-9_:-]{1,128}$/.test(value.id) &&
    typeof value.timestamp === "string" && !Number.isNaN(Date.parse(value.timestamp)) && allowedSurface.has(value.surface) &&
    typeof value.tool === "string" && value.tool.length <= 80 &&
    allowedTier.has(value.modelClass) && typeof value.efficiency === "number" &&
    value.efficiency >= 0 && value.efficiency <= 1 &&
    Number.isFinite(value.totalOutputTokens) && Number.isFinite(value.wastedOutputTokens) &&
    value.totalOutputTokens >= 0 && value.totalOutputTokens <= 10000000 && value.wastedOutputTokens >= 0 &&
    value.wastedOutputTokens <= value.totalOutputTokens && value.resources && value.tokens;
}

export const ingestUsage = onRequest({ cors: false, maxInstances: 10 }, async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") return res.status(204).send("");
  if (req.method !== "POST") return res.status(405).send("POST required");

  const auth = req.get("authorization") ?? "";
  const key = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (key.length < 32 || key.length > 256) return res.status(401).send("Invalid device key");

  const hash = createHash("sha256").update(key).digest("hex");
  const token = await db.doc(`deviceTokens/${hash}`).get();
  if (!token.exists) return res.status(401).send("Unknown or revoked device key");

  const event = req.body?.event;
  if (!validEvent(event)) return res.status(400).send("Invalid usage event");
  const uid = token.data().uid;
  await db.doc(`users/${uid}/events/${event.id}`).set({
    ...event,
    ingestedAt: FieldValue.serverTimestamp(),
  }, { merge: false });
  return res.status(202).json({ ok: true, id: event.id });
});
