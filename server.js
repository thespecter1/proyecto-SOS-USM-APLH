// ============================================================================
//  Sistema Íntegro Auxiliar por IA y Geolocalización – Universidad Santa María
//  Servidor: API REST + tiempo real (Socket.IO)
// ============================================================================
const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");
const express = require("express");
const { Server } = require("socket.io");
const { analizarReporte, analisisPanico, iaRemotaDisponible, MODELO } = require("./ia");
const { buscarAfectado } = require("./buscar-afectado");

const PUERTO = Number(process.env.PORT || 3000);
const PIN_BOMBEROS = process.env.PIN_BOMBEROS || "usm2026";
const CAMPUS = {
  lat: Number(process.env.CAMPUS_LAT || 10.4806),
  lng: Number(process.env.CAMPUS_LNG || -66.8040),
  nombre: "Universidad Santa María – Campus La Florencia",
};
const TIPOS_USUARIO = ["estudiante", "profesor", "administrativo", "seguridad", "limpieza"];
const ARCHIVO_DATOS = path.join(__dirname, "data", "incidentes.json");
const ARCHIVO_PERFILES = path.join(__dirname, "data", "perfiles.json");
const TIPOS_SANGRE = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-", "No sé"];

// ---------------------------------------------------------------------------
//  Almacenamiento (memoria + archivo JSON para evidencias de la tesis)
// ---------------------------------------------------------------------------
let incidentes = [];
try {
  incidentes = JSON.parse(fs.readFileSync(ARCHIVO_DATOS, "utf8"));
} catch {
  incidentes = [];
}
let guardadoPendiente = null;
function guardar() {
  clearTimeout(guardadoPendiente);
  guardadoPendiente = setTimeout(() => {
    fs.mkdirSync(path.dirname(ARCHIVO_DATOS), { recursive: true });
    fs.writeFileSync(ARCHIVO_DATOS, JSON.stringify(incidentes, null, 2));
  }, 300);
}
const buscar = (id) => incidentes.find((i) => i.id === id);

// Perfiles registrados por los usuarios en un momento de calma (deviceId -> perfil).
// Solo se muestran a los bomberos cuando esa persona envía una alerta.
let perfiles = {};
try {
  perfiles = JSON.parse(fs.readFileSync(ARCHIVO_PERFILES, "utf8"));
} catch {
  perfiles = {};
}
function guardarPerfiles() {
  fs.mkdirSync(path.dirname(ARCHIVO_PERFILES), { recursive: true });
  fs.writeFileSync(ARCHIVO_PERFILES, JSON.stringify(perfiles, null, 2));
}
const texto = (v, max = 120) => (v == null ? "" : String(v).trim().slice(0, max));
function limpiarPerfil(p = {}) {
  return {
    tipoUsuario: TIPOS_USUARIO.includes(p.tipoUsuario) ? p.tipoUsuario : "estudiante",
    nombre: texto(p.nombre, 80),
    cedula: texto(p.cedula, 20),
    edad: Number(p.edad) > 0 && Number(p.edad) < 120 ? Number(p.edad) : null,
    telefono: texto(p.telefono, 25),
    carrera: texto(p.carrera, 80),
    sangre: TIPOS_SANGRE.includes(p.sangre) ? p.sangre : "",
    alergias: texto(p.alergias, 300),
    condiciones: texto(p.condiciones, 300),
    medicamentos: texto(p.medicamentos, 300),
    contactoNombre: texto(p.contactoNombre, 80),
    contactoTelefono: texto(p.contactoTelefono, 25),
    contactoParentesco: texto(p.contactoParentesco, 40),
    actualizado: Date.now(),
  };
}
// Registra o actualiza el perfil de un dispositivo. Devuelve el perfil o null si no es válido.
function registrarPerfil(deviceId, datos) {
  if (!deviceId || !datos || !datos.consentimiento) return null;
  const p = limpiarPerfil(datos);
  if (!p.nombre || !p.cedula || !p.telefono) return null;
  perfiles[deviceId] = p;
  guardarPerfiles();
  return p;
}
const nuevoId = () =>
  "EMG-" + Date.now().toString(36).toUpperCase() + "-" + crypto.randomBytes(2).toString("hex").toUpperCase();

// Usuarios de la app conectados (para ver presencia en el mapa)
const dispositivos = new Map(); // deviceId -> { ubicacion, socketId, visto }

// ---------------------------------------------------------------------------
//  Servidor HTTP(S)
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "100kb" }));
// CORS: permite que la app React Native (y su versión web de pruebas) consuma la API
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, x-pin");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname, "public")));
app.use("/vendor/leaflet", express.static(path.join(__dirname, "node_modules", "leaflet", "dist")));
app.get("/", (_req, res) => res.redirect("/app/"));

