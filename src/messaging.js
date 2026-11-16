import { createProcessor } from "./loan-processor.js";
import { ServiceBusClient } from "@azure/service-bus";
import { LoanRepository } from "./loan-repository.js";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function createMessaging(repo = new LoanRepository()) {
  const client = new ServiceBusClient(process.env.SERVICE_BUS_CONNECTION);
  const queue = process.env.SERVICE_BUS_QUEUE || "loans";
  const sender = client.createSender(queue);
  let publishing = false,
    stopping = false;
  async function publishPending() {
    if (publishing) return;
    publishing = true;
    try {
      for (const event of await repo.pendingEvents()) {
        await sender.sendMessages({
          messageId: event.eventId,
          sessionId: event.policyNumber,
          contentType: "application/json",
          body: { operationId: event.operationId, kind: event.kind },
        });
        await repo.published(event.eventId);
      }
    } finally {
      publishing = false;
    }
  }
  const processMessage = createProcessor(repo);
  async function runWorker() {
    while (!stopping) {
      let receiver;
      try {
        await publishPending();
        receiver = await client.acceptNextSession(queue, {
          receiveMode: "peekLock",
          maxAutoLockRenewalDurationInMs: 60000,
        });
        const messages = await receiver.receiveMessages(1, {
          maxWaitTimeInMs: 5000,
        });
        for (const message of messages) {
          try {
            await processMessage(message);
            await receiver.completeMessage(message);
            await publishPending();
          } catch (error) {
            console.error(
              JSON.stringify({
                event: "worker-error",
                code: error.code || error.name,
              }),
            );
            if ((message.deliveryCount ?? 0) >= 3) {
              if (message.body?.operationId)
                await repo.review(message.body.operationId).catch(() => {});
              await receiver.deadLetterMessage(message, {
                deadLetterReason: "PROCESSING_FAILED",
                deadLetterErrorDescription:
                  "Verificar el estado durable antes de reprocesar.",
              });
            } else {
              await receiver.abandonMessage(message);
              await delay(1000);
            }
          }
        }
      } catch (error) {
        if (
          error.code !== "ServiceTimeout" &&
          error.code !== "SessionCannotBeLocked"
        )
          console.error(
            JSON.stringify({
              event: "worker-loop",
              code: error.code || error.name,
            }),
          );
        await delay(2000);
      } finally {
        await receiver?.close().catch(() => {});
      }
    }
  }
  return {
    publishPending,
    runWorker,
    processMessage,
    async close() {
      stopping = true;
      await sender.close();
      await client.close();
    },
  };
}
