import test from "node:test";
import assert from "node:assert/strict";
import { translate } from "../src/translator.js";
import { template, input } from "./fixtures.js";
test("reproduce la estructura, etiquetas y orden del ejemplo completo del reto", () => {
  const result = translate(input, template);
  assert.deepEqual(result, {
    policyNumber: "08200000049",
    idEnvio: 5984,
    financialPlansEntity: { description: "Semestral" },
    currency: { description: "Nuevo Sol" },
    productEntity: { description: "Rumbo" },
    eventEntity: {
      description: "SolicitarEndoso",
      dynamicData: [
        { etiqueta: "ProductosVida", value: "Rumbo" },
        { etiqueta: "NombreUsuario", value: "interface.servicios" },
        { etiqueta: "NumeroPolizaEndoso", value: "08200000049" },
        { etiqueta: "TipoEndosoPol", value: "Endoso Simple" },
        { etiqueta: "ResponsableAtencion", value: "SAC" },
        { etiqueta: "EndosoModifPrima", value: "Si" },
        { etiqueta: "InicioVigenciaEndoso", value: "Default" },
        { etiqueta: "TipoVigenciaEndoso", value: "" },
        { etiqueta: "EndososSimplesSACRumbo", value: "TES008" },
        { etiqueta: "FechaSolicitud", value: "2025-08-27" },
        { etiqueta: "FechaCliente", value: "2025-08-27" },
        { etiqueta: "FechaEfectiva", value: "2025-09-01" },
      ],
    },
    eventAppliedEntities: [
      { description: "SolicitarEndoso", orderEvent: 1 },
      { description: "AprobarEndoso", orderEvent: 2 },
    ],
    riskUnitEntities: [
      {
        insuranceObjectEntities: [
          {
            insuranceObjectNumber: "1",
            coverageEntities: [],
            participationEntities: [],
          },
        ],
        plansEntity: { description: "PlanRumbo" },
        riskUnitNumber: "1",
      },
    ],
    participationEntities: [],
  });
});
test("respeta el orden configurado aunque los registros lleguen desordenados", () =>
  assert.deepEqual(
    translate(input, {
      ...template,
      mappings: [...template.mappings].reverse(),
      events: [...template.events].reverse(),
    }),
    translate(input, template),
  ));
test("aplica valores por defecto solo a campos ausentes", () => {
  const withoutCurrency = { ...input };
  delete withoutCurrency.moneda;
  assert.equal(
    translate(withoutCurrency, template).currency.description,
    "Nuevo Sol",
  );
  assert.equal(
    translate({ ...input, idEnvio: 0, moneda: "" }, template).idEnvio,
    0,
  );
  assert.equal(
    translate({ ...input, moneda: "" }, template).currency.description,
    "",
  );
});
test("detecta campos obligatorios y fechas inexistentes", () => {
  const missing = { ...input };
  delete missing.usuario;
  assert.throws(
    () => translate(missing, template),
    (e) => e.statusCode === 422 && e.code === "MISSING_FIELD",
  );
  assert.throws(
    () => translate({ ...input, fechaSolicitud: "2025-02-30" }, template),
    (e) => e.statusCode === 422,
  );
});
test("un producto adicional usa la misma lógica mediante otra configuración", () => {
  const other = structuredClone(template);
  other.mappings.find(
    (m) => m.targetPath === "currency.description",
  ).defaultJson = '"Dólar"';
  const data = { ...input, producto: "VidaDemo" };
  delete data.moneda;
  const result = translate(data, other);
  assert.equal(result.productEntity.description, "VidaDemo");
  assert.equal(result.currency.description, "Dólar");
});
test("no permite contaminación de prototipos ni destinos duplicados", () => {
  assert.throws(
    () =>
      translate(input, {
        ...template,
        mappings: [
          {
            targetPath: "x.__proto__.polluted",
            defaultJson: "true",
            sortOrder: 1,
          },
        ],
      }),
    (e) => e.code === "INVALID_TEMPLATE",
  );
  assert.equal({}.polluted, undefined);
  assert.throws(
    () =>
      translate(input, {
        ...template,
        mappings: [...template.mappings, template.mappings[0]],
      }),
    (e) => e.code === "INVALID_TEMPLATE",
  );
});
test("informa que no existe una plantilla activa", () =>
  assert.throws(
    () => translate(input, null),
    (e) => e.statusCode === 404,
  ));
