# ejemplorenta — Evolution en Azure

Implementación de los ejercicios de Talsory / Interseguro: traductor de endosos en Node.js + Hapi, rutas óptimas en Go y una demostración de préstamos con control de duplicados. Frontend en React.

## Demostración desplegada para hoy

- Una aplicación Azure Container Apps, con imagen oficial pública `node:24-alpine` y una réplica máxima. Para mantenerla disponible durante la evaluación se configura una réplica mínima.
- La misma URL sirve React y la API Hapi. El servicio Go y el simulador INARI escuchan únicamente dentro del contenedor.
- Azure SQL Database **nueva y exclusiva `talsory`**, con oferta gratuita y `AutoPause` al agotar la cuota. No se accede a otras bases.
- Un Blob privado contiene el paquete de ejecución; un SAS de lectura temporal permite iniciar el contenedor.
- El Outbox de SQL funciona como cola durable y un worker local la procesa. **Esta demostración no utiliza Azure Service Bus ni ACR.**
- Los préstamos y desembolsos son ficticios. No hay integración con INARI, bancos o sistemas de pagos reales.

El SAS no es un mecanismo de eliminación: al vencer puede impedir nuevos arranques, mientras una réplica ya activa puede continuar. Los recursos permanecen en el grupo hasta eliminarlos expresamente.

Esta modalidad reduce el costo para una prueba de unas horas. Usa cuotas gratuitas de cómputo y SQL, más un volumen pequeño de almacenamiento y transferencias. No representa una garantía de factura cero si ya se consumieron las cuotas de la suscripción. No se crearon ACR Basic ni Service Bus Standard.

El entorno utilizado es Express: no admite sufijos de revisión personalizados ni publica las IP de salida en los campos habituales. Se comprobó la IPv4 desde el contenedor y se agregó únicamente esa dirección al firewall de la BD nueva. Si otro arranque cambia la salida, habrá que actualizar esa regla. El script acepta `-SqlAllowedOutboundIps` para ese caso y se detiene si no puede identificar una dirección; no abre la BD para todo Azure.

## Ejecutar y verificar

Requisitos: Node.js 24, Go 1.27 y acceso a una **BD nueva autorizada**. Las variables de entorno se muestran en `.env.example`; el servicio no carga archivos `.env` automáticamente.

```powershell
npm ci
npm test
npm run build
Push-Location routes
go test ./...
Pop-Location
```

Se incluyen 11 pruebas Node y 7 pruebas Go. `scripts/smoke.js` verifica contra un despliegue: JWT, plantillas reales en la BD nueva, transformación, Go, error controlado, cinco peticiones concurrentes, conciliación del 502 e idempotencia.

```powershell
node scripts/smoke.js https://URL-DEMO RUTA-CONFIG-PRIVADA RUTA-REPORTE.json
```

El archivo privado contiene secretos de esta demostración y debe permanecer fuera del repositorio, ZIP y capturas. Los reportes de verificación no incluyen contraseñas ni tokens.

## Endosos

`POST /endorse/translate` conserva el endpoint pedido. `POST /api/v1/endorse/translate` expone la versión explícita. Ambos requieren JWT.

El servicio consulta `Templates`, `TemplateMappings` y `TemplateEvents`. Las rutas de destino, etiquetas, orden, tipos y valores por defecto vienen de la BD. Se incluye el ejemplo Rumbo/CambioFrecuencia y una segunda configuración VidaDemo. El motor no contiene condicionales por producto.

`config/templates.json` es la configuración inicial. Para ampliar productos en ejecución se agregan registros/configuraciones en esas tablas; modificar el JSON local por sí solo no altera la BD. El inicializador agrega versiones inexistentes y conserva versiones existentes. Una versión nueva necesita desactivar la anterior en una transacción de administración antes de activarse, según el índice de unicidad.

El valor por defecto se usa cuando el campo está ausente. `0`, `false` y cadena vacía se conservan si su tipo lo admite. Un `null` no satisface un campo requerido. Las fechas deben existir en el calendario. Las etiquetas y eventos se ordenan explícitamente; el orden de propiedades de un objeto JSON no define el contrato.

## Rutas

`POST /api/v1/routes/optimal` usa Dijkstra con múltiples orígenes y una cola de prioridad. Soporta grafos dirigidos y no dirigidos de pesos no negativos. Resuelve empates por nombre de base, de forma determinista. Valida nodos, pesos y tamaño, y responde 422 si el destino es inalcanzable.

La API Hapi transmite el JWT al proceso Go interno. Go verifica firma HS256, emisor, audiencia, expiración, sujeto y alcance.

## Préstamos: cómo demostrar el 502

