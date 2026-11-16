import { randomUUID, createHash } from "node:crypto";
import { db, sql } from "./db.js";
import { AppError } from "./errors.js";
const uuid = (value) =>
  typeof value === "string" &&
  /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value);
export class LoanRepository {
  async createDemo(owner, scenario) {
    if (!["normal", "timeout-after-success"].includes(scenario))
      throw new AppError(
        400,
        "INVALID_SCENARIO",
        "Escenario de demostración inválido.",
      );
    const id = "demo-" + randomUUID(),
      policy = "DEMO-" + id.slice(-8).toUpperCase();
    await (await db())
      .request()
      .input("id", sql.VarChar(80), id)
      .input("owner", sql.VarChar(80), owner)
      .input("policy", sql.VarChar(40), policy)
      .input("scenario", sql.VarChar(30), scenario)
      .query(
        "INSERT talsory.ApprovedLoans(approvedLoanId,ownerId,policyNumber,amount,scenario) VALUES(@id,@owner,@policy,1500,@scenario)",
      );
    return { approvedLoanId: id, policyNumber: policy, amount: 1500, scenario };
  }
  async list(owner) {
    return (
      await (await db()).request().input("owner", sql.VarChar(80), owner)
        .query(`
      SELECT l.approvedLoanId,l.policyNumber,l.amount,l.scenario,o.operationId,o.status
      FROM talsory.ApprovedLoans l LEFT JOIN talsory.Operations o ON o.approvedLoanId=l.approvedLoanId
      WHERE l.ownerId=@owner ORDER BY l.approvedLoanId`)
    ).recordset;
  }
  async create(owner, key, approvedLoanId) {
    if (typeof key !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(key))
      throw new AppError(
        400,
        "INVALID_IDEMPOTENCY_KEY",
        "Envía Idempotency-Key con 8 a 100 caracteres alfanuméricos, guion o guion bajo.",
      );
    if (typeof approvedLoanId !== "string" || approvedLoanId.length > 80)
      throw new AppError(
        400,
        "INVALID_LOAN",
        "Selecciona un préstamo de demostración.",
      );
    try {
      const result = await (
        await db()
      )
        .request()
        .input("operationId", sql.UniqueIdentifier, randomUUID())
        .input("approvedLoanId", sql.VarChar(80), approvedLoanId)
        .input("ownerId", sql.VarChar(80), owner)
        .input("idempotencyKey", sql.VarChar(100), key)
        .input(
          "payloadHash",
          sql.Char(64),
          createHash("sha256")
            .update(JSON.stringify({ approvedLoanId }))
            .digest("hex"),
        )
        .execute("talsory.CreateOperation");
      return result.recordset[0];
    } catch (error) {
      const number = error.number ?? error.originalError?.info?.number;
      if (number === 51009 || number === 2601 || number === 2627)
        throw new AppError(
          409,
          "IDEMPOTENCY_CONFLICT",
          "La clave de idempotencia ya está asociada a otros datos.",
        );
      if (number === 51044)
        throw new AppError(
          404,
          "LOAN_NOT_FOUND",
          "Préstamo de demostración inexistente o sin acceso.",
        );
      if (number === 51004 || number === 1205)
        throw new AppError(503, "BUSY", "Reintenta con la misma clave.");
      throw error;
    }
  }
  async get(id, owner) {
    if (!uuid(id))
      throw new AppError(
        400,
        "INVALID_OPERATION",
        "Identificador de operación inválido.",
      );
    const request = (await db())
      .request()
      .input("id", sql.UniqueIdentifier, id)
      .input("owner", sql.VarChar(80), owner ?? null);
    const row = (
      await request.query(`SELECT o.operationId,o.status,o.createdAt,o.updatedAt,o.receiptReference,o.lastError,
      l.approvedLoanId,l.policyNumber,l.amount,l.scenario,
      (SELECT COUNT(*) FROM talsory.SimulatedDisbursements d WHERE d.operationId=o.operationId) AS disbursementCount
      FROM talsory.Operations o JOIN talsory.ApprovedLoans l ON l.approvedLoanId=o.approvedLoanId
      WHERE o.operationId=@id AND (@owner IS NULL OR o.ownerId=@owner)`)
    ).recordset[0];
    if (!row)
      throw new AppError(
        404,
        "OPERATION_NOT_FOUND",
        "No existe la operación o no tienes acceso.",
      );
    return row;
  }
  async claim(id) {
    return (
      (
        await (await db())
          .request()
          .input("id", sql.UniqueIdentifier, id)
          .query(
            `UPDATE talsory.Operations SET status='EN_PROCESO',updatedAt=SYSUTCDATETIME() OUTPUT inserted.operationId WHERE operationId=@id AND status='RECIBIDO'`,
          )
      ).recordset.length === 1
    );
  }
  async complete(id, reference) {
    await (await db())
      .request()
      .input("id", sql.UniqueIdentifier, id)
      .input("ref", sql.VarChar(100), reference)
      .query(
        `UPDATE talsory.Operations SET status='DESEMBOLSADO',receiptReference=@ref,lastError=NULL,updatedAt=SYSUTCDATETIME() WHERE operationId=@id`,
      );
  }
  async uncertain(id) {
    await (await db())
      .request()
      .input("operationId", sql.UniqueIdentifier, id)
      .execute("talsory.MarkUncertain");
  }
  async review(id) {
    await (await db())
      .request()
      .input("id", sql.UniqueIdentifier, id)
      .query(
        `UPDATE talsory.Operations SET status='EN_REVISION',updatedAt=SYSUTCDATETIME() WHERE operationId=@id AND status<>'DESEMBOLSADO'`,
      );
  }
  async pendingEvents() {
    return (
      await (await db())
        .request()
        .query(
          `SELECT TOP(20) e.eventId,e.operationId,e.kind,l.policyNumber FROM talsory.Outbox e JOIN talsory.Operations o ON o.operationId=e.operationId JOIN talsory.ApprovedLoans l ON l.approvedLoanId=o.approvedLoanId WHERE e.dispatchedAt IS NULL ORDER BY e.createdAt,e.eventId`,
        )
    ).recordset;
  }
  async published(id) {
    await (await db())
      .request()
      .input("id", sql.UniqueIdentifier, id)
      .query(
        "UPDATE talsory.Outbox SET dispatchedAt=SYSUTCDATETIME() WHERE eventId=@id AND dispatchedAt IS NULL",
      );
  }
  async simulate(id) {
    if (!uuid(id))
      throw new AppError(400, "INVALID_OPERATION", "Operación inválida.");
    return (
      await (await db())
        .request()
        .input("operationId", sql.UniqueIdentifier, id)
        .execute("talsory.SimulateDisbursement")
    ).recordset[0];
  }
  async simulatedResult(id) {
    if (!uuid(id))
      throw new AppError(400, "INVALID_OPERATION", "Operación inválida.");
    return (
      await (await db())
        .request()
        .input("id", sql.UniqueIdentifier, id)
        .query(
          "SELECT operationId,amount,receiptReference FROM talsory.SimulatedDisbursements WHERE operationId=@id",
        )
    ).recordset[0];
  }
}
