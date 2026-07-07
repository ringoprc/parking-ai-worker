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

  return Array.isArray(res.data?.rows) ? res.data.rows : [];
}

export async function submitAiResult(payload) {
  const client = getClient();

  const res = await client.post("/api/admin/devices/ai-worker/results", {
    ...payload,
    workerId: String(process.env.WORKER_ID || "worker").trim(),
  });

  return res.data;
}



