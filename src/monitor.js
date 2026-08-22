import http from "http";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "monitor-ui");
const clients = new Set();
const jobs = new Map();
const events = [];
const failures = [];
const completionTimes = [];
const deviceStats = new Map();
const MAX_EVENTS = 120;
const MAX_FAILURES = 100;

const state = {
  workerId: String(process.env.WORKER_ID || "worker").trim(),
  startedAt: new Date().toISOString(),
  status: "starting",
  lastPollAt: null,
  lastHeartbeatAt: null,
  pollCount: 0,
  fleetStats: null,
  totals: { discovered: 0, completed: 0, recognized: 0, failed: 0, stale: 0, totalProcessingMs: 0 },
  config: {},
};

function snapshot() {
  const deviceWatchlist = [...deviceStats.values()]
    .map((device) => ({
      ...device,
      successfulCount: Math.max(0, device.completedCount - device.nullVacancyCount),
      problematicCount: device.nullVacancyCount + device.failedCount,
    }))
    .filter((device) => device.successfulCount + device.problematicCount > 0)
    .sort((a, b) =>
      b.successfulCount + b.problematicCount - (a.successfulCount + a.problematicCount) ||
      String(b.lastResultAt).localeCompare(String(a.lastResultAt))
    );
  return {
    ...state,
    jobs: [...jobs.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((job) => ({
        ...job,
        deviceResultHistory: deviceStats.get(String(job.deviceId))?.resultHistory || [],
      })),
    failures,
    completionTimes,
    deviceWatchlist,
    events,
    now: new Date().toISOString(),
  };
}

function getDeviceStats(deviceId, parkingLotName = null) {
  const key = String(deviceId || "Unknown device");
  if (!deviceStats.has(key)) {
    deviceStats.set(key, {
      deviceId: key,
      parkingLotName: parkingLotName || null,
      completedCount: 0,
      nullVacancyCount: 0,
      failedCount: 0,
      lastIssueAt: null,
      lastResultAt: null,
      lastIssueType: null,
      lastImageObject: "",
      resultHistory: [],
    });
  }
  const device = deviceStats.get(key);
  if (parkingLotName) device.parkingLotName = parkingLotName;
  return device;
}

function broadcast() {
  const message = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const client of clients) client.write(message);
}

function addEvent(type, message, detail = {}) {
  events.unshift({ id: `${Date.now()}-${Math.random()}`, at: new Date().toISOString(), type, message, ...detail });
  events.splice(MAX_EVENTS);
}

export function configureMonitor(config) {
  state.config = { ...config };
  broadcast();
}

export function updateMonitor(patch = {}) {
  Object.assign(state, patch);
  if (patch.status === "polling") {
    state.lastPollAt = new Date().toISOString();
    state.pollCount += 1;
  }
  if (patch.lastHeartbeatAt) state.lastHeartbeatAt = patch.lastHeartbeatAt;
  broadcast();
}

export function monitorEvent(type, message, detail) {
  addEvent(type, message, detail);
  broadcast();
}

export function discoverJobs(count) {
  state.totals.discovered += count;
  addEvent("batch", `${count} job${count === 1 ? "" : "s"} claimed from the queue`);
  broadcast();
}

export function startMonitoredJob(job) {
  const id = String(job.imageObject || `${job.deviceId}-${Date.now()}`);
  getDeviceStats(job.deviceId, job.parkingLotName);
  jobs.set(id, {
    id,
    deviceId: job.deviceId,
    parkingLotName: job.parkingLotName || null,
    imageObject: job.imageObject,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    stage: "download",
    stages: {},
  });
  addEvent("job", `Started ${job.deviceId}`, { jobId: id });
  broadcast();
  return id;
}

export function updateMonitoredJob(id, patch = {}) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch, { updatedAt: new Date().toISOString() });
  if (patch.stage && patch.durationMs != null) job.stages[patch.stage] = patch.durationMs;
  broadcast();
}

export function finishMonitoredJob(id, result = {}) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, result, {
    status: "completed",
    stage: "complete",
    completedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  state.totals.completed += 1;
  if (Number.isInteger(result.vacancy)) state.totals.recognized += 1;
  const device = getDeviceStats(job.deviceId);
  device.completedCount += 1;
  device.lastResultAt = job.completedAt;
  device.resultHistory.unshift({
    kind: "result",
    vacancy: result.vacancy,
    at: job.completedAt,
  });
  device.resultHistory.splice(10);
  if (result.vacancy === null) {
    device.nullVacancyCount += 1;
    device.lastIssueAt = job.completedAt;
    device.lastIssueType = "null_vacancy";
    device.lastImageObject = job.imageObject || "";
  }
  state.totals.totalProcessingMs += Number(result.durationMs) || 0;
  completionTimes.push(job.completedAt);
  const fiveMinutesAgo = Date.now() - 300000;
  while (completionTimes.length && new Date(completionTimes[0]).getTime() < fiveMinutesAgo) completionTimes.shift();
  if (completionTimes.length > 500) completionTimes.splice(0, completionTimes.length - 500);
  addEvent("success", `${job.deviceId} completed`, { jobId: id });
  trimJobs();
  broadcast();
}

