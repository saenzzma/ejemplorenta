import { createServer } from "./server.js";
import { createMessaging } from "./messaging.js";
import { closeDb } from "./db.js";
const role = process.env.ROLE || "api";
const messaging =
  process.env.SERVICE_BUS_CONNECTION && role !== "simulator"
    ? createMessaging()
    : null;
let server, interval;
if (role === "publisher") {
  if (!messaging) throw Error("Falta Service Bus.");
  await messaging.publishPending();
  await messaging.close();
  await closeDb();
} else if (role === "worker") {
  if (!messaging) throw Error("Falta Service Bus.");
  server = await createServer({ port: Number(process.env.PORT || 8080) });
  await server.start();
  messaging.runWorker().catch((error) => {
    console.error(error.code || error.name);
    process.exitCode = 1;
  });
} else {
  server = await createServer({
    publishPending: () => messaging?.publishPending(),
  });
  await server.start();
  if (messaging) {
    interval = setInterval(
      () =>
        messaging
          .publishPending()
          .catch((error) =>
            console.error(
              JSON.stringify({
                event: "outbox-publish",
                code: error.code || error.name,
              }),
            ),
          ),
      15000,
    );
    interval.unref();
  }
}
if (server)
  console.log(
    JSON.stringify({
      event: "started",
      role,
      port: server.info.port,
      demo: true,
    }),
  );
const shutdown = async () => {
  clearInterval(interval);
  await server?.stop({ timeout: 5000 });
  await messaging?.close();
  await closeDb();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
