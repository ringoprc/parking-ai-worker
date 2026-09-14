import assert from "node:assert/strict";
import test from "node:test";
import axios from "axios";

test("backend API sends stable worker identity and attempt progress", async (t) => {
  const requests = [];
  const originalCreate = axios.create;
  t.after(() => {
    axios.create = originalCreate;
  });

  axios.create = (clientConfig) => ({
    async get(url, config) {
      requests.push({ method: "GET", url, config, clientConfig });
      return { data: { rows: [{ attemptId: "attempt-01" }] } };
    },
    async patch(url, body, config) {
      requests.push({ method: "PATCH", url, body, config, clientConfig });
      return { data: { ok: true } };
    },
    async post(url, body, config) {
      requests.push({ method: "POST", url, body, config, clientConfig });
      return { data: { ok: true } };
    },
  });

  process.env.BACKEND_BASE_URL = "https://backend.test";
  process.env.WORKER_API_KEY = "test-worker-key";
  process.env.WORKER_ID = "worker-test-01";
  process.env.WORKER_VERSION = "9.9.9";

  const {
    fetchAiJobs,
    reportAttemptFailure,
    reportAttemptProgress,
    sendWorkerHeartbeat,
  } = await import("./backendApi.js");

  const claimed = await fetchAiJobs({ limit: 1 });
  await reportAttemptProgress({
    attemptId: claimed.jobs[0].attemptId,
    stage: "vlm",
    startedAt: "2026-09-14T01:00:00.000Z",
    timings: { downloadMs: 50 },
  });
  await reportAttemptFailure({
    attemptId: claimed.jobs[0].attemptId,
    stage: "vlm",
    context: "AI job",
    code: "ECONNREFUSED",
    message: "LM Studio refused the connection",
  });
  await sendWorkerHeartbeat({ status: "processing" });

  assert.equal(requests.length, 4);
  assert.equal(
    requests[0].clientConfig.headers["x-worker-id"],
    "worker-test-01"
  );
  assert.equal(requests[0].clientConfig.headers["x-worker-version"], "9.9.9");
  assert.match(
    requests[0].clientConfig.headers["x-worker-session-id"],
    /^[0-9a-f-]{36}$/i
  );
  assert.equal(
    requests[1].clientConfig.headers["x-worker-session-id"],
    requests[0].clientConfig.headers["x-worker-session-id"]
  );
  assert.equal(requests[1].method, "PATCH");
  assert.equal(
    requests[1].url,
    "/api/admin/devices/ai-worker/attempts/attempt-01"
  );
  assert.equal(requests[1].body.stage, "vlm");
  assert.equal(requests[1].body.timings.downloadMs, 50);
  assert.equal(
    requests[2].url,
    "/api/admin/devices/ai-worker/attempts/attempt-01/failure"
  );
  assert.equal(requests[2].body.stage, "vlm");
  assert.equal(requests[2].body.code, "ECONNREFUSED");
  assert.equal(
    requests[3].body.workerSessionId,
    requests[0].clientConfig.headers["x-worker-session-id"]
  );
  assert.ok(requests[3].body.startedAt);
});
