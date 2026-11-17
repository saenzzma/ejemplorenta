import test from "node:test";
import assert from "node:assert/strict";
import { createOutboxRunner } from "../src/outbox-runner.js";

const event = (id, kind = "DISBURSE") => ({
  eventId: id,
  operationId: "op-1",
  kind,
});
const tick = () => new Promise((resolve) => setImmediate(resolve));

test("drena el desembolso y su conciliación; no consulta ni programa timers al quedar vacío", async () => {
  const pending = [event("first")],
    processed = [];
  let reads = 0,
    timers = 0;
  const runner = createOutboxRunner({
    repository: {
      pendingEvents: async () => {
        reads++;
        return [...pending];
      },
      published: async (id) => {
        pending.splice(
          pending.findIndex((e) => e.eventId === id),
          1,
        );
      },
    },
    processMessage: async ({ body }) => {
      processed.push(body.kind);
      if (body.kind === "DISBURSE") pending.push(event("second", "RECONCILE"));
    },
    setTimer: () => {
      timers++;
      throw Error("No debe haber polling");
    },
  });
  assert.equal(await runner.wake(), true);
  assert.deepEqual(processed, ["DISBURSE", "RECONCILE"]);
  assert.equal(reads, 3);
  await tick();
  assert.equal(reads, 3);
  assert.equal(timers, 0);
  await runner.stop();
});

test("una señal durante la última lectura no pierde trabajo ni crea procesadores paralelos", async () => {
  const pending = [],
    processed = [];
  let release,
    reads = 0,
    active = 0,
    maximum = 0;
  const runner = createOutboxRunner({
    repository: {
      pendingEvents: async () => {
        reads++;
        if (reads === 1)
          return await new Promise((resolve) => {
            release = () => resolve([]);
          });
        return [...pending];
      },
      published: async () => {
        pending.shift();
      },
    },
    processMessage: async ({ body }) => {
      active++;
      maximum = Math.max(maximum, active);
      await tick();
      processed.push(body.operationId);
      active--;
    },
  });
  const first = runner.wake();
  await tick();
  pending.push(event("arriving"));
  const second = runner.wake();
  assert.equal(first, second);
  release();
  await first;
  assert.deepEqual(processed, ["op-1"]);
  assert.equal(maximum, 1);
  await runner.stop();
});

test("un fallo conserva el evento y reintenta con espera creciente hasta publicar con éxito", async () => {
  const pending = [event("retry")],
    timers = [],
    waits = [],
    errors = [];
  let calls = 0,
    publications = 0;
  const runner = createOutboxRunner({
    repository: {
      pendingEvents: async () => [...pending],
      published: async () => {
        publications++;
        pending.shift();
      },
    },
    processMessage: async () => {
      if (++calls <= 3) throw Error("temporal");
    },
    onError: (error) => errors.push(error.message),
    retryDelayMs: 10,
    maxRetryDelayMs: 25,
    setTimer: (fn, ms) => {
      waits.push(ms);
      const timer = { fn };
      timers.push(timer);
      return timer;
    },
    clearTimer: () => {},
  });
  assert.equal(await runner.wake(), false);
  assert.equal(publications, 0);
  for (let i = 0; i < 3; i++) {
    timers[i].fn();
    await tick();
  }
  assert.deepEqual(waits, [10, 20, 25]);
  assert.equal(errors.length, 3);
  assert.equal(publications, 1);
  assert.equal(pending.length, 0);
  await runner.stop();
});

test("al detenerse cancela el reintento y no acepta nuevas señales", async () => {
  let cleared = 0,
    reads = 0;
  const timer = {};
  const runner = createOutboxRunner({
    repository: {
      pendingEvents: async () => {
        reads++;
        throw Error("temporal");
      },
    },
    processMessage: async () => {},
    setTimer: () => timer,
    clearTimer: (value) => {
      assert.equal(value, timer);
      cleared++;
    },
  });
  await runner.wake();
  await runner.stop();
  assert.equal(cleared, 1);
  assert.equal(await runner.wake(), false);
  assert.equal(reads, 1);
});
