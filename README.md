# Nexus OS Dashboard

Dashboard personal para reunir agenda diaria, calendario semanal, control de sueno, proyectos activos, progreso y futuras recomendaciones con AI.

## Ejecutar

```bash
npm install
npm run dev
```

Luego abrir la URL local que muestra Vite.

Para usar tambien el backend local, abrir otra terminal:

```bash
npm run dev:api
```

Por defecto:

- Frontend: `http://127.0.0.1:5173`
- Backend API: `http://127.0.0.1:8787`

## Deploy gratis con Vercel + Supabase

La app esta preparada para correr en Vercel Free usando Supabase Free como base de datos. En local usa SQLite; en Vercel usa Supabase cuando existen `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY`.

### 1. Crear base en Supabase

1. Crear un proyecto en Supabase.
2. Abrir **SQL Editor**.
3. Ejecutar el contenido de `supabase/schema.sql`.
4. Copiar:
   - `Project URL` como `SUPABASE_URL`.
   - `service_role key` como `SUPABASE_SERVICE_ROLE_KEY`.

La `service_role key` nunca debe ir al frontend ni tener prefijo `VITE_`.

### 2. Crear proyecto en Vercel

1. Importar el repo `alvarogarcia33/dashboard`.
2. Framework: **Vite**.
3. Build command: `npm run build`.
4. Output directory: `dist`.
5. Root directory: vacio.

Variables de entorno en Vercel:

```bash
VITE_GOOGLE_CLIENT_ID=...
VITE_DEMO_USER_ID=demo
GOOGLE_CLIENT_ID=...
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.5
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
```

No configures `VITE_API_BASE_URL` en Vercel salvo que separes frontend y backend. Si queda vacia, el frontend llama a `/api` en el mismo dominio.

### 3. Google OAuth

Cuando Vercel genere la URL publica, agregarla en Google Cloud:

- Authorized JavaScript origins: `https://tu-app.vercel.app`
- Authorized redirect URIs: no hace falta para el flujo actual de Google Identity Services.

## Que incluye el MVP

- Reuniones del dia con bloques por tipo.
- Calendario semanal con horas ocupadas.
- Registro de sueno con grafica de tendencia, historial editable y horas de dormir/despertar.
- Proyectos con progreso, estado y proxima accion.
- Graficas de carga semanal, progreso y distribucion de estados.
- Selector de paleta visual con modo claro, azul, oscuro dorado y verde calma.
- Dashboard configurable para mostrar u ocultar indicadores, agenda, sueno, proyectos y AI.
- Persistencia local con `localStorage`, exportacion/importacion de backup, reset seguro y recuperacion ante datos corruptos.
- Backend local con API y SQLite para guardar/cargar snapshots del dashboard por usuario demo.
- Autenticacion con Sign in with Google, sesiones propias del backend y datos separados por usuario.
- Sincronizacion real con Google Calendar usando OAuth y Google Identity Services.
- Visualizacion de Google Tasks para tareas vencidas, de hoy o sin fecha.
- Resumen diario con OpenAI desde el backend, sin exponer la API key en el frontend.
- Asistente de planificacion con chat para preguntar por prioridades, proyectos y organizacion semanal.
- Reporte semanal con OpenAI para cruzar reuniones, sueno, proyectos, victorias, riesgos y proximas acciones.
- Exportacion de reportes semanales a Markdown, copia al portapapeles e impresion para guardar como PDF.

## Backend local

La API esta en `server/index.js` y usa SQLite local en `server/data/dashboard.sqlite`. Ese archivo esta ignorado por Git. Actualmente crea tablas para usuarios, sesiones y snapshots del dashboard.

Endpoints actuales:

- `GET /api/health`
- `POST /api/auth/google`
- `GET /api/auth/me`
- `POST /api/auth/logout`
- `GET /api/dashboard/:userId`
- `PUT /api/dashboard/:userId`
- `DELETE /api/dashboard/:userId`
- `POST /api/openai/daily-summary`
- `POST /api/openai/weekly-report`
- `POST /api/openai/planner-chat`

El frontend usa `VITE_API_BASE_URL` y `VITE_DEMO_USER_ID` para guardar o cargar datos desde el panel **Backend API**. Si el usuario inicia sesion con Google, el dashboard se guarda bajo su usuario real; si no, queda disponible el usuario `demo` para desarrollo local.

## Autenticacion

La app usa Sign in with Google. El frontend recibe el JWT `credential` y lo envia al backend, donde se valida con `google-auth-library` usando `GOOGLE_CLIENT_ID`. Si el token es valido, el backend crea/actualiza el usuario y devuelve una sesion propia.

Configurar ambas variables:

```bash
VITE_GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_ID=...
```

## Google Calendar y Google Tasks

La pantalla lateral permite conectar Google con OAuth y traer eventos del calendario primario y tareas de Google Tasks. Configuracion local:

1. Crear proyecto en Google Cloud.
2. Habilitar Google Calendar API.
3. Habilitar Google Tasks API.
4. Configurar OAuth consent screen.
5. Crear OAuth Client ID para aplicacion web.
6. Agregar `http://localhost:5173` como Authorized JavaScript origin.
7. Copiar el Client ID en `.env` como `VITE_GOOGLE_CLIENT_ID`.
8. Reiniciar `npm run dev`.

La app usa los scopes `https://www.googleapis.com/auth/calendar.readonly` y `https://www.googleapis.com/auth/tasks.readonly`. No guarda el access token en `localStorage`; queda solo en memoria durante la sesion.

## OpenAI

La llamada a OpenAI pasa por el backend propio. No se debe exponer `OPENAI_API_KEY` en el frontend.

Configurar en `.env`:

```bash
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.5
```

Flujo actual:

1. Frontend envia reuniones, tareas, sueno, proyectos y preferencias al backend.
2. Backend arma el contexto y llama a OpenAI con la Responses API.
3. Backend devuelve resumen diario, reporte semanal o respuestas del asistente segun la accion elegida.

Tambien existe un chat de planificacion que envia el contexto del dashboard y las ultimas preguntas del usuario al backend. Sirve para preguntas como:

- Que deberia hacer primero hoy?
- Que proyecto necesita mas atencion?
- Como reorganizo mi semana segun reuniones y energia?

El reporte semanal devuelve un resumen ejecutivo, aprendizajes de reuniones, sueno y proyectos, victorias, riesgos y acciones recomendadas para la semana siguiente.

Casos utiles:

- Resumen del dia.
- Reporte semanal ejecutivo.
- Exportacion de reportes.
- Priorizacion automatica.
- Deteccion de sobrecarga de reuniones.
- Sugerencias por proyecto.
- Analisis entre descanso y productividad.

## Siguiente etapa para producto vendible

- Autenticacion de usuarios.
- Base de datos por usuario.
- OAuth real de Google Calendar.
- Backend API para OpenAI.
- Planes, pagos y limites de uso.
- Onboarding inicial.
- Historial persistente de reportes semanales.
- Integraciones futuras con Notion, Trello, Jira, Slack o wearable de sueno.
