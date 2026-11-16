import sql from "mssql";
let poolPromise;
export function db() {
  if (process.env.SQL_DATABASE !== "talsory")
    throw new Error("Este servicio solo puede usar la BD talsory.");
  if (
    !process.env.SQL_SERVER ||
    !process.env.SQL_USER ||
    !process.env.SQL_PASSWORD
  )
    throw new Error("Falta configurar la BD exclusiva de Talsory.");
  poolPromise ??= new sql.ConnectionPool({
    server: process.env.SQL_SERVER,
    database: "talsory",
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    connectionTimeout: 60000,
    requestTimeout: 30000,
    pool: { max: 5, min: 0, idleTimeoutMillis: 10000 },
    options: {
      encrypt: true,
      trustServerCertificate: false,
      enableArithAbort: true,
    },
  })
    .connect()
    .catch((error) => {
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
