// Demostración de corta duración: Outbox en SQL y worker local; no usa Service Bus.
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { createServer } from "./server.js";
import { LoanRepository } from "./loan-repository.js";
import { createProcessor } from "./loan-processor.js";
import { closeDb } from "./db.js";
process.env.ROUTES_URL = "http://127.0.0.1:8081";
process.env.INARI_URL = "http://127.0.0.1:8082";
const executable =
  process.env.GO_BINARY ||
  resolve("bin", process.platform === "win32" ? "routes.exe" : "routes");
const go = spawn(executable, [], {
  env: { ...process.env, PORT: "8081" },
  stdio: "inherit",
  windowsHide: true,
});
go.on("error", (error) => {
  console.error(JSON.stringify({ event: "go-start-error", code: error.code }));
  process.exit(1);
});
go.on("exit", (code) => {
  if (!stopping && code !== null) {
    console.error(JSON.stringify({ event: "go-exited", code }));
    process.exit(code || 1);
  }
});
let stopping = false,
  running = false;
process.env.ROLE = "simulator";
const simulator = await createServer({ port: 8082 });
await simulator.start();
process.env.ROLE = "api";
const repo = new LoanRepository(),
  processMessage = createProcessor(repo);
async function processPending() {
  if (running || stopping) return;
  running = true;
  try {
    for (const event of await repo.pendingEvents()) {
      await processMessage({
        body: { operationId: event.operationId, kind: event.kind },
      });
      await repo.published(event.eventId);
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "demo-outbox-error",
        code: error.code || error.name,
      }),
    );
  } finally {
    running = false;
  }
}
const api = await createServer({ publishPending: processPending });
await api.start();
const interval = setInterval(processPending, 2500);
interval.unref();
processPending();
console.log(
  JSON.stringify({
    event: "demo-started",
    mode: "sql-outbox-local-worker",
    realPayments: false,
    port: api.info.port,
  }),
);
async function stop() {
  stopping = true;
  clearInterval(interval);
  go.kill("SIGTERM");
  await api.stop({ timeout: 5000 });
  await simulator.stop({ timeout: 5000 });
  await closeDb();
  process.exit(0);
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
