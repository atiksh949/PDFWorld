/**
 * PDF World — server.js
 * Express server implementing hybrid upload API (presigned + proxy) using LocalStack S3 and Redis.
 */

import express from "express";
import bodyParser from "body-parser";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import crypto from "crypto";
import dotenv from "dotenv";
dotenv.config();

import { S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand, CreateBucketCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createSessionStore, saveSession, getSession, deleteSession } from "./src/services/sessionStore.js";

const {
  AWS_REGION = "us-east-1",
  S3_BUCKET = "pdf-world-bucket",
  LOCALSTACK_ENDPOINT,
  REDIS_URL = "redis://localhost:6379",
  PORT = 4000,
  PRESIGNED_EXPIRES = 900
} = process.env;

const app = express();
app.use(bodyParser.json({ limit: "50mb" }));

const upload = multer();

const s3client = new S3Client({
  region: AWS_REGION,
  endpoint: LOCALSTACK_ENDPOINT || undefined,
  forcePathStyle: !!LOCALSTACK_ENDPOINT
});

const sessionStore = createSessionStore(REDIS_URL);

app.post("/sessions", async (req, res) => {
  try {
    const { fileName, fileSize, mimeType, desiredChunkSize, storageStrategy = "presigned" } = req.body;
    if (!fileName || typeof fileSize !== "number") return res.status(400).json({ error: "fileName and numeric fileSize required" });

    const DEFAULT = 5 * 1024 * 1024;
    const MIN = 256 * 1024;
    const MAX = 50 * 1024 * 1024;
    let chunkSize = desiredChunkSize || DEFAULT;
    if (fileSize >= 500 * 1024 * 1024) chunkSize = Math.min(MAX, 16 * 1024 * 1024);
    chunkSize = Math.max(MIN, Math.min(MAX, chunkSize));
    const totalChunks = Math.ceil(fileSize / chunkSize);
    const uploadId = uuidv4();

    const key = `uploads/${uploadId}/${Date.now()}-${fileName.replace(/\s+/g, "_")}`;
    const create = await s3client.send(new CreateMultipartUploadCommand({
      Bucket: S3_BUCKET,
      Key: key,
      ContentType: mimeType
    }));

    const session = {
      uploadId,
      fileName,
      size: fileSize,
      mimeType,
      chunkSize,
      totalChunks,
      storageStrategy,
      expiresAt: Date.now() + 60 * 60 * 1000,
      status: "pending",
      s3Multipart: { UploadId: create.UploadId, Key: key },
      uploadedParts: {}
    };

    await saveSession(sessionStore, session);
    res.json({ uploadId, chunkSize, totalChunks, expiresAt: session.expiresAt, storageStrategy, presignOnDemand: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error", detail: String(err) });
  }
});

app.get("/sessions/:id", async (req, res) => {
  const s = await getSession(sessionStore, req.params.id);
  if (!s) return res.status(404).json({ error: "not_found" });
  res.json({
    uploadId: s.uploadId,
    chunkSize: s.chunkSize,
    totalChunks: s.totalChunks,
    storageStrategy: s.storageStrategy,
    expiresAt: s.expiresAt,
    uploadedParts: Object.keys(s.uploadedParts).map(k => ({ index: Number(k), ...s.uploadedParts[k] })),
    status: s.status
  });
});

app.post("/sessions/:id/presign/:partIndex", async (req, res) => {
  try {
    const s = await getSession(sessionStore, req.params.id);
    if (!s) return res.status(404).json({ error: "not_found" });
    if (s.storageStrategy !== "presigned") return res.status(400).json({ error: "not_presigned_strategy" });

    const partIndex = Number(req.params.partIndex);
    if (isNaN(partIndex) || partIndex < 0 || partIndex >= s.totalChunks) return res.status(400).json({ error: "invalid_part_index" });

    const cmd = new UploadPartCommand({
      Bucket: S3_BUCKET,
      Key: s.s3Multipart.Key,
      UploadId: s.s3Multipart.UploadId,
      PartNumber: partIndex + 1
    });
    const url = await getSignedUrl(s3client, cmd, { expiresIn: Number(PRESIGNED_EXPIRES) });
    res.json({ url, expiresAt: Date.now() + PRESIGNED_EXPIRES * 1000 });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error", detail: String(err) });
  }
});

app.patch("/sessions/:id/parts/:partIndex", upload.single("chunk"), async (req, res) => {
  try {
    const s = await getSession(sessionStore, req.params.id);
    if (!s) return res.status(404).json({ error: "not_found" });

    const partIndex = Number(req.params.partIndex);
    if (isNaN(partIndex) || partIndex < 0 || partIndex >= s.totalChunks) return res.status(400).json({ error: "invalid_part_index" });

    const chunkBuffer = req.file?.buffer;
    if (!chunkBuffer) return res.status(400).json({ error: "no_chunk" });

    const checksum = crypto.createHash("sha256").update(chunkBuffer).digest("hex");

    const up = await s3client.send(new UploadPartCommand({
      Bucket: S3_BUCKET,
      Key: s.s3Multipart.Key,
      UploadId: s.s3Multipart.UploadId,
      PartNumber: partIndex + 1,
      Body: chunkBuffer
    }));

    s.uploadedParts[partIndex] = { etag: up.ETag, checksum, size: chunkBuffer.length };
    s.status = "uploading";
    await saveSession(sessionStore, s);

    res.json({ index: partIndex, etag: up.ETag, checksum });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error", detail: String(err) });
  }
});

app.post("/sessions/:id/commit", async (req, res) => {
  try {
    const s = await getSession(sessionStore, req.params.id);
    if (!s) return res.status(404).json({ error: "not_found" });

    const { parts: clientParts } = req.body;
    if (!Array.isArray(clientParts)) return res.status(400).json({ error: "parts_required" });

    const missing = [];
    const mismatched = [];
    const partsForComplete = [];

    for (let i = 0; i < s.totalChunks; i++) {
      const p = clientParts.find(x => x.index === i);
      if (!p || !s.uploadedParts[i]) {
        missing.push(i);
        continue;
      }
      if (p.checksum !== s.uploadedParts[i].checksum) mismatched.push(i);
      partsForComplete.push({ PartNumber: i + 1, ETag: s.uploadedParts[i].etag });
    }

    if (missing.length || mismatched.length) return res.status(400).json({ error: "parts_invalid", missing, mismatched });

    const completeResp = await s3client.send(new CompleteMultipartUploadCommand({
      Bucket: S3_BUCKET,
      Key: s.s3Multipart.Key,
      UploadId: s.s3Multipart.UploadId,
      MultipartUpload: { Parts: partsForComplete }
    }));

    s.status = "committed";
    s.fileId = s.s3Multipart.Key;
    await saveSession(sessionStore, s);

    res.json({ fileId: s.fileId, location: completeResp.Location, etag: completeResp.ETag });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error", detail: String(err) });
  }
});

app.post("/sessions/:id/abort", async (req, res) => {
  try {
    const s = await getSession(sessionStore, req.params.id);
    if (!s) return res.status(404).json({ error: "not_found" });

    await s3client.send(new AbortMultipartUploadCommand({
      Bucket: S3_BUCKET,
      Key: s.s3Multipart.Key,
      UploadId: s.s3Multipart.UploadId
    }));

    s.status = "aborted";
    await saveSession(sessionStore, s);
    res.json({ message: "aborted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "server_error", detail: String(err) });
  }
});

app.get("/demo", (req, res) => {
  res.sendFile(new URL("./src/web/demo.html", import.meta.url).pathname);
});

async function ensureBucket() {
  try {
    await s3client.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
    console.log("ensured bucket", S3_BUCKET);
  } catch (e) {
    console.warn("ensureBucket:", e.message || e);
  }
}

const PORTNUM = Number(process.env.PORT || PORT);
app.listen(PORTNUM, async () => {
  console.log(`PDF World server listening on http://localhost:${PORTNUM}`);
  await ensureBucket();
});
