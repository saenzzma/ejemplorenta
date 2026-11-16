import { scryptSync, timingSafeEqual } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import Boom from "@hapi/boom";
const attempts = new Map();
export function checkPassword(password, encoded) {
  if (
    typeof password !== "string" ||
    password.length > 200 ||
    typeof encoded !== "string"
  )
    return false;
  const [salt, hex] = encoded.split(":");
  if (!salt || !hex || hex.length !== 128) return false;
  try {
    return timingSafeEqual(
      scryptSync(password, salt, 64),
      Buffer.from(hex, "hex"),
    );
  } catch {
    return false;
  }
}
export async function registerAuth(server) {
  const key = new TextEncoder().encode(process.env.JWT_SECRET);
  if (key.length < 32)
    throw new Error("JWT_SECRET debe tener al menos 32 caracteres.");
  server.auth.scheme("demo-jwt", () => ({
    authenticate: async (request, h) => {
      try {
        const header = request.headers.authorization;
        if (!header?.startsWith("Bearer ")) throw Error("missing");
        const { payload } = await jwtVerify(header.slice(7), key, {
          issuer: "talsory-demo",
          audience: "talsory-demo",
          algorithms: ["HS256"],
        });
        if (payload.sub !== "reviewer" || payload.scope !== "demo:review")
          throw Error("scope");
        return h.authenticated({ credentials: payload });
      } catch {
        return h.unauthenticated(
          Boom.unauthorized("JWT requerido o inválido."),
        );
      }
    },
  }));
  server.auth.strategy("jwt", "demo-jwt");
  server.auth.default("jwt");
  server.route({
    method: "POST",
    path: "/api/v1/auth/login",
    options: { auth: false },
    handler: async (request, h) => {
      const ip = request.info.remoteAddress;
      const now = Date.now();
      const entry = attempts.get(ip);
      if (entry && now - entry.start < 60000 && entry.count >= 8)
        return h
          .response({
            code: "TOO_MANY_ATTEMPTS",
            message: "Espera un minuto antes de reintentar.",
          })
          .code(429);
      if (!entry || now - entry.start >= 60000)
        attempts.set(ip, { start: now, count: 1 });
      else entry.count++;
      if (attempts.size > 5000)
        for (const [address, attempt] of attempts)
          if (now - attempt.start > 60000) attempts.delete(address);
      const { username, password } = request.payload ?? {};
      if (
        username !== "evaluador" ||
        !checkPassword(password, process.env.REVIEWER_HASH)
      )
        return h
          .response({
            code: "INVALID_CREDENTIALS",
            message: "Credenciales inválidas.",
          })
          .code(401);
      const token = await new SignJWT({ scope: "demo:review" })
        .setProtectedHeader({ alg: "HS256", typ: "JWT" })
        .setIssuer("talsory-demo")
        .setAudience("talsory-demo")
        .setSubject("reviewer")
        .setIssuedAt()
        .setExpirationTime("30m")
        .sign(key);
      return { accessToken: token, tokenType: "Bearer", expiresIn: 1800 };
    },
  });
}
