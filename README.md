# SOS USM

**Sistema íntegro auxiliar por inteligencia artificial y geolocalización para el llamado de servicios de emergencia en la Universidad Santa María**

Aplicación de demostración de la tesis. Tiene tres componentes:

| Componente | Ruta | Quién lo usa |
|---|---|---|
| **App móvil SOS USM** (React Native + Expo) | `app-movil/` | Comunidad USM: estudiantes, profesores, personal administrativo, seguridad, limpieza y mantenimiento |
| Versión web alternativa (PWA) | `/app/` | Igual que la app móvil, desde el navegador (requiere HTTPS para el GPS) |
| **Central de Bomberos Universitarios** | `/bomberos/` | Bomberos universitarios (con PIN) |
| **Servidor + IA** | `server.js`, `ia.js` | Backend en tiempo real |

## Funcionalidades

### App móvil SOS USM (React Native)
La app oficial está en la carpeta **`app-movil/`**. Las instrucciones para ejecutarla en el teléfono con Expo Go y para generar el APK están en [`app-movil/README.md`](app-movil/README.md).

1. **Permiso de ubicación al entrar** y envío del GPS en **tiempo real** mientras la app está abierta.
2. **Pantalla de inicio con dos opciones:**
   - **Reportar una emergencia:** pide el tipo de miembro de la comunidad (estudiante, profesor, personal administrativo, seguridad, limpieza y mantenimiento), el nombre, la edad, si eres el **afectado** u **observador**, y una breve descripción.
   - **Emergencia de alta prioridad:** abre una advertencia que explica que es **solo para casos extremadamente críticos**, con ejemplos de cuándo usarla y cuándo no. Avisa que **el uso indebido puede traer repercusiones disciplinarias** y exige marcar una casilla de confirmación antes de activar el botón **SOS**. Hay que mantener el botón presionado 3 segundos. No pide datos y envía la alerta con máxima prioridad.
3. **Recomendación inmediata de la IA**, adaptada al rol, la edad y la función de la persona en la universidad.
4. **Chat directo** con los Bomberos Universitarios y seguimiento del estado: Enviada → Recibida → En camino → En sitio → Atendida.

### Registro previo (perfil)
Después del permiso de GPS, la app pide a la persona registrarse en un momento de calma. Se piden datos personales (cédula, teléfono, carrera o área), información médica opcional (sangre, condiciones, alergias, medicamentos) y un contacto de emergencia. Cuando esa persona envía una **alerta SOS**, la central recibe automáticamente su **ficha completa**, sin que tenga que escribir nada. Los perfiles se guardan en `data/perfiles.json` y solo se muestran a los bomberos junto con una alerta.

### Observador que conoce al afectado
Si quien reporta marca **"Otra persona"**, la app pregunta **"¿Conoces a la persona afectada?"**:
- **No:** solo se describe lo que pasó.
- **Sí:** se piden nombre y apellido, edad y, si la sabe, la cédula.

Los datos del observador nunca se usan como si fuera el afectado.

Con lo que da el observador, el servidor busca si el afectado está registrado (`buscar-afectado.js`):
- **Cédula exacta:** coincidencia de confianza **alta**.
- **Nombre y apellido + edad (±1 año):** coincidencia de confianza **media**. La central ve el aviso **"verificar la identidad en el sitio"**.
- **Varias personas coinciden:** **no se adjunta ninguna ficha**, para no enviar los datos médicos de la persona equivocada.

**Confidencialidad:**
- La ficha del afectado **solo la reciben los bomberos**.
- El observador no ve los datos médicos y ni siquiera sabe si la persona está registrada.
- El texto de autorización del registro cubre este caso: los datos se comparten "cuando yo envíe una alerta o cuando otra persona reporte que me ocurrió algo".

### Central de Bomberos
- Mapa en vivo con las emergencias (color según prioridad), el recorrido GPS del usuario y los usuarios conectados.
- Cola de emergencias ordenada por prioridad. Se marcan las que todavía no se han atendido.
- **Sirena sonora**, banner y notificación del navegador ante un pánico o una emergencia crítica.
- Detalle de cada caso: datos del reportante, análisis de la IA, recursos sugeridos y ubicación con enlace de ruta a Google Maps.
- Cambio de estado, asignación de unidad y chat con respuestas rápidas.

### Inteligencia artificial
**En el teléfono, sin internet** (`app-movil/src/ia/motorIA.js`): un clasificador **Naive Bayes** combinado con un **sistema experto** identifica el tipo de emergencia y da las recomendaciones al instante, aunque no haya señal. Exactitud medida: **96,7 %** con frases nuevas (`node scripts/evaluar-ia.js`).

**En el servidor** (`ia.js`):
Funciona en dos etapas:
1. **Clasificador local por reglas** (instantáneo, funciona sin internet): da una respuesta en milisegundos.
2. **Claude (Anthropic)**: refina el análisis (categoría, subtipo, severidad, prioridad de 1 a 5, resumen operativo, recomendaciones y recursos) y lo sustituye en vivo en la app y en la central.

