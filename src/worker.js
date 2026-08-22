import pLimit from "p-limit";
import fs from "fs/promises";
import sharp from "sharp";

import {
  fetchAiJobs,
  submitAiResult,
  sendWorkerHeartbeat,
} from "./backendApi.js";
import { downloadGcsObjectToTemp } from "./gcs.js";
import { readVacancyWithLmStudio } from "./lmStudio.js";
import { preprocessImageForVlm } from "./preprocess.js";
import {
  configureMonitor,
  discoverJobs,
  failMonitoredJob,
  finishMonitoredJob,
  monitorEvent,
  startMonitoredJob,
  updateMonitor,
  updateMonitoredJob,
} from "./monitor.js";

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
    updateMonitor({ lastHeartbeatAt: new Date().toISOString() });
  } catch (err) {
    console.warn("⚠️ Failed to send worker heartbeat:", err?.message || err);
  }
}

const heartbeatState = {
  status: "starting",
  processedCount: 0,
  staleCount: 0,
  failedCount: 0,
};

function updateHeartbeatState(payload = {}) {
  Object.assign(heartbeatState, payload);
  updateMonitor(payload);
}

function elapsedMs(startedAt) {
  return Math.round((performance.now() - startedAt) * 10) / 10;
}

function formatDuration(durationMs) {
  if (durationMs >= 1000) return `${(durationMs / 1000).toFixed(2)}s`;
  return `${durationMs.toFixed(1)}ms`;
}

function logStageTiming(deviceId, stage, durationMs) {
  console.log(`⏱️ ${stage}: ${formatDuration(durationMs)}`);
}

function startHeartbeatTimer({ intervalMs, pollIntervalMs, concurrency, batchSize }) {
  let sending = false;

  const timer = setInterval(async () => {
    if (sending) return;

    sending = true;
    try {
      await safeSendWorkerHeartbeat({
        ...heartbeatState,
        pollIntervalMs,
        concurrency,
        batchSize,
      });
    } finally {
      sending = false;
    }
  }, intervalMs);

  timer.unref();
  return timer;
}

function logWorkerError(err) {
  if (err?.isAxiosError) {
    const method = err.config?.method?.toUpperCase();
    const url = err.config?.url;
    const request = [method, url].filter(Boolean).join(" ");
    const response = err.response?.data;
    const responseText =
      typeof response === "string" ? response : JSON.stringify(response);

    console.error(
      `❌ Worker API request failed: ${err.response?.status || "no status"} ${err.message}`
    );
    if (request) console.error(`   Request: ${request}`);
    if (responseText) console.error(`   Response: ${responseText.slice(0, 1000)}`);
    return;
  }

  console.error("❌ Worker loop error:", err?.message || err);
}

function recordJobFailure(job, err, context = "AI job") {
  if (
    err?.response?.status === 409 &&
    err?.response?.data?.error === "stale_ai_processing_lock"
  ) {
    updateHeartbeatState({
      staleCount: heartbeatState.staleCount + 1,
    });
    console.warn(
      `⚠️ Skipping stale AI result for device ${job?.deviceId || "unknown"}.`
    );
    if (job?.__monitorId) updateMonitoredJob(job.__monitorId, { status: "stale", stage: "complete" });
    return;
  }

  updateHeartbeatState({
    failedCount: heartbeatState.failedCount + 1,
    lastErrorAt: new Date().toISOString(),
    lastErrorMessage: String(err?.message || err || "").slice(0, 1000),
  });
  console.error(`❌ ${context} failed for device ${job?.deviceId || "unknown"}.`);
  if (job?.__monitorId) failMonitoredJob(job.__monitorId, err?.message || err, context);
  logWorkerError(err);
}

function createSubmissionQueue({ concurrency, maxPending }) {
  const limit = pLimit(concurrency);
  const pending = new Set();
  let reservations = 0;

  async function reserveCapacity() {
    while (pending.size + reservations >= maxPending) {
      await Promise.race(pending);
    }
    reservations += 1;
  }

  async function enqueue(job, task) {
    const queuedAt = performance.now();
    await reserveCapacity();

    let trackedPromise;
    try {
      trackedPromise = limit(() => task(elapsedMs(queuedAt)))
        .catch((err) => recordJobFailure(job, err, "Backend submission"))
        .finally(() => {
          pending.delete(trackedPromise);
          updateHeartbeatState({ pendingSubmissionCount: pending.size });
        });

      pending.add(trackedPromise);
    } finally {
      reservations -= 1;
    }
    updateHeartbeatState({ pendingSubmissionCount: pending.size });
  }

  return {
    enqueue,
    get pendingCount() {
      return pending.size;
    },
  };
}