let servidor;
if (process.env.SSL_KEY && process.env.SSL_CERT) {
  servidor = https.createServer(
    { key: fs.readFileSync(process.env.SSL_KEY), cert: fs.readFileSync(process.env.SSL_CERT) },
    app
  );
} else {
  servidor = http.createServer(app);
}
const io = new Server(servidor, { cors: { origin: "*" } });

function esBombero(req) {
  return req.get("x-pin") === PIN_BOMBEROS;
}

// Vista pública de un incidente para el usuario de la app
function vistaUsuario(inc) {
  const { id, tipo, estado, creadoEn, analisis, mensajes, asignado } = inc;
  return { id, tipo, estado, creadoEn, asignado, analisis, mensajes };
}

function emitirActualizacion(inc) {
  io.to("bomberos").emit("incidente:actualizado", inc);
  io.to("inc:" + inc.id).emit("incidente:actualizado", vistaUsuario(inc));
  guardar();
}

function mensajeSistema(inc, texto) {
  const m = { id: crypto.randomUUID(), de: "sistema", texto, ts: Date.now() };
  inc.mensajes.push(m);
  io.to("bomberos").emit("chat:mensaje", { incidenteId: inc.id, mensaje: m });
  io.to("inc:" + inc.id).emit("chat:mensaje", { incidenteId: inc.id, mensaje: m });
}

function crearIncidente({ tipo, deviceId, reportante, descripcion, ubicacion }) {
  const inc = {
    id: nuevoId(),
    tipo, // 'reporte' | 'panico'
    estado: "nuevo", // nuevo -> recibido -> en_camino -> en_sitio -> resuelto
    creadoEn: Date.now(),
    deviceId,
    reportante: reportante || null,
    perfil: perfiles[deviceId] || null, // ficha registrada previamente (si existe)
    descripcion: descripcion || "",
    ubicacion: ubicacion || dispositivos.get(deviceId)?.ubicacion || null,
    recorrido: ubicacion ? [ubicacion] : [],
    analisis: null,
    asignado: null,
    mensajes: [],
    historial: [{ estado: "nuevo", ts: Date.now() }],
  };
  incidentes.unshift(inc);
  return inc;
}

// ---------------------------------------------------------------------------
//  API REST
// ---------------------------------------------------------------------------
// Registro del perfil (se hace en un momento de calma, desde la app)
app.post("/api/perfil", (req, res) => {
  const { deviceId, perfil } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: "Dispositivo no identificado." });
  if (!perfil?.consentimiento) return res.status(400).json({ error: "Debes autorizar el uso de tus datos en emergencias." });
  const p = registrarPerfil(deviceId, perfil);
  if (!p) return res.status(400).json({ error: "Nombre, cédula y teléfono son obligatorios." });
  res.json({ ok: true, perfil: p });
});

app.get("/api/perfil", (req, res) => {
  const p = perfiles[req.query.deviceId];
  if (!p) return res.status(404).json({ error: "Sin perfil registrado" });
  res.json(p);
});

app.get("/api/config", (_req, res) => {
  res.json({ campus: CAMPUS, ia: { remota: iaRemotaDisponible, modelo: iaRemotaDisponible ? MODELO : "local" } });
});

// Reporte de emergencia con datos
app.post("/api/incidentes", (req, res) => {
  const { deviceId, tipoUsuario, nombre, edad, rol, descripcion, ubicacion, perfil, afectado } = req.body || {};
  if (!deviceId || !nombre?.trim() || !descripcion?.trim()) {
    return res.status(400).json({ error: "Nombre y descripción son obligatorios." });
  }
  if (perfil) registrarPerfil(deviceId, perfil); // sincroniza el perfil si la app lo envía
  const inc = crearIncidente({
    tipo: "reporte",
    deviceId,
    reportante: {
      nombre: String(nombre).trim().slice(0, 80),
      edad: edad ? Number(edad) : null,
      rol: rol === "observador" ? "observador" : "afectado",
      tipoUsuario: TIPOS_USUARIO.includes(tipoUsuario) ? tipoUsuario : "estudiante",
    },
    descripcion: String(descripcion).trim().slice(0, 1000),
    ubicacion,
  });
  // Observador que conoce al afectado: se busca si esa persona está registrada.
  // Su ficha (si existe) SOLO la reciben los bomberos; nunca vuelve al teléfono del observador.
  if (inc.reportante.rol === "observador" && afectado?.conocido) {
    inc.afectado = {
      conocido: true,
      nombre: texto(afectado.nombre, 80),
      edad: Number(afectado.edad) > 0 && Number(afectado.edad) < 120 ? Number(afectado.edad) : null,
      cedula: texto(afectado.cedula, 20),
    };
    const r = buscarAfectado(Object.values(perfiles), inc.afectado);
    inc.coincidencia = { estado: r.estado, nivel: r.nivel || null, criterio: r.criterio || null, total: r.total || null };
    inc.perfilAfectado = r.perfil || null;
  } else if (inc.reportante.rol === "observador") {
    inc.afectado = { conocido: false };
  }

  mensajeSistema(inc, "Reporte recibido. La IA está analizando la emergencia y los Bomberos Universitarios fueron notificados.");
  io.to("bomberos").emit("incidente:nuevo", inc);
  guardar();

  // Análisis IA: local inmediato + Claude (refinado) en segundo plano
  let primera = true;
  analizarReporte(
    {
      nombre: inc.reportante.nombre, rol: inc.reportante.rol,
      // La edad que importa es la del afectado: la propia si reporta el afectado, o la que dio el observador
      edad: inc.reportante.rol === "afectado" ? inc.reportante.edad : inc.afectado?.edad ?? null,
      nombreAfectado: inc.afectado?.nombre || null,
      tipoUsuario: inc.reportante.tipoUsuario, descripcion: inc.descripcion,
      // Antecedentes médicos registrados: solo aplican si quien reporta es el afectado
      antecedentes: inc.reportante.rol === "afectado" ? inc.perfil : null,
    },
    (analisis) => {
      inc.analisis = { ...analisis, ts: Date.now() };
      if (!primera) mensajeSistema(inc, "La IA refinó el análisis y las recomendaciones.");
      primera = false;
      emitirActualizacion(inc);
    }
  );

  res.status(201).json(vistaUsuario(inc));
});

