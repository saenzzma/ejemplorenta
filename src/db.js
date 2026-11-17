import sql from "mssql";
let poolPromise;
const transientCodes = new Set([
  "ETIMEOUT",
  "ESOCKET",
  "ECONNCLOSED",
  "ECONNRESET",
]);
const transientNumbers = new Set([
  40613, 40197, 40501, 10928, 10929, 49918, 49919, 49920,
]);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Se reintenta el establecimiento de conexión; nunca las escrituras de negocio.
export async function connectWithRetry(
  makePool,
  { attempts = 5, wait = delay } = {},
) {
  for (let attempt = 0; ; attempt++) {
    const pool = makePool();
    try {
      return await pool.connect();
    } catch (error) {
      await pool.close().catch(() => {});
      const number = error.number ?? error.originalError?.info?.number;
      const transient =
        transientCodes.has(error.code) || transientNumbers.has(number);
      if (!transient || attempt >= attempts - 1) throw error;
      await wait(Math.min(1000 * 2 ** attempt, 5000));
    }
  }
}

export function db() {
  if (process.env.SQL_DATABASE !== "talsory")
    throw new Error("Este servicio solo puede usar la BD talsory.");
  if (
    !process.env.SQL_SERVER ||
    !process.env.SQL_USER ||
    !process.env.SQL_PASSWORD
  )
    throw new Error("Falta configurar la BD exclusiva de Talsory.");
  poolPromise ??= connectWithRetry(() => {
    const pool = new sql.ConnectionPool({
      server: process.env.SQL_SERVER,
      database: "talsory",
      user: process.env.SQL_USER,
      password: process.env.SQL_PASSWORD,
      connectionTimeout: 15000,
      requestTimeout: 30000,
      // Reintenta crear conexiones antes de ejecutar la consulta si SQL despierta.
      pool: {
        max: 5,
        min: 0,
        idleTimeoutMillis: 10000,
        acquireTimeoutMillis: 90000,
        createRetryIntervalMillis: 2000,
        propagateCreateError: false,
      },
      options: {
        encrypt: true,
        trustServerCertificate: false,
        enableArithAbort: true,
      },
    });
    pool.on("error", (error) => {
      console.error(
        JSON.stringify({
          event: "sql-pool-error",
          code: error.code || error.name,
        }),
      );
    });
    return pool;
  }).catch((error) => {
    poolPromise = undefined;
    throw error;
  });
  return poolPromise;
}
export async function closeDb() {
  if (poolPromise) await (await poolPromise).close();
  poolPromise = undefined;
}
export { sql };