Si no hay API key o falla la conexión, el sistema sigue funcionando con el análisis local.

Categorías: incendio, médica, trauma, fuga de gas o químico, estructural, eléctrica, seguridad y otro.

## Instalación y ejecución

Requisitos: **Node.js 18 o superior**.

```bash
npm install
npm start
```

- App móvil: http://localhost:3000/app/
- Central: http://localhost:3000/bomberos/ (PIN por defecto: **usm2026**)

### Activar la IA con Claude
```bash
export ANTHROPIC_API_KEY="tu-api-key"   # obtenla en https://console.anthropic.com
npm start
```
En Windows (PowerShell): `$env:ANTHROPIC_API_KEY="tu-api-key"; npm start`

### Variables de configuración
| Variable | Por defecto | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor |
| `PIN_BOMBEROS` | `usm2026` | PIN de acceso a la central |
| `ANTHROPIC_API_KEY` | — | Activa el análisis con Claude |
| `CLAUDE_MODEL` | `claude-opus-5-5` | Modelo de Claude |
| `CAMPUS_LAT` / `CAMPUS_LNG` | `10.4806` / `-66.8040` | Centro del mapa (**verifica y ajusta las coordenadas del campus**) |
| `SSL_KEY` / `SSL_CERT` | — | Rutas a certificado para servir por HTTPS |

## Probar en un teléfono real (importante)
Los navegadores **solo permiten el GPS en HTTPS** (o en `localhost`). Tienes dos opciones:

**Opción A: túnel HTTPS (la más fácil para la defensa).** Con el servidor encendido:
```bash
npx cloudflared tunnel --url http://localhost:3000
```
Abre en el teléfono la URL `https://….trycloudflare.com/app/` que te muestra, y la central en la laptop.

**Opción B: certificado propio en la red local.**
```bash
openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=usm"
SSL_KEY=key.pem SSL_CERT=cert.pem npm start
```
Abre `https://IP-DE-TU-PC:3000/app/` en el teléfono y acepta la advertencia del certificado.

**Instalar como app:** en Chrome Android, menú ⋮ → *Agregar a pantalla principal*. En iPhone (Safari): Compartir → *Agregar a inicio*.

**Modo demostración:** si se niega el permiso de GPS (por ejemplo, en un proyector sin GPS), aparece la opción *"simular ubicación en el campus"*.

## Guion sugerido para la defensa
1. Abre la central en la laptop o el proyector e ingresa con el PIN.
2. En el teléfono, abre la app y concede la ubicación. El punto aparece en el mapa de la central.
3. Elige **Reportar una emergencia**, selecciona *Profesor* y reporta como *observador*: "Una persona se desmayó en el pasillo y no responde". Se ve la recomendación de la IA en el teléfono y la alerta crítica con sirena en la central.
4. Desde la central: *Acusar recibo* → asignar "Unidad B-1" → *En camino*, y escribe en el chat. El teléfono se actualiza al instante.
5. Desde otro teléfono, elige **Emergencia de alta prioridad**, acepta la advertencia y mantén presionado **SOS** 3 segundos: aparecen el banner rojo, la sirena y la ubicación sin datos personales.

## Datos y métricas
Los incidentes se guardan en `data/incidentes.json` (historial de estados con marcas de tiempo, mensajes y recorrido GPS), útil como evidencia para el capítulo de resultados.
`GET /api/estadisticas` (con el encabezado `x-pin`) devuelve el total, los casos activos, el desglose por categoría y el **tiempo promedio de acuse de recibo**.

## Estructura
```
app-movil/           App móvil en React Native + Expo (frontend principal)
server.js            Backend Node.js: API REST + Socket.IO (tiempo real) + persistencia
ia.js                Triaje con IA: clasificador local + Claude (salida JSON estructurada)
public/bomberos/     Central de Bomberos Universitarios (panel web)
public/app/          Versión web alternativa de la app (PWA)
demo.html            Demostración interactiva autónoma (sin servidor)
data/                Incidentes registrados
```

## Tecnologías
- **Frontend móvil:** React Native 0.88 con Expo SDK 58 y Expo Router.
- **Panel de bomberos:** HTML5, CSS3 y JavaScript.
- **Backend:** Node.js con Express y Socket.IO.
- **IA:** clasificador por reglas y Claude (SDK oficial de Anthropic).

## Limitaciones (para mencionar en la tesis)
- Es un prototipo: el almacenamiento es un archivo JSON y la autenticación de la central es un PIN compartido. En producción se usarían una base de datos (por ejemplo, PostgreSQL con PostGIS), cuentas individuales y cifrado.
- La ubicación solo se comparte con la app abierta. La app React Native puede ampliarse con rastreo en segundo plano (`expo-location` con permiso "siempre").
- Las recomendaciones de la IA son de **primeros auxilios básicos** y no sustituyen la atención profesional.
