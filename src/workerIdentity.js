import { randomUUID } from "node:crypto";

export const workerIdentity = Object.freeze({
  workerId: String(process.env.WORKER_ID || "worker").trim(),
  sessionId: randomUUID(),
  workerVersion: String(
    process.env.WORKER_VERSION || process.env.npm_package_version || "dev"
  ).trim(),
  startedAt: new Date().toISOString(),
});
