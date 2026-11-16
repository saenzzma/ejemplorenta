import React, { useState, useRef, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";
const endoso = {
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
const rutas = {
  accidentLocation: "San Isidro",
  depots: ["Miraflores", "Ate"],
  graph: {
    Miraflores: { "San Isidro": 7, Barranco: 3 },
    "San Isidro": { Miraflores: 7, Lince: 4 },
    Barranco: { Miraflores: 3, Surco: 5 },
    Lince: { "San Isidro": 4, Surco: 6 },
    Surco: { Barranco: 5, Lince: 6, Ate: 10 },
    Ate: { Surco: 10 },
  },
};
const pretty = (value) => JSON.stringify(value, null, 2);
function App() {
  const [token, setToken] = useState(""),
    [password, setPassword] = useState(""),
    [username, setUsername] = useState("evaluador");
  const [tab, setTab] = useState("endosos"),
    [input, setInput] = useState(pretty(endoso)),
    [output, setOutput] = useState(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [templates, setTemplates] = useState([]),
    [loans, setLoans] = useState([]),
    [operation, setOperation] = useState(null),
    [selectedLoan, setSelectedLoan] = useState("demo-502");
  const keys = useRef(new Map());
  async function api(path, { method = "GET", body, headers = {} } = {}) {
    const response = await fetch(path, {
      method,
      headers: {
        ...(token ? { authorization: "Bearer " + token } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    let data;
    try {
      data = await response.json();
    } catch {
      throw Error("El servicio no devolvió una respuesta válida.");
    }
    if (!response.ok) {
      if (response.status === 401 && token) setToken("");
      throw Error(
        data.message || data.code || "No se pudo completar la solicitud.",
      );
    }
    return data;
  }
  async function login(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const data = await api("/api/v1/auth/login", {
        method: "POST",
        body: { username, password },
      });
      setToken(data.accessToken);
      setPassword("");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!token) return;
    let active = true;
    Promise.all([api("/api/v1/templates"), api("/api/v1/loans/approved")])
      .then(([t, l]) => {
        if (active) {
          setTemplates(t);
          setLoans(l);
        }
      })
      .catch((e) => active && setError(e.message));
    return () => {
      active = false;
    };
  }, [token]);
  useEffect(() => {
    if (
      !token ||
      !operation?.operationId ||
      ["DESEMBOLSADO", "RECHAZADO", "EN_REVISION"].includes(operation.status)
    )
      return;
    let active = true;
    const timer = setInterval(async () => {
      try {
        const state = await api("/api/v1/operations/" + operation.operationId);
        if (active) {
          setOperation(state);
          setError("");
        }
      } catch (e) {
        if (active)
          setError(
            "No se pudo consultar el estado. La operación puede seguir en proceso. " +
              e.message,
          );
      }
    }, 2500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [token, operation?.operationId, operation?.status]);
  function selectTab(next) {
    setTab(next);
    setError("");
    setOutput(null);
    if (next === "endosos") setInput(pretty(endoso));
    if (next === "rutas") setInput(pretty(rutas));
  }
  async function execute() {
    setBusy(true);
    setError("");
    setOutput(null);
    try {
      const body = JSON.parse(input);
      setOutput(
        await api(
          tab === "endosos"
            ? "/api/v1/endorse/translate"
            : "/api/v1/routes/optimal",
          { method: "POST", body },
        ),
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function newLoan() {
    setBusy(true);
    setError("");
    try {
      const loan = await api("/api/v1/demo/loans", {
        method: "POST",
        body: { scenario: "timeout-after-success" },
      });
      setLoans(await api("/api/v1/loans/approved"));
      setSelectedLoan(loan.approvedLoanId);
      setOperation(null);
      setOutput(null);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function requestLoan(concurrent = false) {
    setBusy(true);
    setError("");
    try {
      if (!keys.current.has(selectedLoan))
        keys.current.set(selectedLoan, crypto.randomUUID());
      const requests = Array.from({ length: concurrent ? 5 : 1 }, (_, i) =>
        api("/api/v1/loans", {
          method: "POST",
          body: { approvedLoanId: selectedLoan },
          headers: {
            "idempotency-key":
              concurrent && i > 0
                ? crypto.randomUUID()
                : keys.current.get(selectedLoan),
          },
        }),
      );
      const results = await Promise.all(requests);
      const state = await api("/api/v1/operations/" + results[0].operationId);
      setOperation(state);
      setOutput(
        concurrent
          ? {
              solicitudesEnviadas: 5,
              operacionesUnicas: new Set(results.map((r) => r.operationId))
                .size,
              operationId: state.operationId,
            }
          : null,
      );
      setLoans(await api("/api/v1/loans/approved"));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <header>
        <div className="brand">
          <span className="brand-symbol">E</span>
          <div>
            <strong>Evolution</strong>
            <span>Laboratorio de arquitectura</span>
          </div>
        </div>
        <div className="cloud">
          <span className="dot" />
          Azure · demostración
        </div>
      </header>
      <main>
        <div className="intro">
          <div>
            <span className="eyebrow">RETO TÉCNICO · TECHNICAL LEAD</span>
            <h1>
              De la solicitud
              <br />a una respuesta confiable.
            </h1>
            <p>
              Plantillas dinámicas, rutas óptimas y procesamiento de préstamos
              con control de duplicados.
            </p>
          </div>
          <aside>
            <span>01 / 03</span>
            <p>
              Node.js + Hapi
              <br />
              Go + Dijkstra
              <br />
              React + Azure
            </p>
          </aside>
        </div>
        {!token ? (
          <section className="login">
            <div>
              <span className="eyebrow">ACCESO DE EVALUACIÓN</span>
              <h2>Explora los tres casos.</h2>
              <p>Ingresa con las credenciales entregadas para la revisión.</p>
            </div>
            <form onSubmit={login}>
              <label>
                Usuario
                <input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  required
                />
              </label>
              <label>
                Contraseña
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </label>
              <button disabled={busy}>
                {busy ? "Validando…" : "Ingresar →"}
              </button>
            </form>
          </section>
        ) : (
          <>
            <nav aria-label="Ejercicios">
              {[
                ["endosos", "01", "Traductor de endosos"],
                ["rutas", "02", "Rutas óptimas"],
                ["prestamos", "03", "Préstamos confiables"],
              ].map(([id, n, label]) => (
                <button
                  key={id}
                  className={tab === id ? "active" : ""}
                  aria-pressed={tab === id}
                  onClick={() => selectTab(id)}
                >
                  <span>{n}</span>
                  {label}
                </button>
              ))}
              <button
                className="logout"
                onClick={() => {
                  setToken("");
                  setOperation(null);
                  setOutput(null);
                }}
              >
                Salir
              </button>
            </nav>
            <section className="workspace">
              <div className="section-top">
                <div>
                  <span className="eyebrow">
                    {tab === "endosos"
                      ? "CONFIGURACIÓN EN BASE DE DATOS"
                      : tab === "rutas"
                        ? "CAMINO MÍNIMO · DIJKSTRA"
                        : "PROCESAMIENTO ASÍNCRONO"}
                  </span>
                  <h2>
                    {tab === "endosos"
                      ? "Un formato para cada endoso."
                      : tab === "rutas"
                        ? "La base más cercana, por su ruta real."
                        : "Una solicitud. Un desembolso."}
                  </h2>
                </div>
                <span className="version">API v1</span>
              </div>
              {tab !== "prestamos" ? (
                <>
                  <p className="description">
                    {tab === "endosos"
                      ? "Envía datos planos. La plantilla define las etiquetas, los valores por defecto y el orden del JSON final."
                      : "Edita los distritos, sus conexiones y las bases. El servicio calcula la ruta mínima con pesos no negativos."}
                  </p>
                  {tab === "endosos" && (
                    <div className="templates">
                      Plantillas disponibles:{" "}
                      {templates.map((t) => (
                        <span key={t.producto + t.tipoEndoso}>
                          {t.producto} / {t.tipoEndoso} · v{t.version}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="editors">
                    <div>
                      <div className="editor-heading">
                        <label htmlFor="json-input">JSON de entrada</label>
                        <button
                          className="text-button"
                          onClick={() => {
                            try {
                              setInput(pretty(JSON.parse(input)));
                              setError("");
                            } catch {
                              setError("El JSON no es válido.");
                            }
                          }}
                        >
                          Dar formato
                        </button>
                      </div>
                      <textarea
                        id="json-input"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        spellCheck="false"
                      />
                      <button disabled={busy} onClick={execute}>
                        {busy
                          ? "Procesando…"
                          : tab === "endosos"
                            ? "Traducir endoso →"
                            : "Calcular ruta →"}
                      </button>
                    </div>
                    <div>
                      <div className="editor-heading">
                        <span>Respuesta del servicio</span>
                        <span className="small">application/json</span>
                      </div>
                      <pre className={output ? "result filled" : "result"}>
                        {output
                          ? pretty(output)
                          : "La respuesta aparecerá aquí."}
                      </pre>
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <p className="description">
                    La API registra la solicitud y devuelve su identificador. Un
                    worker procesa la cola y confirma el resultado por
                    referencia, incluso si INARI devuelve un 502.
                  </p>
                  <div className="notice">
                    Todos los préstamos y desembolsos de esta demostración son
                    ficticios.
                  </div>
                  <div className="loan-grid">
                    <div>
                      <label>
                        Préstamo de prueba
                        <select
                          value={selectedLoan}
                          onChange={(e) => {
                            setSelectedLoan(e.target.value);
                            setError("");
                          }}
                        >
                          {loans.map((l) => (
                            <option
                              key={l.approvedLoanId}
                              value={l.approvedLoanId}
                            >
                              {l.policyNumber} · S/ {l.amount} ·{" "}
                              {l.scenario === "normal"
                                ? "Respuesta normal"
                                : "502 después de registrar"}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="actions">
                        <button
                          disabled={busy}
                          onClick={() => requestLoan(false)}
                        >
                          Solicitar / recuperar operación →
                        </button>
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() => requestLoan(true)}
                        >
                          Enviar 5 solicitudes concurrentes
                        </button>
                        <button
                          className="text-button"
                          disabled={busy}
                          onClick={newLoan}
                        >
                          Nuevo caso con 502
                        </button>
                      </div>
                      <p className="small helper">
                        Los reintentos conservan la misma intención de préstamo.
                        El segundo botón usa claves diferentes para comprobar
                        también la restricción de negocio.
                      </p>
                    </div>
                    <div className="operation">
                      <span className="eyebrow">ESTADO DE LA OPERACIÓN</span>
                      <h3 aria-live="polite">
                        {operation?.status || "Sin solicitud seleccionada"}
                      </h3>
                      {operation ? (
                        <>
                          <p className="operation-id">
                            {operation.operationId}
                          </p>
                          <div className="counter">
                            <strong>{operation.disbursementCount ?? 0}</strong>
                            <span>
                              desembolso(s)
                              <br />
                              simulado(s)
                            </span>
                          </div>
                          <p>
                            {operation.status === "DESEMBOLSADO"
                              ? "Resultado confirmado por referencia."
                              : operation.status === "EN_REVISION"
                                ? "El resultado requiere conciliación. No se emite otro desembolso."
                                : "Solicitud recibida. Consultando la confirmación…"}
                          </p>
                        </>
                      ) : (
                        <p>
                          Solicita un préstamo de prueba para observar el
                          proceso.
                        </p>
                      )}
                    </div>
                  </div>
                  {output && (
                    <pre className="concurrency-result">{pretty(output)}</pre>
                  )}
                </>
              )}
            </section>
          </>
        )}
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <footer>
          <span>Reto Talsory · implementación de demostración</span>
          <span>Sin conexión a sistemas reales de desembolso</span>
        </footer>
      </main>
    </>
  );
}
createRoot(document.getElementById("root")).render(<App />);
