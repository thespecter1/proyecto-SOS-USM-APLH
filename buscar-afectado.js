// ============================================================================
//  Búsqueda del afectado en la base de perfiles registrados.
//
//  Cuando un OBSERVADOR conoce a la persona afectada (por ejemplo, alguien que
//  se desmayó y no puede hablar), da su nombre, su edad y, si la sabe, su
//  cédula. Con eso se busca si esa persona se registró en SOS USM para que los
//  Bomberos Universitarios reciban su ficha médica.
//
//  Criterios (de más a menos confiable):
//   1. Cédula exacta                          → coincidencia "alta"
//   2. Nombre y apellido + edad (± 1 año)     → coincidencia "media" (verificar)
//  Si hay varias personas que coinciden, NO se adjunta ninguna ficha: es
//  preferible no enviar datos médicos que enviar los de la persona equivocada.
// ============================================================================

const normalizar = (t = "") =>
  String(t).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9ñ\s]/g, " ").replace(/\s+/g, " ").trim();
const soloDigitos = (c = "") => String(c).replace(/\D/g, "");

/**
 * @param {Array} perfiles  Lista de perfiles registrados
 * @param {{nombre?: string, edad?: number|string, cedula?: string}} datos  Datos que dio el observador
 * @returns {{estado: "encontrado"|"no_encontrado"|"ambiguo"|"insuficiente", nivel?: string, criterio?: string, perfil?: object, total?: number}}
 */
function buscarAfectado(perfiles, { nombre, edad, cedula } = {}) {
  const ced = soloDigitos(cedula);
  if (ced.length >= 6) {
    const p = perfiles.find((x) => soloDigitos(x.cedula) === ced);
    if (p) return { estado: "encontrado", nivel: "alta", criterio: "cédula", perfil: p };
  }

  const palabras = normalizar(nombre).split(" ").filter((t) => t.length > 1);
  const e = Number(edad);
  // Con un solo nombre ("Carlos") o sin edad hay demasiado riesgo de confundir personas
  if (palabras.length < 2 || !e) return { estado: ced.length >= 6 ? "no_encontrado" : "insuficiente" };

  const candidatos = perfiles.filter((x) => {
    const registrado = normalizar(x.nombre).split(" ");
    const nombreCoincide = palabras.every((t) => registrado.includes(t)); // "Luis Ramírez" ⊂ "Luis Alberto Ramírez"
    const edadCoincide = Number(x.edad) > 0 && Math.abs(Number(x.edad) - e) <= 1;
    return nombreCoincide && edadCoincide;
  });
  if (candidatos.length === 1) return { estado: "encontrado", nivel: "media", criterio: "nombre y edad", perfil: candidatos[0] };
  if (candidatos.length > 1) return { estado: "ambiguo", total: candidatos.length };
  return { estado: "no_encontrado" };
}

module.exports = { buscarAfectado, normalizar };
