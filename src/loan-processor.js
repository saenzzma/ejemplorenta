import { LoanRepository } from "./loan-repository.js";
export function createProcessor(repo = new LoanRepository()) {
  async function simulator(method, id) {
    const response = await fetch(
      `${process.env.INARI_URL}/internal/disbursements${method === "GET" ? "/" + id : ""}`,
      {
        method,
        headers: {
          "content-type": "application/json",
          "x-internal-key": process.env.INTERNAL_KEY,
        },
        ...(method === "POST"
          ? { body: JSON.stringify({ operationId: id }) }
          : {}),
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok) throw new Error(`SIMULATOR_HTTP_${response.status}`);
    const result = await response.json();
    if (
      result.operationId?.toLowerCase() !== id.toLowerCase() ||
      typeof result.receiptReference !== "string"
    )
      throw new Error("INVALID_SIMULATOR_RESPONSE");
    return result;
  }
  async function processMessage(message) {
    const { operationId, kind } = message.body ?? {};
    if (!["DISBURSE", "RECONCILE"].includes(kind))
      throw new Error("INVALID_EVENT");
    const operation = await repo.get(operationId);
    if (operation.status === "DESEMBOLSADO" || operation.status === "RECHAZADO")
      return;
    if (operation.status === "EN_REVISION") return;
    if (
      kind === "DISBURSE" &&
      operation.status === "RECIBIDO" &&
      (await repo.claim(operationId))
    ) {
      try {
        const result = await simulator("POST", operationId);
        await repo.complete(operationId, result.receiptReference);
      } catch {
        await repo.uncertain(operationId);
      }
      return;
    }
    // Una redelivery o un 502 se resuelven consultando la referencia. Nunca se crea una segunda operación.
    try {
      const result = await simulator("GET", operationId);
      await repo.complete(operationId, result.receiptReference);
    } catch {
      await repo.review(operationId);
    }
  }
  return processMessage;
}
