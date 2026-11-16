import { db, sql } from "./db.js";
export class TemplateRepository {
  async list() {
    const pool = await db();
    return (
      await pool
        .request()
        .query(
          "SELECT product AS producto, endorsement AS tipoEndoso, version FROM talsory.Templates WHERE active=1 ORDER BY product, endorsement",
        )
    ).recordset;
  }
  async find(product, endorsement) {
    const pool = await db();
    const result = await pool
      .request()
      .input("product", sql.NVarChar(80), product)
      .input("endorsement", sql.NVarChar(80), endorsement).query(`
      SELECT templateId, baseJson, version FROM talsory.Templates WHERE product=@product AND endorsement=@endorsement AND active=1;
      SELECT m.sourceKey,m.targetPath,m.label,m.sortOrder,m.required,m.defaultJson,m.valueType
      FROM talsory.TemplateMappings m JOIN talsory.Templates t ON t.templateId=m.templateId
      WHERE t.product=@product AND t.endorsement=@endorsement AND t.active=1 ORDER BY m.sortOrder;
      SELECT e.description,e.orderEvent FROM talsory.TemplateEvents e JOIN talsory.Templates t ON t.templateId=e.templateId
      WHERE t.product=@product AND t.endorsement=@endorsement AND t.active=1 ORDER BY e.orderEvent;`);
    const template = result.recordsets[0][0];
    return template
      ? {
          ...template,
          mappings: result.recordsets[1],
          events: result.recordsets[2],
        }
      : null;
  }
}