// Alerta SOS de alta prioridad: sin datos, máxima prioridad
app.post("/api/panico", (req, res) => {
  const { deviceId, ubicacion, perfil } = req.body || {};
  if (!deviceId) return res.status(400).json({ error: "Dispositivo no identificado." });
  if (perfil) registrarPerfil(deviceId, perfil);
  const inc = crearIncidente({ tipo: "panico", deviceId, ubicacion });
  inc.analisis = { ...analisisPanico(inc.perfil), ts: Date.now() };
  mensajeSistema(inc, inc.perfil
    ? "Alerta SOS enviada con máxima prioridad. Los Bomberos Universitarios tienen tu ubicación y tu ficha registrada."
    : "Alerta SOS enviada con máxima prioridad. Los Bomberos Universitarios tienen tu ubicación.");
  io.to("bomberos").emit("incidente:nuevo", inc);
  io.to("bomberos").emit("alarma:panico", { id: inc.id });
  guardar();
  res.status(201).json(vistaUsuario(inc));
});

// Consulta de un incidente por el usuario dueño
app.get("/api/incidentes/:id", (req, res) => {
  const inc = buscar(req.params.id);
  if (!inc) return res.status(404).json({ error: "No encontrado" });
  if (esBombero(req)) return res.json(inc);
  if (req.query.deviceId !== inc.deviceId) return res.status(403).json({ error: "Sin acceso" });
  res.json(vistaUsuario(inc));
});

// Listado completo para bomberos
app.get("/api/incidentes", (req, res) => {
  if (!esBombero(req)) return res.status(401).json({ error: "PIN inválido" });
  res.json(incidentes);
});

// Estadísticas (útil para el capítulo de resultados de la tesis)
app.get("/api/estadisticas", (req, res) => {
  if (!esBombero(req)) return res.status(401).json({ error: "PIN inválido" });
  const porCategoria = {};
  const tiemposRespuesta = [];
  for (const i of incidentes) {
    const c = i.tipo === "panico" ? "panico" : i.analisis?.categoria || "otro";
    porCategoria[c] = (porCategoria[c] || 0) + 1;
    const recibido = i.historial.find((h) => h.estado === "recibido");
    if (recibido) tiemposRespuesta.push((recibido.ts - i.creadoEn) / 1000);
  }
  const prom = tiemposRespuesta.length ? tiemposRespuesta.reduce((a, b) => a + b, 0) / tiemposRespuesta.length : null;
  res.json({
    total: incidentes.length,
    activos: incidentes.filter((i) => i.estado !== "resuelto").length,
    porCategoria,
    tiempoPromedioAcuseSeg: prom && Math.round(prom),
  });
});

// ---------------------------------------------------------------------------
//  Tiempo real
// ---------------------------------------------------------------------------
const ESTADOS = ["nuevo", "recibido", "en_camino", "en_sitio", "resuelto"];
const TEXTO_ESTADO = {
  recibido: "Los Bomberos Universitarios recibieron tu alerta.",
  en_camino: "🚒 Una unidad va en camino hacia tu ubicación.",
  en_sitio: "La unidad llegó al sitio.",
  resuelto: "La emergencia fue marcada como atendida. ¡Gracias por reportar!",
};

