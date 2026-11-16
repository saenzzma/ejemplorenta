import { readFileSync } from "node:fs";
const configuration = JSON.parse(
  readFileSync(new URL("../config/templates.json", import.meta.url)),
);
export const template = {
  version: 1,
  baseJson: JSON.stringify(configuration.baseJson),
  mappings: configuration.mappings.map((m, i) => ({
    ...m,
    targetPath: m.label ? "eventEntity.dynamicData" : m.targetPath,
    sortOrder: i + 1,
    defaultJson: Object.hasOwn(m, "defaultValue")
      ? JSON.stringify(m.defaultValue)
      : null,
  })),
  events: configuration.events,
};
export const input = {
  policyNumber: "08200000049",
  idEnvio: 5984,
  frecuencia: "Semestral",
  tipoEndoso: "CambioFrecuencia",
  producto: "Rumbo",
  plan: "PlanRumbo",
  moneda: "Nuevo Sol",
  usuario: "interface.servicios",
  fechaSolicitud: "2025-08-27",
  fechaCliente: "2025-08-27",
  fechaEfectiva: "2025-09-01",
};
