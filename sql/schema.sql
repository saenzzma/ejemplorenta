IF DB_NAME() <> N'talsory' THROW 51000, 'Solo se permite ejecutar este script en la nueva BD talsory.', 1;
GO
IF SCHEMA_ID(N'talsory') IS NULL EXEC(N'CREATE SCHEMA talsory');
GO
IF OBJECT_ID(N'talsory.Templates') IS NULL
CREATE TABLE talsory.Templates (
 templateId int IDENTITY PRIMARY KEY, product nvarchar(80) NOT NULL,
 endorsement nvarchar(80) NOT NULL, version int NOT NULL, active bit NOT NULL,
 baseJson nvarchar(max) NOT NULL CHECK(ISJSON(baseJson)=1),
 CONSTRAINT UQ_TemplateVersion UNIQUE(product,endorsement,version)
);
GO
IF NOT EXISTS(SELECT 1 FROM sys.indexes WHERE name='UX_TemplateActive' AND object_id=OBJECT_ID('talsory.Templates'))
CREATE UNIQUE INDEX UX_TemplateActive ON talsory.Templates(product,endorsement) WHERE active=1;
GO
IF OBJECT_ID(N'talsory.TemplateMappings') IS NULL
CREATE TABLE talsory.TemplateMappings (
 mappingId int IDENTITY PRIMARY KEY, templateId int NOT NULL REFERENCES talsory.Templates(templateId),
 sourceKey nvarchar(100) NULL, targetPath nvarchar(200) NOT NULL,
 label nvarchar(100) NULL, sortOrder int NOT NULL, required bit NOT NULL,
 defaultJson nvarchar(max) NULL, valueType varchar(10) NULL,
 CONSTRAINT UQ_MappingOrder UNIQUE(templateId,sortOrder),
 CONSTRAINT CK_MappingType CHECK(valueType IN ('string','number','boolean','date'))
);
GO
IF OBJECT_ID(N'talsory.TemplateEvents') IS NULL
CREATE TABLE talsory.TemplateEvents (
 templateId int NOT NULL REFERENCES talsory.Templates(templateId),
 description nvarchar(100) NOT NULL, orderEvent int NOT NULL,
 PRIMARY KEY(templateId,orderEvent)
);
GO
IF OBJECT_ID(N'talsory.ApprovedLoans') IS NULL
CREATE TABLE talsory.ApprovedLoans (
 approvedLoanId varchar(80) PRIMARY KEY, ownerId varchar(80) NOT NULL,
 policyNumber varchar(40) NOT NULL, amount decimal(18,2) NOT NULL CHECK(amount>0),
 scenario varchar(30) NOT NULL CHECK(scenario IN ('normal','timeout-after-success'))
);
GO
IF OBJECT_ID(N'talsory.Operations') IS NULL
CREATE TABLE talsory.Operations (
 operationId uniqueidentifier PRIMARY KEY, approvedLoanId varchar(80) NOT NULL UNIQUE REFERENCES talsory.ApprovedLoans(approvedLoanId),
 ownerId varchar(80) NOT NULL, idempotencyKey varchar(100) NOT NULL,
 payloadHash char(64) NOT NULL, status varchar(30) NOT NULL,
 createdAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(), updatedAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(),
 receiptReference varchar(100) NULL, lastError varchar(100) NULL,
 CONSTRAINT UQ_Idempotency UNIQUE(ownerId,idempotencyKey),
 CONSTRAINT CK_OperationStatus CHECK(status IN ('RECIBIDO','EN_PROCESO','POR_CONFIRMAR','DESEMBOLSADO','EN_REVISION','RECHAZADO'))
);
GO
IF OBJECT_ID(N'talsory.Outbox') IS NULL
CREATE TABLE talsory.Outbox (
 eventId uniqueidentifier PRIMARY KEY, operationId uniqueidentifier NOT NULL REFERENCES talsory.Operations(operationId),
 kind varchar(20) NOT NULL CHECK(kind IN ('DISBURSE','RECONCILE')),
 createdAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME(), dispatchedAt datetime2 NULL,
 CONSTRAINT UQ_OperationEvent UNIQUE(operationId,kind)
);
GO
IF OBJECT_ID(N'talsory.IdempotencyRequests') IS NULL
CREATE TABLE talsory.IdempotencyRequests (
 ownerId varchar(80) NOT NULL, idempotencyKey varchar(100) NOT NULL,
 payloadHash char(64) NOT NULL, operationId uniqueidentifier NOT NULL REFERENCES talsory.Operations(operationId),
 PRIMARY KEY(ownerId,idempotencyKey)
);
GO
IF OBJECT_ID(N'talsory.SimulatedDisbursements') IS NULL
CREATE TABLE talsory.SimulatedDisbursements (
 operationId uniqueidentifier PRIMARY KEY REFERENCES talsory.Operations(operationId),
 amount decimal(18,2) NOT NULL, receiptReference varchar(100) NOT NULL UNIQUE,
 createdAt datetime2 NOT NULL DEFAULT SYSUTCDATETIME()
);
GO
CREATE OR ALTER PROCEDURE talsory.CreateOperation
 @operationId uniqueidentifier, @approvedLoanId varchar(80), @ownerId varchar(80),
 @idempotencyKey varchar(100), @payloadHash char(64)
