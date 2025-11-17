import Redis from "ioredis";

export function createSessionStore(redisUrl) {
  const client = new Redis(redisUrl);
  return client;
}

export async function saveSession(store, session) {
  const key = `upload:session:${session.uploadId}`;
  const ttl = Math.max(60, Math.floor((session.expiresAt - Date.now()) / 1000));
  await store.set(key, JSON.stringify(session), "EX", ttl);
}

export async function getSession(store, uploadId) {
  const key = `upload:session:${uploadId}`;
  const raw = await store.get(key);
  if (!raw) return null;
  return JSON.parse(raw);
}

export async function deleteSession(store, uploadId) {
  const key = `upload:session:${uploadId}`;
  return store.del(key);
}
