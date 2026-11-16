import test from "node:test";
import assert from "node:assert/strict";
import { scryptSync } from "node:crypto";
import { createServer } from "../src/server.js";
import { checkPassword } from "../src/auth.js";
import { template, input } from "./fixtures.js";
process.env.JWT_SECRET = "unit-test-only-secret-which-is-long-enough";
process.env.REVIEWER_HASH =
  "unit-salt:" + scryptSync("unit-password", "unit-salt", 64).toString("hex");
test("API exige JWT, autentica al evaluador y mantiene el endpoint requerido y el versionado", async () => {
  const server = await createServer({
    templateRepository: {
      list: async () => [
        { producto: "Rumbo", tipoEndoso: "CambioFrecuencia", version: 1 },
      ],
      find: async () => template,
    },
    loanRepository: {},
  });
  try {
    assert.equal(
      (
        await server.inject({
          method: "POST",
          url: "/endorse/translate",
          payload: input,
        })
      ).statusCode,
      401,
    );
    const invalid = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "evaluador", password: "wrong" },
    });
    assert.equal(invalid.statusCode, 401);
    const login = await server.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: { username: "evaluador", password: "unit-password" },
    });
    assert.equal(login.statusCode, 200);
    const token = login.result.accessToken;
    for (const path of ["/endorse/translate", "/api/v1/endorse/translate"]) {
      const result = await server.inject({
        method: "POST",
        url: path,
        headers: { authorization: "Bearer " + token },
        payload: input,
      });
      assert.equal(result.statusCode, 200);
      assert.equal(result.result.eventEntity.dynamicData.length, 12);
      assert.equal(result.headers["x-template-version"], "1");
    }
    const invalidInput = await server.inject({
      method: "POST",
      url: "/endorse/translate",
      headers: { authorization: "Bearer " + token },
      payload: { producto: "Rumbo" },
    });
    assert.equal(invalidInput.statusCode, 400);
    const tampered = await server.inject({
      method: "GET",
      url: "/api/v1/templates",
      headers: { authorization: "Bearer " + token + "x" },
    });
    assert.equal(tampered.statusCode, 401);
  } finally {
    await server.stop();
  }
});
test("verificación de contraseña rechaza cadenas inválidas y no admite un valor vacío por defecto", () => {
  assert.equal(checkPassword("anything", ""), false);
  assert.equal(checkPassword("unit-password", process.env.REVIEWER_HASH), true);
  assert.equal(checkPassword("wrong", process.env.REVIEWER_HASH), false);
});
