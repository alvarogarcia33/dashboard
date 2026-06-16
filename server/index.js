import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import { OAuth2Client } from 'google-auth-library'
import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

dotenv.config()

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const dataDir = path.join(__dirname, 'data')
const databasePath = process.env.DATABASE_PATH
  ? path.resolve(process.env.DATABASE_PATH)
  : path.join(dataDir, 'dashboard.sqlite')
const port = Number(process.env.API_PORT ?? 8787)
const allowedOrigin = process.env.CLIENT_ORIGIN ?? 'http://127.0.0.1:5173'
const googleClientId = process.env.GOOGLE_CLIENT_ID ?? process.env.VITE_GOOGLE_CLIENT_ID
const openaiModel = process.env.OPENAI_MODEL ?? 'gpt-5.5'
const authClient = new OAuth2Client(googleClientId)
const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
const supabase = supabaseUrl && supabaseServiceRoleKey ? createClient(supabaseUrl, supabaseServiceRoleKey) : null
const isVercel = Boolean(process.env.VERCEL)

const app = express()
let database

app.use(
  cors({
    origin: isVercel ? true : allowedOrigin,
  }),
)
app.use(express.json({ limit: '1mb' }))

async function initializeDatabase() {
  if (supabase) return
  if (isVercel) return

  const { DatabaseSync } = await import('node:sqlite')
  await mkdir(path.dirname(databasePath), { recursive: true })
  database = new DatabaseSync(databasePath)
  database.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_snapshots (
      user_id TEXT PRIMARY KEY,
      snapshot_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      google_sub TEXT UNIQUE NOT NULL,
      email TEXT NOT NULL,
      name TEXT,
      picture TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `)
}

function getDatabase() {
  if (!database) {
    throw new Error(
      process.env.VERCEL
        ? 'Supabase no esta configurado. Define SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.'
        : 'La base de datos no esta inicializada.',
    )
  }

  return database
}

function getStorageMode() {
  if (isVercel && !supabase) return 'unconfigured'
  return supabase ? 'supabase' : 'sqlite'
}

async function getSessionUser(request) {
  const token = getBearerToken(request)
  if (!token) return null

  if (supabase) {
    const { data, error } = await supabase
      .from('sessions')
      .select('user_id, expires_at, users(id, email, name, picture)')
      .eq('token', token)
      .gt('expires_at', new Date().toISOString())
      .maybeSingle()

    if (error || !data?.users) return null

    return {
      id: data.users.id,
      email: data.users.email,
      name: data.users.name,
      picture: data.users.picture,
    }
  }

  const record = getDatabase()
    .prepare(
      `
      SELECT users.id, users.email, users.name, users.picture
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token = ? AND sessions.expires_at > ?
    `,
    )
    .get(token, new Date().toISOString())

  return record ?? null
}

async function findUserIdByGoogleSub(googleSub) {
  if (supabase) {
    const { data, error } = await supabase.from('users').select('id').eq('google_sub', googleSub).maybeSingle()
    if (error) throw error
    return data?.id ?? null
  }

  return getDatabase().prepare('SELECT id FROM users WHERE google_sub = ?').get(googleSub)?.id ?? null
}

async function upsertGoogleUser(user) {
  if (supabase) {
    const { error } = await supabase.from('users').upsert(user, { onConflict: 'google_sub' })
    if (error) throw error
    return
  }

  getDatabase()
    .prepare(
      `
      INSERT INTO users (id, google_sub, email, name, picture, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(google_sub) DO UPDATE SET
        email = excluded.email,
        name = excluded.name,
        picture = excluded.picture,
        updated_at = excluded.updated_at;
    `,
    )
    .run(user.id, user.google_sub, user.email, user.name ?? '', user.picture ?? '', user.created_at, user.updated_at)
}

async function createSession(session) {
  if (supabase) {
    const { error } = await supabase.from('sessions').insert(session)
    if (error) throw error
    return
  }

  getDatabase()
    .prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(session.token, session.user_id, session.created_at, session.expires_at)
}

async function deleteSession(token) {
  if (!token) return

  if (supabase) {
    const { error } = await supabase.from('sessions').delete().eq('token', token)
    if (error) throw error
    return
  }

  getDatabase().prepare('DELETE FROM sessions WHERE token = ?').run(token)
}

async function getDashboardSnapshot(userId) {
  if (supabase) {
    const { data, error } = await supabase
      .from('dashboard_snapshots')
      .select('snapshot_json, updated_at')
      .eq('user_id', userId)
      .maybeSingle()

    if (error) throw error
    return data
  }

  return getDatabase().prepare('SELECT snapshot_json, updated_at FROM dashboard_snapshots WHERE user_id = ?').get(userId)
}

async function upsertDashboardSnapshot(userId, snapshot, updatedAt) {
  if (supabase) {
    const { error } = await supabase.from('dashboard_snapshots').upsert(
      {
        user_id: userId,
        snapshot_json: snapshot,
        updated_at: updatedAt,
      },
      { onConflict: 'user_id' },
    )
    if (error) throw error
    return
  }

  getDatabase()
    .prepare(`
      INSERT INTO dashboard_snapshots (user_id, snapshot_json, created_at, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        snapshot_json = excluded.snapshot_json,
        updated_at = excluded.updated_at;
    `)
    .run(userId, JSON.stringify(snapshot), updatedAt, updatedAt)
}

async function deleteDashboardSnapshot(userId) {
  if (supabase) {
    const { error } = await supabase.from('dashboard_snapshots').delete().eq('user_id', userId)
    if (error) throw error
    return true
  }

  const result = getDatabase().prepare('DELETE FROM dashboard_snapshots WHERE user_id = ?').run(userId)
  return result.changes > 0
}

function sanitizeUserId(userId) {
  return String(userId || 'demo').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'demo'
}

function createSessionToken() {
  return crypto.randomBytes(32).toString('hex')
}

function getBearerToken(request) {
  const header = request.headers.authorization
  if (!header?.startsWith('Bearer ')) return ''
  return header.slice('Bearer '.length).trim()
}

async function authorizeDashboardRequest(request, response) {
  const requestedUserId = sanitizeUserId(request.params.userId)
  const sessionUser = await getSessionUser(request)

  if (!sessionUser && requestedUserId === 'demo') {
    return { id: 'demo', email: null, name: 'Demo', picture: null }
  }

  if (!sessionUser) {
    response.status(401).json({ ok: false, message: 'No autenticado.' })
    return null
  }

  if (sessionUser.id !== requestedUserId) {
    response.status(403).json({ ok: false, message: 'No autorizado para este usuario.' })
    return null
  }

  return sessionUser
}

function normalizeSnapshot(snapshot) {
  return {
    meetings: Array.isArray(snapshot?.meetings) ? snapshot.meetings : [],
    googleTasks: Array.isArray(snapshot?.googleTasks) ? snapshot.googleTasks : [],
    projects: Array.isArray(snapshot?.projects) ? snapshot.projects : [],
    sleepLogs: Array.isArray(snapshot?.sleepLogs) ? snapshot.sleepLogs : [],
    theme: typeof snapshot?.theme === 'string' ? snapshot.theme : 'light',
    dashboardPreferences:
      snapshot?.dashboardPreferences && typeof snapshot.dashboardPreferences === 'object'
        ? snapshot.dashboardPreferences
        : {
            metrics: true,
            agenda: true,
            tasks: true,
            sleep: true,
            projects: true,
            ai: true,
          },
  }
}

function buildDailySummaryPrompt(context) {
  const snapshot = normalizeSnapshot(context?.snapshot ?? context)
  const today = new Date().toISOString().slice(0, 10)

  return {
    today,
    meetings: snapshot.meetings,
    googleTasks: snapshot.googleTasks,
    projects: snapshot.projects,
    sleepLogs: snapshot.sleepLogs,
    instructions:
      'Genera un resumen diario breve y accionable en espanol. Enfocate en prioridades, tareas, riesgos, energia, reuniones y proximas acciones. Devuelve JSON valido con las claves summary, priorities, risks, recommendations y focusBlocks.',
  }
}

function buildWeeklyReportPrompt(context) {
  const snapshot = normalizeSnapshot(context?.snapshot ?? context)
  const generatedAt = new Date()
  const start = new Date(generatedAt)
  start.setDate(generatedAt.getDate() - 6)

  return {
    generatedAt: generatedAt.toISOString(),
    period: `${start.toISOString().slice(0, 10)} al ${generatedAt.toISOString().slice(0, 10)}`,
    meetings: snapshot.meetings,
    googleTasks: snapshot.googleTasks,
    projects: snapshot.projects,
    sleepLogs: snapshot.sleepLogs,
    instructions:
      'Genera un reporte semanal ejecutivo y accionable en espanol. Cruza reuniones, tareas, sueno y proyectos para detectar avances, energia, riesgos y acciones concretas para la proxima semana. Devuelve JSON valido con las claves title, period, executiveSummary, meetingInsights, sleepInsights, projectInsights, wins, risks y nextWeekActions.',
  }
}

function parseOpenAIText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text

  const text = payload?.output
    ?.flatMap((item) => item.content ?? [])
    ?.filter((content) => content.type === 'output_text' || content.type === 'text')
    ?.map((content) => content.text)
    ?.join('\n')

  return typeof text === 'string' ? text : ''
}

function normalizePlannerMessages(messages) {
  if (!Array.isArray(messages)) return []

  return messages
    .filter((message) => message && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string')
    .slice(-12)
    .map((message) => ({
      role: message.role,
      content: message.content.slice(0, 2000),
    }))
}

app.get('/api/health', (_request, response) => {
  response.json({
    ok: true,
    service: 'nexus-dashboard-api',
    database: getStorageMode(),
    time: new Date().toISOString(),
  })
})

app.post('/api/auth/google', async (request, response) => {
  if (!googleClientId) {
    response.status(500).json({ ok: false, message: 'GOOGLE_CLIENT_ID no esta configurado en el backend.' })
    return
  }

  const credential = String(request.body?.credential ?? '')
  if (!credential) {
    response.status(400).json({ ok: false, message: 'Falta credential de Google.' })
    return
  }

  const ticket = await authClient.verifyIdToken({
    idToken: credential,
    audience: googleClientId,
  })
  const payload = ticket.getPayload()

  if (!payload?.sub || !payload.email) {
    response.status(401).json({ ok: false, message: 'Token de Google invalido.' })
    return
  }

  const now = new Date().toISOString()
  const existingUserId = await findUserIdByGoogleSub(payload.sub)
  const userId = existingUserId ?? `google_${payload.sub}`

  await upsertGoogleUser({
    id: userId,
    google_sub: payload.sub,
    email: payload.email,
    name: payload.name ?? '',
    picture: payload.picture ?? '',
    created_at: now,
    updated_at: now,
  })

  const sessionToken = createSessionToken()
  const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 14).toISOString()
  await createSession({
    token: sessionToken,
    user_id: userId,
    created_at: now,
    expires_at: expiresAt,
  })

  response.json({
    ok: true,
    session: {
      token: sessionToken,
      expiresAt,
    },
    user: {
      id: userId,
      email: payload.email,
      name: payload.name ?? payload.email,
      picture: payload.picture ?? '',
    },
  })
})

app.get('/api/auth/me', async (request, response) => {
  const user = await getSessionUser(request)

  if (!user) {
    response.status(401).json({ ok: false, message: 'No autenticado.' })
    return
  }

  response.json({ ok: true, user })
})

app.post('/api/auth/logout', async (request, response) => {
  const token = getBearerToken(request)
  await deleteSession(token)

  response.json({ ok: true })
})

app.get('/api/dashboard/:userId', async (request, response) => {
  const user = await authorizeDashboardRequest(request, response)
  if (!user) return
  const userId = user.id
  const record = await getDashboardSnapshot(userId)

  if (!record) {
    response.json({
      exists: false,
      userId,
      snapshot: null,
    })
    return
  }

  response.json({
    exists: true,
    userId,
    updatedAt: record.updated_at,
    snapshot: typeof record.snapshot_json === 'string' ? JSON.parse(record.snapshot_json) : record.snapshot_json,
  })
})

app.put('/api/dashboard/:userId', async (request, response) => {
  const user = await authorizeDashboardRequest(request, response)
  if (!user) return
  const userId = user.id
  const snapshot = normalizeSnapshot(request.body?.snapshot)
  const updatedAt = new Date().toISOString()

  await upsertDashboardSnapshot(userId, snapshot, updatedAt)

  response.json({
    ok: true,
    userId,
    updatedAt,
  })
})

app.delete('/api/dashboard/:userId', async (request, response) => {
  const user = await authorizeDashboardRequest(request, response)
  if (!user) return
  const userId = user.id
  const deleted = await deleteDashboardSnapshot(userId)

  response.json({
    ok: true,
    userId,
    deleted,
  })
})

app.post('/api/openai/daily-summary', async (request, response) => {
  if (!process.env.OPENAI_API_KEY) {
    response.status(501).json({
      ok: false,
      message: 'OPENAI_API_KEY no esta configurada en el backend.',
    })
    return
  }

  const promptPayload = buildDailySummaryPrompt(request.body)
  const openaiResponse = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: openaiModel,
      input: [
        {
          role: 'system',
          content:
            'Eres un asistente de productividad para un dashboard personal. Respondes en espanol, concreto, sin relleno y con recomendaciones accionables.',
        },
        {
          role: 'user',
          content: JSON.stringify(promptPayload),
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'daily_summary',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              summary: { type: 'string' },
              priorities: { type: 'array', items: { type: 'string' } },
              risks: { type: 'array', items: { type: 'string' } },
              recommendations: { type: 'array', items: { type: 'string' } },
              focusBlocks: { type: 'array', items: { type: 'string' } },
            },
            required: ['summary', 'priorities', 'risks', 'recommendations', 'focusBlocks'],
          },
        },
      },
    }),
  })

  const payload = await openaiResponse.json()

  if (!openaiResponse.ok) {
    response.status(openaiResponse.status).json({
      ok: false,
      message: payload?.error?.message ?? 'OpenAI rechazo la solicitud.',
    })
    return
  }

  const outputText = parseOpenAIText(payload)
  let summary

  try {
    summary = JSON.parse(outputText)
  } catch {
    summary = {
      summary: outputText || 'OpenAI no devolvio un resumen interpretable.',
      priorities: [],
      risks: [],
      recommendations: [],
      focusBlocks: [],
    }
  }

  response.json({
    ok: true,
    model: openaiModel,
    summary,
  })
})

app.post('/api/openai/weekly-report', async (request, response) => {
  if (!process.env.OPENAI_API_KEY) {
    response.status(501).json({
      ok: false,
      message: 'OPENAI_API_KEY no esta configurada en el backend.',
    })
    return
  }

  const promptPayload = buildWeeklyReportPrompt(request.body)
  const openaiResponse = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: openaiModel,
      input: [
        {
          role: 'system',
          content:
            'Eres un analista de productividad personal para un dashboard ejecutivo. Escribes en espanol, concreto, con lectura gerencial y acciones claras. No inventes datos que no esten en el contexto.',
        },
        {
          role: 'user',
          content: JSON.stringify(promptPayload),
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'weekly_report',
          strict: true,
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              title: { type: 'string' },
              period: { type: 'string' },
              executiveSummary: { type: 'string' },
              meetingInsights: { type: 'array', items: { type: 'string' } },
              sleepInsights: { type: 'array', items: { type: 'string' } },
              projectInsights: { type: 'array', items: { type: 'string' } },
              wins: { type: 'array', items: { type: 'string' } },
              risks: { type: 'array', items: { type: 'string' } },
              nextWeekActions: { type: 'array', items: { type: 'string' } },
            },
            required: [
              'title',
              'period',
              'executiveSummary',
              'meetingInsights',
              'sleepInsights',
              'projectInsights',
              'wins',
              'risks',
              'nextWeekActions',
            ],
          },
        },
      },
    }),
  })

  const payload = await openaiResponse.json()

  if (!openaiResponse.ok) {
    response.status(openaiResponse.status).json({
      ok: false,
      message: payload?.error?.message ?? 'OpenAI rechazo la solicitud.',
    })
    return
  }

  const outputText = parseOpenAIText(payload)
  let report

  try {
    report = JSON.parse(outputText)
  } catch {
    report = {
      title: 'Reporte semanal',
      period: promptPayload.period,
      executiveSummary: outputText || 'OpenAI no devolvio un reporte interpretable.',
      meetingInsights: [],
      sleepInsights: [],
      projectInsights: [],
      wins: [],
      risks: [],
      nextWeekActions: [],
    }
  }

  response.json({
    ok: true,
    model: openaiModel,
    report,
  })
})

app.post('/api/openai/planner-chat', async (request, response) => {
  if (!process.env.OPENAI_API_KEY) {
    response.status(501).json({
      ok: false,
      message: 'OPENAI_API_KEY no esta configurada en el backend.',
    })
    return
  }

  const snapshot = normalizeSnapshot(request.body?.snapshot)
  const messages = normalizePlannerMessages(request.body?.messages)

  if (!messages.some((message) => message.role === 'user')) {
    response.status(400).json({
      ok: false,
      message: 'Falta una pregunta del usuario.',
    })
    return
  }

  const context = {
    today: new Date().toISOString().slice(0, 10),
    meetings: snapshot.meetings,
    googleTasks: snapshot.googleTasks,
    projects: snapshot.projects,
    sleepLogs: snapshot.sleepLogs,
  }

  const openaiResponse = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: openaiModel,
      input: [
        {
          role: 'system',
          content:
            'Eres un asistente de planificacion personal integrado a un dashboard. Responde en espanol rioplatense neutro, con pasos concretos, breve y accionable. Usa exclusivamente el contexto enviado; si falta informacion, dilo y sugiere que dato registrar.',
        },
        {
          role: 'user',
          content: `Contexto actual del dashboard:\n${JSON.stringify(context)}`,
        },
        ...messages,
      ],
    }),
  })

  const payload = await openaiResponse.json()

  if (!openaiResponse.ok) {
    response.status(openaiResponse.status).json({
      ok: false,
      message: payload?.error?.message ?? 'OpenAI rechazo la solicitud.',
    })
    return
  }

  response.json({
    ok: true,
    model: openaiModel,
    reply: parseOpenAIText(payload) || 'No pude generar una respuesta util con el contexto actual.',
  })
})

app.use((error, _request, response, _next) => {
  console.error(error)
  response.status(500).json({
    ok: false,
    message: 'Error interno del backend.',
  })
})

async function startLocalServer() {
  await initializeDatabase()
  app.listen(port, () => {
    console.log(`Nexus Dashboard API running on http://127.0.0.1:${port}`)
    console.log(`Storage: ${getStorageMode()}`)
    if (!supabase) {
      console.log(`SQLite database: ${databasePath}`)
    }
  })
}

if (!isVercel) {
  await startLocalServer()
}

export default app