async function enqueueAiResult({ job, rawText, submissionQueue, processingStartedAt }) {
  await submissionQueue.enqueue(job, async (queueMs) => {
    const submitStartedAt = performance.now();
    const saved = await submitAiResult({
      phoneId: job.phoneId,
      deviceId: job.deviceId,
      imageObject: job.imageObject,
      rawText,
      model: process.env.LM_STUDIO_MODEL,
      processedImagePath: null,
    });
    const submitMs = elapsedMs(submitStartedAt);
    const endToEndMs = elapsedMs(processingStartedAt);

    logStageTiming(job.deviceId, "Backend submission", submitMs);
    console.log("✅ Backend accepted AI result:");
    console.log(
      ">>>>> {" +
        "status: \"" +
        saved.parsed?.status +
        "\", " +
        "vacancy: \"" +
        saved.parsed?.vacancy +
        "\", " +
        "deviceId: [" +
        job.deviceId +
        "]}"
    );
    console.log(`⏱️ Backend result delivery:`, {
      deviceId: job.deviceId,
      submitQueue: formatDuration(queueMs),
      backendSubmit: formatDuration(submitMs),
      endToEnd: formatDuration(endToEndMs),
    });

    updateHeartbeatState({
      status: "processed",
      processedCount: heartbeatState.processedCount + 1,
      lastProcessedAt: new Date().toISOString(),
      lastProcessedDeviceId: job.deviceId,
      lastProcessedImageObject: job.imageObject,
      lastProcessedStatus: saved.parsed?.status || "",
      lastProcessedVacancy: saved.parsed?.vacancy ?? null,
      lastDurationSec: Number((endToEndMs / 1000).toFixed(1)),
    });
    finishMonitoredJob(job.__monitorId, {
      vacancy: saved.parsed?.vacancy ?? null,
      resultStatus: saved.parsed?.status || "",
      durationMs: endToEndMs,
    });
  });

  console.log(
    `📤 [${job.deviceId}] Result queued for backend submission ` +
      `(pending: ${submissionQueue.pendingCount})`
  );
}

async function processOneJob(job, { prepareLimit, vlmLimit, submissionQueue }) {
  const imageObject = job.imageObject;
  const imageBucket = job.imageBucket;
  const prompt = String(job.vlmPrompt ?? "").trim();

  if (!job.phoneId || !job.deviceId || !imageObject) {
    console.log("⚠️ Invalid AI job. Skipping:", job);
    return;
  }

  job.__monitorId = startMonitoredJob(job);

  if (!prompt) {
    console.log(`⚠️ ${job.deviceId} has no VLM prompt. Skipping.`);
    return;
  }

  console.log("");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📱 PhoneID [", job.deviceId, "]");
  //console.log("🖼️ Image object:", imageObject);

  const startedAt = performance.now();
  const timings = {};

  let localPath;
  let processedPath;

  try {
    await prepareLimit(async () => {
      let stageStartedAt = performance.now();
      localPath = await downloadGcsObjectToTemp(imageObject, {
        bucketName: imageBucket,
      });
      timings.downloadMs = elapsedMs(stageStartedAt);
      updateMonitoredJob(job.__monitorId, { stage: "download", durationMs: timings.downloadMs });
      logStageTiming(job.deviceId, "GCS download", timings.downloadMs);

      updateMonitoredJob(job.__monitorId, { stage: "prepare" });
      stageStartedAt = performance.now();
      const imageMetadata = await sharp(localPath).metadata();
      timings.imageMetadataMs = elapsedMs(stageStartedAt);
      console.log(
        `📐 [${job.deviceId}] Downloaded image dimensions: ${imageMetadata.width}x${imageMetadata.height}`
      );
      logStageTiming(
        job.deviceId,
        "Image metadata",
        timings.imageMetadataMs
      );

      //console.log("🖼️ Preprocessing image...");
      stageStartedAt = performance.now();
      processedPath = await preprocessImageForVlm(localPath);
      timings.preprocessMs = elapsedMs(stageStartedAt);
      updateMonitoredJob(job.__monitorId, { stage: "prepare", durationMs: timings.preprocessMs });
      //console.log("✅ Processed image:", processedPath);
      logStageTiming(job.deviceId, "Image preprocessing", timings.preprocessMs);
    });

    console.log("🤖 Sending processed image to LM Studio...");
    updateMonitoredJob(job.__monitorId, { stage: "vlm" });
    /*
    console.log(
      job.usesCustomPrompt
        ? "--> Using backend-provided custom VLM prompt"
        : "--> Using backend-provided default VLM prompt"
    );
    */

    const vlmQueuedAt = performance.now();
    const result = await vlmLimit(async () => {
      timings.vlmQueueMs = elapsedMs(vlmQueuedAt);
      const vlmStartedAt = performance.now();
      const vlmResult = await readVacancyWithLmStudio(processedPath, {
        prompt,
      });
      timings.vlmMs = elapsedMs(vlmStartedAt);
      return vlmResult;
    });
    logStageTiming(job.deviceId, "VLM request", timings.vlmMs);
    updateMonitoredJob(job.__monitorId, { stage: "vlm", durationMs: timings.vlmMs });

    console.log("");
    console.log("✅ LM Studio raw result");
    console.log("---------------------------------------");
    console.log(">>>>> "+result.raw);
    console.log("---------------------------------------");
    console.log("");

    updateMonitoredJob(job.__monitorId, { stage: "submit" });
    await enqueueAiResult({
      job,
      rawText: result.raw,
      submissionQueue,
      processingStartedAt: startedAt,
    });
  } finally {
    const cleanupStartedAt = performance.now();
    await safeUnlink(localPath);
    await safeUnlink(processedPath);
    timings.cleanupMs = elapsedMs(cleanupStartedAt);
    timings.totalMs = elapsedMs(startedAt);

    //logStageTiming(job.deviceId, "Temp-file cleanup", timings.cleanupMs);
    const durationSec = (elapsedMs(startedAt) / 1000).toFixed(1);
    console.log(`⏱️ [${job.deviceId}] Job timing summary (${durationSec} s):`, {
      download: timings.downloadMs == null ? null : formatDuration(timings.downloadMs),
      imageMetadata:
        timings.imageMetadataMs == null
          ? null
          : formatDuration(timings.imageMetadataMs),
      preprocess:
        timings.preprocessMs == null ? null : formatDuration(timings.preprocessMs),
      vlmQueue:
        timings.vlmQueueMs == null ? null : formatDuration(timings.vlmQueueMs),
      vlm: timings.vlmMs == null ? null : formatDuration(timings.vlmMs),
      cleanup: formatDuration(timings.cleanupMs),
      processingToQueue: formatDuration(timings.totalMs),
    });
  }
}

