import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { input } from "../test/fixtures.js";
const base = process.argv[2],
  configPath = process.argv[3],
  reportPath = process.argv[4];
if (!base || !configPath)
  throw Error("Uso: node scripts/smoke.js URL CONFIG_PRIVADA [REPORTE]");
const config = JSON.parse(
  readFileSync(configPath, "utf8").replace(/^\uFEFF/, ""),
);
let token = "";
const checks = [];
async function call(
  path,
  { method = "GET", body, headers = {}, auth = true } = {},
) {
  const response = await fetch(base + path, {
    method,
    headers: {
      ...(auth && token ? { authorization: "Bearer " + token } : {}),
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(65000),
  });
  const data = await response.json();
  return { status: response.status, data };
}
async function check(name, fn) {
  await fn();
  checks.push({ name, result: "PASS" });
  console.log("PASS " + name);
}
await check("health", async () =>
  assert.equal((await call("/health")).status, 200),
);
await check("JWT obligatorio", async () =>
  assert.equal(
    (await call("/api/v1/endorse/translate", { method: "POST", body: input }))
      .status,
    401,
  ),
);
await check("login", async () => {
  const r = await call("/api/v1/auth/login", {
    method: "POST",
    body: { username: "evaluador", password: config.reviewerPassword },
  });
  assert.equal(r.status, 200);
  assert.ok(r.data.accessToken);
  token = r.data.accessToken;
});
await check("dos plantillas en la BD nueva", async () => {
  const r = await call("/api/v1/templates");
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.ok(r.data.some((t) => t.producto === "Rumbo"));
  assert.ok(r.data.some((t) => t.producto === "VidaDemo"));
});
await check("traducción y contrato completo", async () => {
  const r = await call("/endorse/translate", { method: "POST", body: input });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.eventEntity.dynamicData.length, 12);
  assert.equal(r.data.riskUnitEntities[0].plansEntity.description, "PlanRumbo");
  assert.equal(r.data.eventAppliedEntities[1].description, "AprobarEndoso");
});
await check("validación de campo requerido", async () => {
  const body = { ...input };
  delete body.usuario;
  const r = await call("/api/v1/endorse/translate", { method: "POST", body });
  assert.equal(r.status, 422);
});
await check("segunda plantilla sin cambiar el motor", async () => {
  const body = { ...input, producto: "VidaDemo" };
  delete body.moneda;
  const r = await call("/api/v1/endorse/translate", { method: "POST", body });
  assert.equal(r.status, 200);
  assert.equal(r.data.currency.description, "Dólar");
});
await check("Go Dijkstra a través de la API", async () => {
  const r = await call("/api/v1/routes/optimal", {
    method: "POST",
    body: {
      accidentLocation: "C",
      depots: ["D", "A"],
      graph: { A: { B: 2, C: 20 }, B: { C: 3 }, C: {}, D: { C: 9 } },
    },
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.distance, 5);
  assert.deepEqual(r.data.path, ["A", "B", "C"]);
});
await check("Go destino inalcanzable", async () => {
  const r = await call("/api/v1/routes/optimal", {
    method: "POST",
    body: { accidentLocation: "B", depots: ["A"], graph: { A: {}, B: {} } },
  });
  assert.equal(r.status, 422);
  assert.equal(r.data.code, "UNREACHABLE");
});
const offer = await call("/api/v1/demo/loans", {
  method: "POST",
  body: { scenario: "timeout-after-success" },
});
assert.equal(offer.status, 200, JSON.stringify(offer.data));
const key = randomUUID();
let operationId;
await check("aceptación durable 202", async () => {
  const r = await call("/api/v1/loans", {
    method: "POST",
    body: { approvedLoanId: offer.data.approvedLoanId },
    headers: { "idempotency-key": key },
  });
  assert.equal(r.status, 202, JSON.stringify(r.data));
  operationId = r.data.operationId;
  assert.ok(operationId);
});
const keys = Array.from({ length: 5 }, () => randomUUID());
await check(
  "cinco solicitudes concurrentes con claves distintas recuperan una operación",
  async () => {
    const results = await Promise.all(
      keys.map((k) =>
        call("/api/v1/loans", {
          method: "POST",
          body: { approvedLoanId: offer.data.approvedLoanId },
          headers: { "idempotency-key": k },
        }),
      ),
    );
    for (const r of results) {
      assert.ok([200, 202].includes(r.status), JSON.stringify(r));
      assert.equal(r.data.operationId, operationId);
    }
  },
);
let final;
await check(
  "502 después del registro se concilia y produce un solo desembolso",
  async () => {
    for (let i = 0; i < 40; i++) {
      const r = await call("/api/v1/operations/" + operationId);
      assert.equal(r.status, 200, JSON.stringify(r.data));
      final = r.data;
      if (final.status === "DESEMBOLSADO") break;
      if (final.status === "EN_REVISION")
        throw Error("Conciliación pendiente de revisión");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.equal(final.status, "DESEMBOLSADO", JSON.stringify(final));
    assert.equal(final.disbursementCount, 1);
    assert.ok(final.receiptReference);
  },
);
await check(
  "reintento de una operación completada devuelve el mismo resultado",
  async () => {
    const r = await call("/api/v1/loans", {
      method: "POST",
      body: { approvedLoanId: offer.data.approvedLoanId },
      headers: { "idempotency-key": key },
    });
    assert.equal(r.status, 200);
    assert.equal(r.data.operationId, operationId);
  },
);
await check(
  "reutilizar una clave alternativa con otro préstamo devuelve 409",
  async () => {
    const other = await call("/api/v1/demo/loans", {
      method: "POST",
      body: { scenario: "normal" },
    });
    const r = await call("/api/v1/loans", {
      method: "POST",
      body: { approvedLoanId: other.data.approvedLoanId },
      headers: { "idempotency-key": keys[0] },
    });
    assert.equal(r.status, 409, JSON.stringify(r));
  },
);
const report = {
  testedAt: new Date().toISOString(),
  url: base,
  checks,
  proof: {
    operationId,
    status: final.status,
    disbursementCount: final.disbursementCount,
    concurrentRequests: 5,
    simulated502: true,
    realPayments: false,
  },
};
if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: checks.length, ...report.proof }));
