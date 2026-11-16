import test from "node:test";
import assert from "node:assert/strict";
import { createMessaging } from "../src/messaging.js";
process.env.SERVICE_BUS_CONNECTION =
  "Endpoint=sb://unit.servicebus.windows.net/;SharedAccessKeyName=unit;SharedAccessKey=dW5pdC10ZXN0LW9ubHktbm90LWEtcmVhbC1rZXk=";
process.env.INARI_URL = "http://simulator.invalid";
process.env.INTERNAL_KEY = "test-only-internal-key-that-is-at-least-32";
const id = "da90c4f5-c668-43e6-b16f-7ecc01e9f4d4";
test("502 después de ejecutar pasa a conciliación y luego consulta; no repite el POST", async () => {
  let state = "RECIBIDO",
    postCount = 0,
    getCount = 0,
    uncertainCount = 0;
  const original = globalThis.fetch;
  const repo = {
    get: async () => ({ status: state }),
    claim: async () => {
      state = "EN_PROCESO";
      return true;
    },
    uncertain: async () => {
      state = "POR_CONFIRMAR";
      uncertainCount++;
    },
    complete: async () => {
      state = "DESEMBOLSADO";
    },
    review: async () => {
      state = "EN_REVISION";
    },
  };
  globalThis.fetch = async (_url, options) => {
    if (options.method === "POST") {
      postCount++;
      return new Response("{}", { status: 502 });
    }
    getCount++;
    return new Response(
      JSON.stringify({ operationId: id, receiptReference: "DEMO-" + id }),
      { status: 200 },
    );
  };
  const messaging = createMessaging(repo);
  try {
    await messaging.processMessage({
      body: { operationId: id, kind: "DISBURSE" },
    });
    assert.equal(state, "POR_CONFIRMAR");
    assert.equal(uncertainCount, 1);
    await messaging.processMessage({
      body: { operationId: id, kind: "RECONCILE" },
    });
    assert.equal(state, "DESEMBOLSADO");
    await messaging.processMessage({
      body: { operationId: id, kind: "DISBURSE" },
    });
    assert.equal(postCount, 1);
    assert.equal(getCount, 1);
  } finally {
    globalThis.fetch = original;
    await messaging.close();
  }
});
test("una operación en proceso con resultado desconocido consulta y pasa a revisión sin crear otro desembolso", async () => {
  const original = globalThis.fetch;
  let reviewed = false,
    posts = 0;
  globalThis.fetch = async (_url, options) => {
    if (options.method === "POST") posts++;
    return new Response("{}", { status: 404 });
  };
  const messaging = createMessaging({
    get: async () => ({ status: "EN_PROCESO" }),
    review: async () => {
      reviewed = true;
    },
  });
  try {
    await messaging.processMessage({
      body: { operationId: id, kind: "DISBURSE" },
    });
    assert.equal(reviewed, true);
    assert.equal(posts, 0);
  } finally {
    globalThis.fetch = original;
    await messaging.close();
  }
});
