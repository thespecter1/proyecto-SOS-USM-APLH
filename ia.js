// ============================================================================
//  Módulo de Inteligencia Artificial – Triaje de emergencias
//  1) Motor local (Naive Bayes + sistema experto, sin internet) -> respuesta inmediata
//  2) Claude (Anthropic) -> análisis refinado que reemplaza al local
// ============================================================================
const Anthropic = require("@anthropic-ai/sdk");

const MODELO = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const iaRemotaDisponible = Boolean(
  process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN
);
const cliente = iaRemotaDisponible
  ? new Anthropic({ timeout: 25_000, maxRetries: 1 })
  : null;

const CATEGORIAS = [
  "incendio",
  "medica",
  "trauma",
  "fuga_gas_quimico",
  "estructural",
  "electrica",
  "seguridad",
  "otro",
];

// ----------------------------------------------------------------------------
//  Análisis local: el MISMO motor que usa la app sin internet
//  (Naive Bayes + sistema experto, en app-movil/src/ia/motorIA.js)
// ----------------------------------------------------------------------------
const motor = require("./app-movil/src/ia/motorIA");
const NIVELES = ["baja", "moderada", "alta", "critica"];

function analizarLocal({ descripcion = "", rol = "afectado", edad, antecedentes }) {
  return motor.analizarEmergencia({ descripcion, rol, edad, perfil: antecedentes || undefined });
}

// ----------------------------------------------------------------------------
//  Análisis con Claude
// ----------------------------------------------------------------------------
const TIPO_TEXTO = { estudiante: "Estudiante", profesor: "Profesor", administrativo: "Personal administrativo", seguridad: "Personal de seguridad", limpieza: "Personal de limpieza y mantenimiento" };

const ESQUEMA = {
  type: "object",
  additionalProperties: false,
  required: ["categoria", "subtipo", "severidad", "prioridad", "resumen", "recomendaciones", "recursos"],
  properties: {
    categoria: { type: "string", enum: CATEGORIAS },
    subtipo: { type: "string", description: "Tipo específico de emergencia, en pocas palabras" },
    severidad: { type: "string", enum: NIVELES },
    prioridad: { type: "integer", description: "1 (mínima) a 5 (máxima)" },
    resumen: { type: "string", description: "Resumen operativo de una o dos líneas para los bomberos" },
    recomendaciones: {
      type: "array",
      items: { type: "string" },
      description: "3 a 5 instrucciones breves, en imperativo, para la persona que reporta",
    },
    recursos: {
      type: "array",
      items: { type: "string" },
      description: "Recursos/equipos sugeridos para la respuesta",
    },
  },
};

const SISTEMA = `Eres el módulo de triaje de un sistema de emergencias de la Universidad Santa María (Caracas, Venezuela).
Recibes reportes escritos desde la app móvil SOS USM por miembros de la comunidad universitaria (estudiantes, profesores, personal administrativo, personal de seguridad y personal de limpieza y mantenimiento) y los analizas para el cuerpo de Bomberos Universitarios.

Tu tarea:
1. Determinar con precisión qué está ocurriendo (categoría y subtipo).
2. Asignar severidad (baja, moderada, alta, critica) y prioridad de 1 a 5 (5 = riesgo vital inmediato).
3. Escribir un resumen operativo, claro y sin adornos, para los bomberos.
4. Dar recomendaciones inmediatas a quien reporta, adaptadas a si es el AFECTADO o un OBSERVADOR, a su edad, a su función en la universidad (por ejemplo, el personal de seguridad puede acordonar el área y guiar la evacuación) y a la situación. Deben ser seguras, concretas, en español sencillo y en imperativo; nada que exponga a la persona a más riesgo. Si aplica RCP, maniobra de Heimlich o uso de DEA, dilo de forma breve.
5. Sugerir los recursos que deberían movilizarse.

Si la descripción es ambigua, asume el escenario plausible más grave para la severidad, pero no inventes datos en el resumen.`;

async function analizarConClaude({ nombre, edad, rol, tipoUsuario, descripcion, antecedentes, nombreAfectado }) {
  const respuesta = await cliente.beta.messages.create({
    model: MODELO,
    max_tokens: 2000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: {
      effort: "low", // triaje: priorizamos rapidez
      format: { type: "json_schema", schema: ESQUEMA },
    },
    system: SISTEMA,
    messages: [
      {
        role: "user",
        content: `Nuevo reporte de emergencia:
- Nombre de quien reporta: ${nombre || "No indicado"}
- Miembro de la comunidad USM: ${TIPO_TEXTO[tipoUsuario] || "No indicado"}
- Edad del afectado: ${edad || "No indicada"}${rol === "observador" ? `
- Afectado (según el observador): ${nombreAfectado || "persona desconocida"}` : ""}
- Rol de quien reporta: ${rol === "observador" ? "OBSERVADOR (testigo)" : "AFECTADO"}
- Antecedentes médicos registrados del afectado: ${antecedentes ? [antecedentes.sangre && `sangre ${antecedentes.sangre}`, antecedentes.condiciones && `condiciones: ${antecedentes.condiciones}`, antecedentes.alergias && `alergias: ${antecedentes.alergias}`, antecedentes.medicamentos && `medicamentos: ${antecedentes.medicamentos}`].filter(Boolean).join("; ") || "ninguno declarado" : "no disponibles"}
- Descripción: """${descripcion}"""`,
      },
    ],
  });

  if (respuesta.stop_reason === "refusal") {
    throw new Error("La IA declinó analizar el reporte");
  }
  const texto = respuesta.content.find((b) => b.type === "text")?.text;
  if (!texto) throw new Error("Respuesta de IA vacía");
  const datos = JSON.parse(texto);
  datos.prioridad = Math.max(1, Math.min(5, Math.round(Number(datos.prioridad) || 3)));
  if (!CATEGORIAS.includes(datos.categoria)) datos.categoria = "otro";
  if (!NIVELES.includes(datos.severidad)) datos.severidad = "moderada";
  return { ...datos, fuente: "claude", modelo: respuesta.model || MODELO };
}

/**
 * Analiza un reporte. Llama a `alActualizar` primero con el análisis local
 * (inmediato) y luego con el de Claude si está disponible.
 */
async function analizarReporte(reporte, alActualizar) {
  const local = analizarLocal(reporte);
  alActualizar(local);
  if (!cliente) return local;
  try {
    const remoto = await analizarConClaude(reporte);
    alActualizar(remoto);
    return remoto;
  } catch (err) {
    console.warn("[IA] Se mantiene el análisis local:", err.message);
    return local;
  }
}

// Alerta SOS: mismo protocolo que la app
const analisisPanico = (perfil) => motor.analisisSOS(perfil);

module.exports = { analizarReporte, analizarLocal, analisisPanico, iaRemotaDisponible, MODELO };