function failureHint(error, stage, context) {
  const text = `${error} ${context}`.toLowerCase();
  if (text.includes("timeout") || text.includes("timed out")) {
    return stage === "vlm"
      ? "LM Studio took too long to answer. Check that the model is loaded, then review VLM concurrency and the 120-second request limit."
      : "A remote service took too long to answer. Check its health and network path before retrying.";
  }
  if (text.includes("econnrefused") || text.includes("connection refused")) {
    return stage === "vlm"
      ? "LM Studio is not accepting connections. Confirm it is running and LM_STUDIO_BASE_URL points to the correct host and port."
      : "The destination refused the connection. Confirm the service is running and its configured URL is reachable from this machine.";
  }
  if (text.includes("401") || text.includes("403") || text.includes("unauthorized") || text.includes("forbidden")) {
    return "The request was rejected for authorization. Check the worker API key or storage credentials without exposing them in the dashboard.";
  }
  if (text.includes("404") || text.includes("not found") || text.includes("enoent")) {
    return stage === "download"
      ? "The source image could not be found. Verify the bucket name and image object path supplied by the backend."
      : "A required resource or endpoint was not found. Verify the configured URL and the job's referenced image.";
  }
  if (text.includes("sharp") || text.includes("image") && (text.includes("invalid") || text.includes("unsupported"))) {
    return "The image could not be decoded or prepared. Inspect the source file for corruption or an unsupported format.";
  }
  if (text.includes("model") || text.includes("lm studio") || stage === "vlm") {
    return "The vision-model step failed. Confirm LM Studio is reachable, the configured model is loaded, and the prompt/image fit its limits.";
  }
  if (stage === "submit") {
    return "The result was produced but could not be delivered. Check backend availability, the worker API key, and whether the processing lock expired.";
  }
  return "Start with the failed stage and error below. Check the related service, then compare this job with the most recent successful one.";
}

export function failMonitoredJob(id, error, context = "AI job") {
  const job = jobs.get(id);
  if (job?.status === "failed") return;
  const errorText = String(error || "Unknown error").slice(0, 1000);
  const failedAt = new Date().toISOString();
  const failedStage = job?.stage || "unknown";
  const failure = {
    id: `${id || "unknown"}-${Date.now()}`,
    jobId: id,
    deviceId: job?.deviceId || "Unknown device",
    imageObject: job?.imageObject || "",
    failedAt,
    failedStage,
    context,
    error: errorText,
    hint: failureHint(errorText, failedStage, context),
  };
  const device = getDeviceStats(job?.deviceId);
  device.failedCount += 1;
  device.lastResultAt = failedAt;
  device.lastIssueAt = failedAt;
  device.lastIssueType = "failed";
  device.lastImageObject = job?.imageObject || "";
  device.resultHistory.unshift({
    kind: "error",
    at: failedAt,
  });
  device.resultHistory.splice(10);
  failures.unshift(failure);
  failures.splice(MAX_FAILURES);
  if (job) Object.assign(job, { status: "failed", stage: "failed", failedStage, error: errorText, hint: failure.hint, completedAt: failedAt });
  state.totals.failed += 1;
  addEvent("error", `${job?.deviceId || "Job"} failed during ${failedStage}`, { jobId: id });
  trimJobs();
  broadcast();
}

function trimJobs() {
  const ordered = [...jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  for (const job of ordered.slice(60)) jobs.delete(job.id);
}

const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8" };

export function startMonitorServer() {
  if (String(process.env.WORKER_MONITOR_ENABLED || "true").toLowerCase() === "false") return null;
  const port = Number(process.env.WORKER_MONITOR_PORT || 4310);
  const host = String(process.env.WORKER_MONITOR_HOST || "0.0.0.0");
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (url.pathname === "/api/state") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(snapshot()));
    }
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      clients.add(res);
      res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
      req.on("close", () => clients.delete(res));
      return;
    }
    const requested = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (!/^[a-zA-Z0-9._-]+$/.test(requested)) {
      res.writeHead(404); return res.end("Not found");
    }
    try {
      const body = await fs.readFile(path.join(publicDir, requested));
      res.writeHead(200, { "content-type": mime[path.extname(requested)] || "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404); res.end("Not found");
    }
  });
  server.on("error", (err) => console.warn(`⚠️ Worker monitor unavailable: ${err.message}`));
  server.listen(port, host, () => console.log(`🖥️ Worker monitor: http://localhost:${port}`));
  return server;
}