1. Ingresar a **Préstamos confiables** y seleccionar un préstamo con escenario 502, o pulsar **Nuevo caso con 502** para generar otro caso ficticio.
2. Pulsar **Enviar 5 solicitudes concurrentes**. Se usan claves diferentes con la misma intención de préstamo, para verificar la restricción de negocio además de la clave de idempotencia.
3. La API persiste operación + Outbox en una transacción y responde 202 con el identificador.
4. El simulador registra su desembolso por referencia única y devuelve 502 la primera vez.
5. El worker guarda `POR_CONFIRMAR`, luego consulta esa referencia y confirma `DESEMBOLSADO`.
6. La interfaz muestra **1 desembolso simulado**, y las cinco solicitudes recuperan la misma operación.

Cada clave recibida se vincula a su operación y hash. Reutilizar una clave con otro préstamo devuelve 409. La intención de préstamo también tiene una restricción única, para impedir que claves distintas creen operaciones duplicadas. La referencia del simulador tiene una clave primaria y su registro se hace en una transacción.

Una redelivery o una caída entre el efecto y la confirmación se resuelve consultando la referencia. Si el resultado no puede confirmarse, el estado pasa a `EN_REVISION`; no se ordena otro desembolso a ciegas. En la demostración, el worker procesa el Outbox después de que la aplicación despierta. Si la réplica escala a cero, los trabajos pendientes esperan al siguiente arranque.

`POST /api/v1/demo/loans` solo genera casos ficticios con monto fijo en esta demostración. No es un endpoint de aprobación de créditos para producción.

## Arquitectura propuesta para producción

`docs/Arquitectura-Azure.drawio` separa la demostración desplegada de la propuesta distribuida. `src/main.js` y `src/messaging.js` conservan los roles API, publicador y consumidor para Service Bus, pero **esa variante no fue desplegada ni probada en Azure Service Bus**.

La propuesta utiliza Outbox, Service Bus, consumidores idempotentes y conciliación. El receptor que materializa el desembolso debe proteger su referencia de forma atómica y permitir consultar su resultado. La cola no garantiza por sí sola un único efecto financiero. Sin esa capacidad en el core/proveedor de pago no puede prometerse eliminación total de duplicados desde Azure.

Antes de producción hacen falta identidad real, autorización por cliente y póliza, identidades administradas y permisos por rol, conectividad privada, integración con el core, alertas/DLQ, pruebas de fallos distribuidos y evaluación de costos. La cuenta compartida `evaluador` y los secretos de demostración no sirven para producción.

## Docker y despliegue

- `Dockerfile`: API/React, para la arquitectura con servicios separados.
- `routes/Dockerfile`: API Go.
- `Dockerfile.demo`: contenedor integrado para reproducir esta demostración.
- `infra/bootstrap.ps1`: grupo aislado, nueva BD gratuita, esquema y configuración inicial.
- `infra/package-runtime.ps1`: paquete de ejecución sin secretos.
- `infra/deploy-demo.ps1`: almacenamiento privado, acceso temporal al paquete y Container Apps sin ACR ni Service Bus.

Para una ventana de evaluación continua, el script permite `-MinimumReplicas 1` y `-PackageAccessHours` entre 1 y 24. La primera opción evita el reposo por inactividad; la segunda permite que los nuevos arranques descarguen el paquete durante la ventana configurada. Estas opciones no crean un apagado automático al finalizar el plazo.

Los Dockerfiles se entregan; Docker Desktop local no estuvo operativo para construirlos. El despliegue temporal utiliza la imagen pública oficial de Node y el ejecutable Go compilado para Linux/amd64 con `CGO_ENABLED=0`.

El archivo privado se genera fuera del repositorio:

```powershell
node scripts/make-config.js RUTA-FUERA-DEL-REPOSITORIO.json ID-SUSCRIPCION-AUTORIZADA
```

No ejecutar scripts contra bases ajenas. `src/db.js` y `sql/schema.sql` rechazan un nombre de BD diferente de `talsory`; también debe comprobarse que el servidor de destino sea el recién creado para el reto.

## Referencias

- [Container Apps](https://learn.microsoft.com/azure/container-apps/overview)
- [Cuotas y facturación](https://learn.microsoft.com/azure/container-apps/billing)
- [Oferta gratuita de Azure SQL](https://learn.microsoft.com/azure/azure-sql/database/free-tier)
- [Solicitud/respuesta asíncrona](https://learn.microsoft.com/azure/architecture/patterns/asynchronous-request-reply)
- [Outbox transaccional](https://learn.microsoft.com/azure/architecture/databases/guide/transactional-out-box-cosmos)
- [Duplicados y garantías de Service Bus](https://learn.microsoft.com/azure/service-bus-messaging/service-bus-message-loss-and-duplicates)
