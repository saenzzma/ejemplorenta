import { readFile } from "node:fs/promises";
import { db, sql, closeDb } from "../src/db.js";
const pool = await db();
try {
  const actual = (await pool.request().query("SELECT DB_NAME() AS name"))
    .recordset[0].name;
  if (actual !== "talsory")
    throw Error("Se rechazó una BD fuera del alcance autorizado.");
  const schema = await readFile(
    new URL("../sql/schema.sql", import.meta.url),
    "utf8",
  );
  for (const batch of schema.split(/^GO\s*$/gim))
    if (batch.trim()) await pool.request().batch(batch);
  const config = JSON.parse(
    await readFile(
      new URL("../config/templates.json", import.meta.url),
      "utf8",
    ),
  );
  for (const template of config.templates) {
    const tx = new sql.Transaction(pool);
    await tx.begin();
    try {
      const exists = await new sql.Request(tx)
        .input("p", sql.NVarChar(80), template.product)
        .input("e", sql.NVarChar(80), template.endorsement)
        .input("v", sql.Int, template.version)
        .query(
          "SELECT templateId FROM talsory.Templates WHERE product=@p AND endorsement=@e AND version=@v",
        );
      if (exists.recordset.length) {
        await tx.commit();
        continue;
      }
      const result = await new sql.Request(tx)
        .input("p", sql.NVarChar(80), template.product)
        .input("e", sql.NVarChar(80), template.endorsement)
        .input("v", sql.Int, template.version)
        .input("b", sql.NVarChar(sql.MAX), JSON.stringify(config.baseJson))
        .query(
          "INSERT talsory.Templates(product,endorsement,version,active,baseJson) OUTPUT inserted.templateId VALUES(@p,@e,@v,1,@b)",
        );
      const id = result.recordset[0].templateId;
      for (const [index, mapping] of config.mappings.entries()) {
        const hasOverride = Object.hasOwn(
          template.defaultOverrides ?? {},
          mapping.targetPath ?? mapping.label,
        );
        const defaultValue = hasOverride
          ? template.defaultOverrides[mapping.targetPath ?? mapping.label]
          : mapping.defaultValue;
        await new sql.Request(tx)
          .input("id", sql.Int, id)
          .input("source", sql.NVarChar(100), mapping.sourceKey ?? null)
          .input(
            "target",
            sql.NVarChar(200),
            mapping.label ? "eventEntity.dynamicData" : mapping.targetPath,
          )
          .input("label", sql.NVarChar(100), mapping.label ?? null)
          .input("order", sql.Int, index + 1)
          .input("required", sql.Bit, !!mapping.required)
          .input(
            "default",
            sql.NVarChar(sql.MAX),
            defaultValue === undefined ? null : JSON.stringify(defaultValue),
          )
          .input("type", sql.VarChar(10), mapping.valueType ?? null)
          .query(
            "INSERT talsory.TemplateMappings(templateId,sourceKey,targetPath,label,sortOrder,required,defaultJson,valueType) VALUES(@id,@source,@target,@label,@order,@required,@default,@type)",
          );
      }
      for (const event of config.events)
        await new sql.Request(tx)
          .input("id", sql.Int, id)
          .input("d", sql.NVarChar(100), event.description)
          .input("o", sql.Int, event.orderEvent)
          .query(
            "INSERT talsory.TemplateEvents(templateId,description,orderEvent) VALUES(@id,@d,@o)",
          );
      await tx.commit();
    } catch (error) {
      await tx.rollback();
      throw error;
    }
  }
  for (const loan of [
    { id: "demo-normal", policy: "DEMO-001", amount: 1000, scenario: "normal" },
    {
      id: "demo-502",
      policy: "DEMO-002",
      amount: 1500,
      scenario: "timeout-after-success",
    },
    {
      id: "demo-concurrency",
      policy: "DEMO-003",
      amount: 2000,
      scenario: "timeout-after-success",
    },
  ])
    await pool
      .request()
      .input("id", sql.VarChar(80), loan.id)
      .input("p", sql.VarChar(40), loan.policy)
      .input("a", sql.Decimal(18, 2), loan.amount)
      .input("s", sql.VarChar(30), loan.scenario)
      .query(
        `IF NOT EXISTS(SELECT 1 FROM talsory.ApprovedLoans WHERE approvedLoanId=@id) INSERT talsory.ApprovedLoans(approvedLoanId,ownerId,policyNumber,amount,scenario) VALUES(@id,'reviewer',@p,@a,@s)`,
      );
  if (process.env.APP_SQL_PASSWORD)
    await pool
      .request()
      .input("password", sql.NVarChar(200), process.env.APP_SQL_PASSWORD)
      .batch(
        `IF DATABASE_PRINCIPAL_ID(N'talsory_app') IS NULL BEGIN DECLARE @statement nvarchar(max)=N'CREATE USER [talsory_app] WITH PASSWORD = N'''+REPLACE(@password,N'''',N'''''')+N'''';EXEC(@statement);END;GRANT SELECT,INSERT,UPDATE ON SCHEMA::talsory TO [talsory_app];GRANT EXECUTE ON SCHEMA::talsory TO [talsory_app];`,
      );
  console.log(
    "Esquema, dos plantillas configurables y tres préstamos ficticios preparados únicamente en talsory.",
  );
} finally {
  await closeDb();
}
