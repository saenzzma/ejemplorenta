import Hapi from "@hapi/hapi";
import Inert from "@hapi/inert";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { registerAuth } from "./auth.js";
import { TemplateRepository } from "./template-repository.js";
import { LoanRepository } from "./loan-repository.js";
import { translate } from "./translator.js";
import { AppError } from "./errors.js";

export async function createServer({
  templateRepository = new TemplateRepository(),
  loanRepository = new LoanRepository(),
  publishPending = async () => {},
  port = Number(process.env.PORT || 8080),
} = {}) {
  const simulator = process.env.ROLE === "simulator";
  const server = Hapi.server({
    port,
    host: "0.0.0.0",
    routes: {
      payload: { maxBytes: 262144 },
      timeout: { server: 65000 },
      security: { hsts: true, xframe: true, noOpen: true, noSniff: true },
      cors: false,
    },
  });
  server.ext("onRequest", (request, h) => {
    request.app.correlationId = randomUUID();
    return h.continue;
  });
  server.ext("onPreResponse", (request, h) => {
    const response = request.response;
    if (!response.isBoom) {
      response.header("x-correlation-id", request.app.correlationId);
      response.header("referrer-policy", "no-referrer");
      response.header(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      );
      if (
        request.path.startsWith("/api") ||
        request.path.startsWith("/internal")
      )
        response.header("cache-control", "no-store");
    }
    return h.continue;
  });
  const safe = (handler) => async (request, h) => {
    try {
      return await handler(request, h);
    } catch (error) {
      if (!(error instanceof AppError))
        console.error(
          JSON.stringify({
            event: "request-error",
            correlationId: request.app.correlationId,
            code: error.code || error.name,
          }),
        );
      return h
        .response({
          code: error instanceof AppError ? error.code : "SERVICE_UNAVAILABLE",
          message:
            error instanceof AppError
              ? error.message
              : "El servicio no está disponible. Reintenta con la misma referencia.",
          correlationId: request.app.correlationId,
        })
        .code(error instanceof AppError ? error.statusCode : 503);
    }
  };
  server.route({
    method: "GET",
    path: "/health",
    options: { auth: false },
    handler: () => ({
      status: "ok",
      service: simulator ? "inari-simulator" : "talsory-api",
      version: "1.0.0",
    }),
  });
  if (simulator) {
    server.ext("onPreHandler", (request, h) => {
      if (request.path === "/health") return h.continue;
      const actual = Buffer.from(request.headers["x-internal-key"] || "");
      const expected = Buffer.from(process.env.INTERNAL_KEY || "");
      return expected.length >= 32 &&
        actual.length === expected.length &&
        timingSafeEqual(actual, expected)
        ? h.continue
        : h.response({ code: "UNAUTHORIZED" }).code(401).takeover();
    });
    server.route({
      method: "POST",
      path: "/internal/disbursements",
      handler: safe(async (request, h) => {
        const result = await loanRepository.simulate(
          request.payload?.operationId,
        );
        if (result.inserted && result.scenario === "timeout-after-success")
          return h
            .response({
              code: "SIMULATED_502_AFTER_COMMIT",
              message:
                "El desembolso simulado se registró, pero se perdió su respuesta.",
            })
            .code(502);
        return {
          operationId: result.operationId,
          receiptReference: result.receiptReference,
          amount: result.amount,
        };
      }),
    });
    server.route({
      method: "GET",
      path: "/internal/disbursements/{id}",
      handler: safe(async (request, h) => {
        const result = await loanRepository.simulatedResult(request.params.id);
        return result ?? h.response({ code: "NOT_FOUND" }).code(404);
      }),
    });
    await server.initialize();
    return server;
  }
  await registerAuth(server);
  await server.register(Inert);
  server.route({
    method: "GET",
    path: "/api/v1/templates",
    handler: safe(() => templateRepository.list()),
  });
  const translateHandler = safe(async (request, h) => {
    const input = request.payload;
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      typeof input.producto !== "string" ||
      typeof input.tipoEndoso !== "string" ||
      input.producto.length > 80 ||
      input.tipoEndoso.length > 80
    )
      throw new AppError(
        400,
        "INVALID_INPUT",
        "Envía un objeto JSON con producto y tipoEndoso.",
      );
    const template = await templateRepository.find(
      input.producto,
      input.tipoEndoso,
    );
    const output = translate(input, template);
    return h
      .response(output)
      .header("x-template-version", String(template.version));
  });
  server.route([
    {
      method: "POST",
      path: "/api/v1/endorse/translate",
      handler: translateHandler,
    },
    { method: "POST", path: "/endorse/translate", handler: translateHandler },
  ]);
  server.route({
    method: "POST",
    path: "/api/v1/routes/optimal",
    handler: safe(async (request, h) => {
      const response = await fetch(
        `${process.env.ROUTES_URL}/api/v1/routes/optimal`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: request.headers.authorization,
          },
          body: JSON.stringify(request.payload),
          signal: AbortSignal.timeout(10000),
        },
      );
      return h.response(await response.json()).code(response.status);
    }),
  });
  server.route({
    method: "GET",
    path: "/api/v1/loans/approved",
    handler: safe((request) =>
      loanRepository.list(request.auth.credentials.sub),
    ),
  });
  server.route({
    method: "POST",
    path: "/api/v1/demo/loans",
    handler: safe((request, h) => {
      const payload = request.payload;
      if (!payload || Object.keys(payload).some((key) => key !== "scenario"))
        throw new AppError(
          400,
          "INVALID_INPUT",
          "Envía únicamente el escenario de demostración.",
        );
      return loanRepository.createDemo(
        request.auth.credentials.sub,
        payload.scenario,
      );
    }),
  });
  server.route({
    method: "POST",
    path: "/api/v1/loans",
    handler: safe(async (request, h) => {
      const payload = request.payload;
      if (
        !payload ||
        Object.keys(payload).some((key) => key !== "approvedLoanId")
      )
        throw new AppError(
          400,
          "INVALID_INPUT",
          "Envía únicamente approvedLoanId.",
        );
      const result = await loanRepository.create(
        request.auth.credentials.sub,
        request.headers["idempotency-key"],
        payload.approvedLoanId,
      );
      // El envío es recuperable: el Outbox queda guardado aunque falle Service Bus.
      publishPending().catch((error) =>
        console.error(
          JSON.stringify({
            event: "outbox-deferred",
            code: error.code || error.name,
          }),
        ),
      );
      return h
        .response({
          ...result,
          statusUrl: `/api/v1/operations/${result.operationId}`,
        })
        .code(result.status === "DESEMBOLSADO" ? 200 : 202)
        .header("location", `/api/v1/operations/${result.operationId}`)
        .header("retry-after", "2");
    }),
  });
  server.route({
    method: "GET",
    path: "/api/v1/operations/{id}",
    handler: safe((request) =>
      loanRepository.get(request.params.id, request.auth.credentials.sub),
    ),
  });
  server.route({
    method: "GET",
    path: "/api/v1/about",
    handler: () => ({
      demo: true,
      realPayments: false,
      cloud: "Azure",
      languages: ["Node.js / Hapi", "Go", "React"],
      version: "1.0.0",
    }),
  });
  const dist = resolve("dist");
  server.route({
    method: "GET",
    path: "/assets/{path*}",
    options: { auth: false },
    handler: {
      directory: {
        path: resolve(dist, "assets"),
        listing: false,
        index: false,
      },
    },
  });
  server.route({
    method: "GET",
    path: "/",
    options: { auth: false },
    handler: (_, h) => h.file(resolve(dist, "index.html")),
  });
  await server.initialize();
  return server;
}
