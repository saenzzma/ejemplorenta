import test from "node:test";
import assert from "node:assert/strict";
import { connectWithRetry } from "../src/db.js";

test("una conexión rechazada mientras SQL despierta se cierra y vuelve a establecerse", async () => {
  let created = 0,
    closed = 0;
  const waits = [],
    connected = {};
  const result = await connectWithRetry(
    () => {
      const attempt = ++created;
      return {
        connect: async () => {
          if (attempt === 1)
            throw {
              code: "ELOGIN",
              originalError: { info: { number: 40613 } },
            };
          return connected;
        },
        close: async () => {
          closed++;
        },
      };
    },
    { wait: async (ms) => waits.push(ms) },
  );
  assert.equal(result, connected);
  assert.equal(created, 2);
  assert.equal(closed, 1);
  assert.deepEqual(waits, [1000]);
});

test("credenciales inválidas no provocan reintentos de conexión inicial", async () => {
  let created = 0;
  const error = Object.assign(Error("credenciales"), {
    code: "ELOGIN",
    number: 18456,
  });
  await assert.rejects(
    connectWithRetry(
      () => {
        created++;
        return {
          connect: async () => {
            throw error;
          },
          close: async () => {},
        };
      },
      { wait: async () => assert.fail("No debe esperar") },
    ),
    error,
  );
  assert.equal(created, 1);
});

test("los fallos de red tienen un límite de intentos y no ejecutan consultas", async () => {
  let created = 0,
    closed = 0;
  const waits = [],
    error = Object.assign(Error("red"), { code: "ESOCKET" });
  await assert.rejects(
    connectWithRetry(
      () => {
        created++;
        return {
          connect: async () => {
            throw error;
          },
          close: async () => {
            closed++;
          },
        };
      },
      { attempts: 3, wait: async (ms) => waits.push(ms) },
    ),
    error,
  );
  assert.equal(created, 3);
  assert.equal(closed, 3);
  assert.deepEqual(waits, [1000, 2000]);
});
