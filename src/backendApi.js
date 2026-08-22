import axios from "axios";

function getBackendBaseUrl() {
  const value = String(process.env.BACKEND_BASE_URL || "").trim();
  if (!value) throw new Error("Missing BACKEND_BASE_URL in .env");
  return value.replace(/\/+$/, "");
}

function getWorkerApiKey() {
  const value = String(process.env.WORKER_API_KEY || "").trim();
  if (!value) throw new Error("Missing WORKER_API_KEY in .env");
  return value;
}

function getClient() {
  return axios.create({
    baseURL: getBackendBaseUrl(),
    timeout: 120000,
    headers: {
      "x-worker-key": getWorkerApiKey(),
      "x-worker-id": String(process.env.WORKER_ID || "worker").trim(),
    },
  });
}

export async function fetchAiJobs({ limit }) {
  const client = getClient();

  const res = await client.get("/api/admin/devices/ai-worker/jobs", {
    params: {
      limit,
      workerId: String(process.env.WORKER_ID || "worker").trim(),
    },
  });

  return {
    jobs: Array.isArray(res.data?.rows) ? res.data.rows : [],
    // Optional fleet-wide aggregate supplied by the backend. Older backend
    // responses remain valid while this field is being implemented.
    fleetStats:
      res.data?.fleetStats && typeof res.data.fleetStats === "object"
        ? res.data.fleetStats
        : null,
  };
}

export async function submitAiResult(payload) {
  const client = getClient();

  const res = await client.post("/api/admin/devices/ai-worker/results", {
    ...payload,
    workerId: String(process.env.WORKER_ID || "worker").trim(),
  });

  return res.data;
}

export async function sendWorkerHeartbeat(payload = {}) {
  const client = getClient();

  const workerId = String(process.env.WORKER_ID || "worker").trim();

  const res = await client.post(
    "/api/admin/devices/ai-worker/heartbeat",
    {
      workerId,
      workerVersion: String(
        process.env.WORKER_VERSION ||
        process.env.npm_package_version ||
        "dev"
      ).trim(),
      hostname: String(
        process.env.HOSTNAME || process.env.COMPUTERNAME || ""
      ).trim(),
      pid: process.pid,
      ...payload,
    },
    {
      timeout: Number(process.env.WORKER_HEARTBEAT_TIMEOUT_MS || 5000),
    }
  );

  return res.data;
}
