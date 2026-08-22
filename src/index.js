import "dotenv/config";
import { startWorker } from "./worker.js";
import { startMonitorServer } from "./monitor.js";

async function main() {
  console.log("🚗 Parking AI Worker starting...");

  if (!process.env.BACKEND_BASE_URL) {
    throw new Error("Missing BACKEND_BASE_URL in .env");
  }

  if (!process.env.WORKER_API_KEY) {
    throw new Error("Missing WORKER_API_KEY in .env");
  }

  console.log("✅ Startup checks passed");
  startMonitorServer();
  await startWorker();
}

main().catch((err) => {
  console.error("❌ Worker crashed during startup:");
  console.error(err);
  process.exit(1);
});