io.on("connection", (socket) => {
  const { rol, pin, deviceId } = socket.handshake.auth || {};

  // ---------------- Bomberos ----------------
  if (rol === "bomberos") {
    if (pin !== PIN_BOMBEROS) {
      socket.emit("auth:error", "PIN inválido");
      return socket.disconnect(true);
    }
    socket.join("bomberos");
    socket.emit("auth:ok", {
      incidentes,
      dispositivos: [...dispositivos.entries()].map(([id, d]) => ({ id, ...d })),
    });

    socket.on("incidente:estado", ({ id, estado, unidad }) => {
      const inc = buscar(id);
      if (!inc || !ESTADOS.includes(estado)) return;
      inc.estado = estado;
      if (unidad) inc.asignado = String(unidad).slice(0, 60);
      inc.historial.push({ estado, ts: Date.now() });
      if (TEXTO_ESTADO[estado]) mensajeSistema(inc, TEXTO_ESTADO[estado]);
      emitirActualizacion(inc);
    });

    socket.on("chat:enviar", ({ incidenteId, texto }) => {
      const inc = buscar(incidenteId);
      if (!inc || !texto?.trim()) return;
      const m = { id: crypto.randomUUID(), de: "bomberos", texto: String(texto).slice(0, 1000), ts: Date.now() };
      inc.mensajes.push(m);
      // Acusar recibo automáticamente al responder por primera vez
      if (inc.estado === "nuevo") {
        inc.estado = "recibido";
        inc.historial.push({ estado: "recibido", ts: Date.now() });
      }
      io.to("bomberos").emit("chat:mensaje", { incidenteId: inc.id, mensaje: m });
      io.to("inc:" + inc.id).emit("chat:mensaje", { incidenteId: inc.id, mensaje: m });
      emitirActualizacion(inc);
    });
    return;
  }

  // ---------------- Usuario de la app ----------------
  if (!deviceId) return socket.disconnect(true);
  dispositivos.set(deviceId, { ...(dispositivos.get(deviceId) || {}), socketId: socket.id, visto: Date.now(), conectado: true });

  socket.on("incidente:unirse", (id) => {
    const inc = buscar(id);
    if (inc && inc.deviceId === deviceId) {
      socket.join("inc:" + id);
      socket.emit("incidente:actualizado", vistaUsuario(inc));
    }
  });

  socket.on("ubicacion", (u) => {
    if (typeof u?.lat !== "number" || typeof u?.lng !== "number") return;
    const ubicacion = { lat: u.lat, lng: u.lng, precision: u.precision ?? null, ts: Date.now() };
    dispositivos.set(deviceId, { ...dispositivos.get(deviceId), ubicacion, visto: Date.now(), conectado: true });
    io.to("bomberos").emit("dispositivo:ubicacion", { id: deviceId, ubicacion });

    // Seguimiento en vivo de incidentes activos de este dispositivo
    for (const inc of incidentes) {
      if (inc.deviceId === deviceId && inc.estado !== "resuelto") {
        inc.ubicacion = ubicacion;
        inc.recorrido.push(ubicacion);
        if (inc.recorrido.length > 200) inc.recorrido.shift();
        io.to("bomberos").emit("incidente:ubicacion", { id: inc.id, ubicacion });
      }
    }
    guardar();
  });

  socket.on("chat:enviar", ({ incidenteId, texto }) => {
    const inc = buscar(incidenteId);
    if (!inc || inc.deviceId !== deviceId || !texto?.trim()) return;
    const m = { id: crypto.randomUUID(), de: "usuario", texto: String(texto).slice(0, 1000), ts: Date.now() };
    inc.mensajes.push(m);
    io.to("bomberos").emit("chat:mensaje", { incidenteId: inc.id, mensaje: m });
    io.to("inc:" + inc.id).emit("chat:mensaje", { incidenteId: inc.id, mensaje: m });
    guardar();
  });

  socket.on("disconnect", () => {
    const d = dispositivos.get(deviceId);
    if (d && d.socketId === socket.id) {
      d.conectado = false;
      io.to("bomberos").emit("dispositivo:desconectado", { id: deviceId });
    }
  });
});

servidor.listen(PUERTO, "0.0.0.0", () => {
  const proto = process.env.SSL_KEY ? "https" : "http";
  console.log(`\n  🚒 SOS USM en ${proto}://localhost:${PUERTO}`);
  console.log(`     App móvil:        ${proto}://localhost:${PUERTO}/app/`);
  console.log(`     Panel bomberos:   ${proto}://localhost:${PUERTO}/bomberos/   (PIN: ${PIN_BOMBEROS})`);
  console.log(`     IA:               ${iaRemotaDisponible ? "Claude (" + MODELO + ") + respaldo local" : "Clasificador local (define ANTHROPIC_API_KEY para usar Claude)"}\n`);
});
