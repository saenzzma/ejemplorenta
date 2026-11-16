import { randomBytes, scryptSync } from "node:crypto";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
const destination = resolve(process.argv[2] || "");
if (!process.argv[2])
  throw Error("Indica una ruta privada fuera del repositorio.");
if (existsSync(destination)) {
  console.log("Se conserva la configuración privada existente.");
  process.exit(0);
}
const secret = () => randomBytes(32).toString("base64url");
const subscriptionId = process.argv[3] || process.env.AZURE_SUBSCRIPTION_ID;
if (!subscriptionId || !/^[\da-f-]{36}$/i.test(subscriptionId))
  throw Error(
    "Indica la suscripción autorizada como tercer argumento o AZURE_SUBSCRIPTION_ID.",
  );
const suffix = "261116" + randomBytes(2).toString("hex");
const password = secret().slice(0, 20);
const salt = secret();
const config = {
  subscriptionId,
  resourceGroup: "rg-talsory-20261116",
  location: "centralus",
  prefix: "talsory-" + suffix,
  sqlServer: "sql-talsory-" + suffix,
  registry: "talsory" + suffix,
  serviceBus: "sb-talsory-" + suffix,
  environment: "env-talsory-" + suffix,
  identity: "id-talsory-images",
  sqlDatabase: "talsory",
  sqlAdminUser: "talsoryadmin",
  sqlAdminPassword: "T!" + secret(),
  appSqlPassword: "T!" + secret(),
  jwtSecret: secret(),
  internalKey: secret(),
  reviewerPassword: password,
  reviewerHash: salt + ":" + scryptSync(password, salt, 64).toString("hex"),
  createdAt: new Date().toISOString(),
};
mkdirSync(dirname(destination), { recursive: true });
writeFileSync(destination, JSON.stringify(config, null, 2), { mode: 0o600 });
console.log(
  "Configuración privada creada fuera del código y de los paquetes de entrega.",
);