AS
BEGIN
 SET NOCOUNT ON; SET XACT_ABORT ON;
 BEGIN TRANSACTION;
 DECLARE @lockResult int, @lockName nvarchar(255)=N'talsory.key.'+@ownerId+N'.'+@idempotencyKey;
 EXEC @lockResult=sys.sp_getapplock @Resource=@lockName,@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=5000;
 IF @lockResult<0 THROW 51004,'Operación ocupada. Reintenta con la misma clave.',1;
 SET @lockName=N'talsory.loan.'+@approvedLoanId;
 EXEC @lockResult=sys.sp_getapplock @Resource=@lockName,@LockMode='Exclusive',@LockOwner='Transaction',@LockTimeout=5000;
 IF @lockResult<0 THROW 51004,'Operación ocupada. Reintenta con la misma clave.',1;
 IF NOT EXISTS(SELECT 1 FROM talsory.ApprovedLoans WHERE approvedLoanId=@approvedLoanId AND ownerId=@ownerId)
  THROW 51044,'No existe un préstamo de demostración autorizado.',1;
 DECLARE @existing uniqueidentifier, @existingHash char(64);
 SELECT @existing=operationId,@existingHash=payloadHash FROM talsory.IdempotencyRequests WITH(UPDLOCK,HOLDLOCK)
  WHERE ownerId=@ownerId AND idempotencyKey=@idempotencyKey;
 IF @existing IS NOT NULL AND @existingHash<>@payloadHash THROW 51009,'La clave ya se utilizó con otros datos.',1;
 IF @existing IS NULL SELECT @existing=operationId FROM talsory.Operations WHERE approvedLoanId=@approvedLoanId;
 IF @existing IS NULL
 BEGIN
  INSERT talsory.Operations(operationId,approvedLoanId,ownerId,idempotencyKey,payloadHash,status)
   VALUES(@operationId,@approvedLoanId,@ownerId,@idempotencyKey,@payloadHash,'RECIBIDO');
  INSERT talsory.Outbox(eventId,operationId,kind) VALUES(NEWID(),@operationId,'DISBURSE');
  SET @existing=@operationId;
 END;
 IF NOT EXISTS(SELECT 1 FROM talsory.IdempotencyRequests WHERE ownerId=@ownerId AND idempotencyKey=@idempotencyKey)
  INSERT talsory.IdempotencyRequests(ownerId,idempotencyKey,payloadHash,operationId) VALUES(@ownerId,@idempotencyKey,@payloadHash,@existing);
 COMMIT;
 SELECT operationId,status,createdAt,receiptReference FROM talsory.Operations WHERE operationId=@existing AND ownerId=@ownerId;
END;
GO
CREATE OR ALTER PROCEDURE talsory.MarkUncertain @operationId uniqueidentifier
AS
BEGIN
 SET NOCOUNT ON; SET XACT_ABORT ON; BEGIN TRAN;
 UPDATE talsory.Operations SET status='POR_CONFIRMAR',lastError='INARI_RESPONSE_UNCERTAIN',updatedAt=SYSUTCDATETIME()
  WHERE operationId=@operationId AND status NOT IN ('DESEMBOLSADO','RECHAZADO');
 IF NOT EXISTS(SELECT 1 FROM talsory.Outbox WITH(UPDLOCK,HOLDLOCK) WHERE operationId=@operationId AND kind='RECONCILE')
  INSERT talsory.Outbox(eventId,operationId,kind) VALUES(NEWID(),@operationId,'RECONCILE');
 COMMIT;
END;
GO
CREATE OR ALTER PROCEDURE talsory.SimulateDisbursement @operationId uniqueidentifier
AS
BEGIN
 SET NOCOUNT ON; SET XACT_ABORT ON; BEGIN TRAN;
 DECLARE @inserted bit=0;
 IF NOT EXISTS(SELECT 1 FROM talsory.Operations WHERE operationId=@operationId) THROW 51044,'Operación inexistente.',1;
 IF NOT EXISTS(SELECT 1 FROM talsory.SimulatedDisbursements WITH(UPDLOCK,HOLDLOCK) WHERE operationId=@operationId)
 BEGIN
  INSERT talsory.SimulatedDisbursements(operationId,amount,receiptReference)
   SELECT o.operationId,l.amount,'DEMO-'+CONVERT(varchar(36),o.operationId)
   FROM talsory.Operations o JOIN talsory.ApprovedLoans l ON l.approvedLoanId=o.approvedLoanId WHERE o.operationId=@operationId;
  SET @inserted=1;
 END;
 COMMIT;
 SELECT d.operationId,d.amount,d.receiptReference,@inserted AS inserted,l.scenario
 FROM talsory.SimulatedDisbursements d JOIN talsory.Operations o ON o.operationId=d.operationId
 JOIN talsory.ApprovedLoans l ON l.approvedLoanId=o.approvedLoanId WHERE d.operationId=@operationId;
END;
GO