export async function startWorker() {
  const pollIntervalMs = Number(process.env.WORKER_POLL_INTERVAL_MS || 5000);
  const concurrency = Number(process.env.WORKER_CONCURRENCY || 1);
  const batchSize = Number(process.env.WORKER_BATCH_SIZE || 5);
  const prepareConcurrency = Number(
    process.env.WORKER_PREPARE_CONCURRENCY || concurrency
  );
  const vlmConcurrency = Number(
    process.env.WORKER_VLM_CONCURRENCY || concurrency
  );
  const submitConcurrency = Number(
    process.env.WORKER_SUBMIT_CONCURRENCY || Math.max(2, concurrency)
  );
  const maxPendingSubmissions = Math.max(
    1,
    Number(process.env.WORKER_MAX_PENDING_SUBMISSIONS || 10)
  );
  const heartbeatIntervalMs = Number(
    process.env.WORKER_HEARTBEAT_INTERVAL_MS || 15000
  );

  const workerId = String(process.env.WORKER_ID || "worker").trim();
  console.log("🔁 Worker loop started");
  console.log({
    workerId,
    pollIntervalMs,
    concurrency,
    batchSize,
    prepareConcurrency,
    vlmConcurrency,
    submitConcurrency,
    maxPendingSubmissions,
    heartbeatIntervalMs,
  });

  configureMonitor({
    pollIntervalMs,
    concurrency,
    batchSize,
    prepareConcurrency,
    vlmConcurrency,
    submitConcurrency,
    maxPendingSubmissions,
    heartbeatIntervalMs,
  });
  monitorEvent("system", `Worker ${workerId} started`);

  await safeSendWorkerHeartbeat({
    status: "started",
    pollIntervalMs,
    concurrency,
    batchSize,
  });

  startHeartbeatTimer({
    intervalMs: heartbeatIntervalMs,
    pollIntervalMs,
    concurrency,
    batchSize,
  });

  const prepareLimit = pLimit(prepareConcurrency);
  const vlmLimit = pLimit(vlmConcurrency);
  const submissionQueue = createSubmissionQueue({
    concurrency: submitConcurrency,
    maxPending: maxPendingSubmissions,
  });

  while (true) {
    try {

      updateHeartbeatState({
        status: "polling",
      });

      const { jobs, fleetStats } = await fetchAiJobs({
        limit: batchSize,
      });

      if (fleetStats) updateMonitor({ fleetStats });

      if (jobs.length === 0) {
        console.log(`😴 No AI jobs. Sleeping ${pollIntervalMs}ms...`);

        updateHeartbeatState({
          status: "idle",
        });

        await sleep(pollIntervalMs);
        continue;
      }

      console.log(`📦 Found ${jobs.length} AI job(s).`);
      discoverJobs(jobs.length);
      updateHeartbeatState({ status: "processing" });

      const results = await Promise.allSettled(
        jobs.map((job) =>
          processOneJob(job, { prepareLimit, vlmLimit, submissionQueue })
        )
      );

      results.forEach((result, index) => {
        if (result.status === "rejected") {
          const job = jobs[index];
          const err = result.reason;

          recordJobFailure(job, err);
        }
      });
    } catch (err) {
      logWorkerError(err);

      updateHeartbeatState({
        status: "error",
        failedCount: heartbeatState.failedCount + 1,
        lastErrorAt: new Date().toISOString(),
        lastErrorMessage: String(err?.message || err || "").slice(0, 1000),
      });

      await sleep(pollIntervalMs);
    }
  }
}
