import assert from "node:assert/strict";
import test from "node:test";

import { progressTelemetryEnabled } from "./worker.js";

test("progress telemetry can be suspended and restored with an environment flag", (t) => {
  const previous = process.env.WORKER_PROGRESS_TELEMETRY_ENABLED;
  t.after(() => {
    if (previous === undefined) {
      delete process.env.WORKER_PROGRESS_TELEMETRY_ENABLED;
    } else {
      process.env.WORKER_PROGRESS_TELEMETRY_ENABLED = previous;
    }
  });

  delete process.env.WORKER_PROGRESS_TELEMETRY_ENABLED;
  assert.equal(progressTelemetryEnabled(), true);

  process.env.WORKER_PROGRESS_TELEMETRY_ENABLED = "false";
  assert.equal(progressTelemetryEnabled(), false);

  process.env.WORKER_PROGRESS_TELEMETRY_ENABLED = "true";
  assert.equal(progressTelemetryEnabled(), true);
});
