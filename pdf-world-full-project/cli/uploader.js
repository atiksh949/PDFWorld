#!/usr/bin/env node
import fs from "fs";
import path from "path";
import crypto from "crypto";
import fetch from "node-fetch";

const argv = process.argv.slice(2);
if (argv.length === 0) {
  console.log("Usage: node cli/uploader.js <file> [--server=http://localhost:4000] [--mode=presigned|proxy]"); process.exit(1);
}
const filePath = argv[0];
const opts = Object.fromEntries(argv.slice(1).map(s=>{
  const [k,v] = s.split("=");
  return [k.replace(/^--/,""), v || true];
}));
const server = opts.server || "http://localhost:4000";
const mode = opts.mode || "presigned";

function sha256Hex(buf) { return crypto.createHash("sha256").update(buf).digest("hex"); }

async function createSession(fileName, fileSize) {
  const r = await fetch(`${server}/sessions`, { method: "POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ fileName, fileSize, mimeType:"application/octet-stream", storageStrategy: mode }) });
  if (!r.ok) throw new Error("create session failed: " + await r.text());
  return r.json();
}
async function getPresign(uploadId, idx) {
  const r = await fetch(`${server}/sessions/${uploadId}/presign/${idx}`, { method: "POST" });
  if (!r.ok) throw new Error("presign failed: " + await r.text());
  return r.json();
}
async function presignedPut(url, buffer) {
  const r = await fetch(url, { method: "PUT", body: buffer, headers: { "Content-Length": String(buffer.byteLength) } });
  if (!r.ok) throw new Error("presigned put failed: " + r.status);
  return { etag: r.headers.get("etag") || null };
}

async function run() {
  const stat = fs.statSync(filePath);
  const fileName = path.basename(filePath);
  const created = await createSession(fileName, stat.size);
  const session = { uploadId: created.uploadId, fileName, size: stat.size, chunkSize: created.chunkSize, totalChunks: created.totalChunks, storageStrategy: created.storageStrategy, uploadedParts: {} };
  const fd = fs.openSync(filePath, "r");
  for (let i = 0; i < session.totalChunks; i++) {
    const start = i * session.chunkSize;
    const end = Math.min(session.size, start + session.chunkSize);
    const len = end - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    const checksum = sha256Hex(buf);
    if (session.storageStrategy === "presigned") {
      const pres = await getPresign(session.uploadId, i);
      const putResp = await presignedPut(pres.url, buf);
      session.uploadedParts[i] = { checksum, etag: putResp.etag, size: len };
      process.stdout.write(`uploaded ${i} `);
    }
  }
  fs.closeSync(fd);
  const parts = [];
  for (let i = 0; i < session.totalChunks; i++) parts.push({ index: i, checksum: session.uploadedParts[i].checksum });
  const commit = await fetch(`${server}/sessions/${session.uploadId}/commit`, { method: "POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ parts }) }).then(r=>r.json());
  console.log("Commit response:", commit);
}

run().catch(err=>{ console.error(err); process.exit(1); });
