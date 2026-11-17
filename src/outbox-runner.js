// Procesa trabajos al recibir una señal y queda inactivo cuando no hay pendientes.
// Los reintentos solo se programan si una lectura o un trabajo fallaron.
export function createOutboxRunner({
  repository,
  processMessage,
  onError = () => {},
  retryDelayMs = 15000,
  maxRetryDelayMs = 300000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let running = null;
  let requested = false;
  let stopped = false;
  let retryTimer = null;
  let nextRetryDelay = retryDelayMs;

  function scheduleRetry() {
    if (stopped || retryTimer) return;
    retryTimer = setTimer(() => {
      retryTimer = null;
      void wake();
    }, nextRetryDelay);
    retryTimer?.unref?.();
    nextRetryDelay = Math.min(nextRetryDelay * 2, maxRetryDelayMs);
  }

  async function drain() {
    try {
      do {
        requested = false;
        const events = await repository.pendingEvents();
        for (const event of events) {
          if (stopped) break;
          await processMessage({
            body: { operationId: event.operationId, kind: event.kind },
          });
          await repository.published(event.eventId);
        }
        if (events.length > 0 && !stopped) requested = true;
      } while (requested && !stopped);
      nextRetryDelay = retryDelayMs;
      return true;
    } catch (error) {
      requested = true;
      scheduleRetry();
      onError(error);
      return false;
    } finally {
      running = null;
      if (requested && !retryTimer && !stopped) void wake();
    }
  }

  function wake() {
    if (stopped) return Promise.resolve(false);
    requested = true;
    if (retryTimer) {
      clearTimer(retryTimer);
      retryTimer = null;
    }
    running ??= Promise.resolve().then(drain);
    return running;
  }

  async function stop() {
    stopped = true;
    requested = false;
    if (retryTimer) clearTimer(retryTimer);
    retryTimer = null;
    if (running) await running;
  }

  return { wake, stop };
}
