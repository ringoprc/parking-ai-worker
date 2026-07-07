import pLimit from "p-limit";
import fs from "fs/promises";

import {
  fetchAiJobs,
  submitAiResult,
  sendWorkerHeartbeat,
} from "./backendApi.js";
import { downloadGcsObjectToTemp } from "./gcs.js";
import { readVacancyWithLmStudio } from "./lmStudio.js";
import { preprocessImageForVlm } from "./preprocess.js";

async function safeUnlink(filePath) {
  if (!filePath) return;

  try {
    await fs.unlink(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.warn(`⚠️ Failed to delete temp file ${filePath}:`, err.message);
    }
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function safeSendWorkerHeartbeat(payload = {}) {
  try {
    await sendWorkerHeartbeat(payload);
  } catch (err) {
    console.warn("⚠️ Failed to send worker heartbeat:", err?.message || err);
  }
}
async function processOneJob(job) {
  const imageObject = job.imageObject;
  const imageBucket = job.imageBucket;
  const prompt = String(job.vlmPrompt ?? "").trim();

  if (!job.phoneId || !job.deviceId || !imageObject) {
    console.log("⚠️ Invalid AI job. Skipping:", job);
    return;
  }

  if (!prompt) {
    console.log(`⚠️ ${job.deviceId} has no VLM prompt. Skipping.`);
    return;
  }

  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📱 Processing phone:", job.deviceId);
  console.log("🖼️ Image object:", imageObject);

  const startedAt = Date.now();

  let localPath;
  let processedPath;

  try {
    localPath = await downloadGcsObjectToTemp(imageObject, {
      bucketName: imageBucket,
    });

    console.log("🖼️ Preprocessing image...");
    processedPath = await preprocessImageForVlm(localPath);
    console.log("✅ Processed image:", processedPath);

    console.log("🤖 Sending processed image to LM Studio...");
    console.log(
      job.usesCustomPrompt
        ? "🧩 Using backend-provided custom VLM prompt"
        : "🧩 Using backend-provided default VLM prompt"
    );

    const result = await readVacancyWithLmStudio(processedPath, {
      prompt,
    });

    console.log("✅ LM Studio raw result:");
    console.log(result.raw);

    console.log("📡 Sending raw VLM result to backend...");

    const saved = await submitAiResult({
      phoneId: job.phoneId,
      deviceId: job.deviceId,
      imageObject,
      rawText: result.raw,
      model: process.env.LM_STUDIO_MODEL,
      processedImagePath: null,
    });

    const durationSec = ((Date.now() - startedAt) / 1000).toFixed(1);

    console.log("✅ Backend accepted AI result:");
    console.log({
      deviceId: job.deviceId,
      status: saved.parsed?.status,
      vacancy: saved.parsed?.vacancy,
      durationSec,
    });
    await safeSendWorkerHeartbeat({
      status: "processed",
      lastProcessedAt: new Date().toISOString(),
      lastProcessedDeviceId: job.deviceId,
      lastProcessedImageObject: imageObject,
      lastProcessedStatus: saved.parsed?.status || "",
      lastProcessedVacancy: saved.parsed?.vacancy ?? null,
      lastDurationSec: Number(durationSec),
    });
  } finally {
    await safeUnlink(localPath);
    await safeUnlink(processedPath);
  }
}

export async function startWorker() {
  const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS || 5000);
  const concurrency = Number(process.env.WORKER_CONCURRENCY || 1);
  const batchSize = Number(process.env.WORKER_BATCH_SIZE || 5);

  const workerId = String(process.env.WORKER_ID || "worker").trim();
  console.log("🔁 Worker loop started");
  console.log({
    workerId,
    pollIntervalMs,
    concurrency,
    batchSize,
  });

  await safeSendWorkerHeartbeat({
    status: "started",
    pollIntervalMs,
    concurrency,
    batchSize,
  });

  const limit = pLimit(concurrency);

  while (true) {
    try {

      await safeSendWorkerHeartbeat({
        status: "polling",
        pollIntervalMs,
        concurrency,
        batchSize,
      });

      const jobs = await fetchAiJobs({
        limit: batchSize,
      });

      if (jobs.length === 0) {
        console.log(`😴 No AI jobs. Sleeping ${pollIntervalMs}ms...`);

        await safeSendWorkerHeartbeat({
          status: "idle",
          pollIntervalMs,
          concurrency,
          batchSize,
        });

        await sleep(pollIntervalMs);
        continue;
      }

      console.log(`📦 Found ${jobs.length} AI job(s).`);

      await Promise.all(
        jobs.map((job) => limit(() => processOneJob(job)))
      );
    } catch (err) {
      console.error("❌ Worker loop error:");
      console.error(err);

      await safeSendWorkerHeartbeat({
        status: "error",
        lastErrorAt: new Date().toISOString(),
        lastErrorMessage: String(err?.message || err || "").slice(0, 1000),
      });

      await sleep(pollIntervalMs);
    }
  }
}

