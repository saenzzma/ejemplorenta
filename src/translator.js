import { AppError } from "./errors.js";
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
function pathParts(path) {
  if (
    typeof path !== "string" ||
    !/^[A-Za-z][\w]*(\.(?:[A-Za-z][\w]*|\d{1,3}))*$/.test(path)
  ) {
    throw new AppError(
      500,
      "INVALID_TEMPLATE",
      "La plantilla contiene una ruta inválida.",
    );
  }
  const parts = path.split(".");
  if (parts.some((p) => forbidden.has(p)))
    throw new AppError(500, "INVALID_TEMPLATE", "Ruta no permitida.");
  return parts;
}
function setPath(target, path, value) {
  const keys = pathParts(path);
  let node = target;
  for (const [index, key] of keys.slice(0, -1).entries()) {
    if (node[key] === undefined)
      node[key] = /^\d+$/.test(keys[index + 1]) ? [] : {};
    if (node[key] === null || typeof node[key] !== "object") {
      throw new AppError(
        500,
        "INVALID_TEMPLATE",
        "La ruta de destino es incompatible con la plantilla.",
      );
    }
    node = node[key];
  }
  node[keys.at(-1)] = value;
}
function getPath(target, path) {
  return pathParts(path).reduce((node, key) => node?.[key], target);
}
export function translate(input, template) {
  if (!template)
    throw new AppError(
      404,
      "TEMPLATE_NOT_FOUND",
      "No hay una plantilla activa para el producto y tipo de endoso.",
    );
  let result;
  try {
    result = JSON.parse(template.baseJson);
  } catch {
    throw new AppError(
      500,
      "INVALID_TEMPLATE",
      "La estructura base de la plantilla es inválida.",
    );
  }
  const mappings = [...template.mappings].sort(
    (a, b) => a.sortOrder - b.sortOrder,
  );
  const destinations = new Set();
  for (const mapping of mappings) {
    const destination = mapping.targetPath + ":" + (mapping.label ?? "");
    if (destinations.has(destination))
      throw new AppError(
        500,
        "INVALID_TEMPLATE",
        "La plantilla contiene destinos duplicados.",
      );
    destinations.add(destination);
    let value =
      mapping.sourceKey && Object.hasOwn(input, mapping.sourceKey)
        ? input[mapping.sourceKey]
        : undefined;
    if (
      value === undefined &&
      mapping.defaultJson !== null &&
      mapping.defaultJson !== undefined
    ) {
      try {
        value = JSON.parse(mapping.defaultJson);
      } catch {
        throw new AppError(
          500,
          "INVALID_TEMPLATE",
          "La plantilla contiene un valor por defecto inválido.",
        );
      }
    }
    if (value === undefined || value === null) {
      if (mapping.required)
        throw new AppError(
          422,
          "MISSING_FIELD",
          `Falta el campo requerido: ${mapping.sourceKey || mapping.label}.`,
        );
      if (value === undefined) continue;
    }
    if (value !== null && mapping.valueType) {
      const valid =
        mapping.valueType === "date"
          ? typeof value === "string" &&
            /^\d{4}-\d{2}-\d{2}$/.test(value) &&
            !Number.isNaN(Date.parse(value)) &&
            new Date(value).toISOString().slice(0, 10) === value
          : typeof value === mapping.valueType &&
            (typeof value !== "number" || Number.isFinite(value));
      if (!valid)
        throw new AppError(
          422,
          "INVALID_FIELD",
          `Tipo o formato inválido: ${mapping.sourceKey || mapping.label}.`,
        );
    }
    if (mapping.label) {
      const array = getPath(result, mapping.targetPath);
      if (!Array.isArray(array))
        throw new AppError(
          500,
          "INVALID_TEMPLATE",
          "El destino de dynamicData debe ser un arreglo.",
        );
      array.push({ etiqueta: mapping.label, value });
    } else setPath(result, mapping.targetPath, value);
  }
  const events = [...template.events].sort(
    (a, b) => a.orderEvent - b.orderEvent,
  );
  if (new Set(events.map((e) => e.orderEvent)).size !== events.length) {
    throw new AppError(
      500,
      "INVALID_TEMPLATE",
      "El orden de eventos está duplicado.",
    );
  }
  result.eventAppliedEntities = events.map(({ description, orderEvent }) => ({
    description,
    orderEvent,
  }));
  return result;
}
