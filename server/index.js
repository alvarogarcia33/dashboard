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
const databasePath = process.env.DATABASE_PATH ? path.resolve(process.env.DATABASE_PATH) : path.join(dataDir, 'dashboard.json')
const port = Number(process.env.API_PORT ?? 8787)
const allowedOrigin = process.env.CLIENT_ORIGIN ?? 'http://127.0.0.1:5173'
const googleClientId = process.env.GOOGLE_CLIENT_ID ?? process.env.VITE_GOOGLE_CLIENT_ID
const openaiModel = process.env.OPENAI_MODEL ?? 'gpt-5.5'
const authClient = new OAuth2Client(googleClientId)
const supabaseUrl = process.env.SUPABASE_URL?.trim()
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
const isVercel = Boolean(process.env.VERCEL)
let supabaseInitializationError = ''

function initializeSupabaseClient() {
  if (!supabaseUrl || !supabaseServiceRoleKey) return null

  try {
    return createClient(supabaseUrl, supabaseServiceRoleKey)
  } catch (error) {
    supabaseInitializationError = error instanceof Error ? error.message : 'No se pudo inicializar Supabase.'
    return null
  }
}

const supabase = initializeSupabaseClient()

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

  await mkdir(path.dirname(databasePath), { recursive: true })
  const { readFile, writeFile } = await import('node:fs/promises')

  async function readStore() {
    try {
      return JSON.parse(await readFile(databasePath, 'utf8'))
    } catch {
      return {
        dashboard_snapshots: {},
        users: {},
        users_by_google_sub: {},
        sessions: {},
      }
    }
  }

  async function writeStore(store) {
    await writeFile(databasePath, JSON.stringify(store, null, 2))
  }

  database = { readStore, writeStore }
}

function getDatabase() {
  if (isVercel && !supabase) {
    throw new Error(getStorageMessage())
  }

  if (!database) {
    throw new Error(
      isVercel ? 'Supabase no esta configurado. Define SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY.' : 'La base de datos no esta inicializada.',
    )
  }

  return database
}

function getStorageMode() {
  if (isVercel && !supabase) return 'unconfigured'
  return supabase ? 'supabase' : 'json'
}

function getStorageMessage() {
  if (supabase) return 'Supabase configurado.'
  if (supabaseInitializationError) return supabaseInitializationError
  if (isVercel) return 'Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY.'
  return 'Storage JSON local.'
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

  const store = await getDatabase().readStore()
  const session = store.sessions[token]
  if (!session || session.expires_at <= new Date().toISOString()) return null
  return store.users[session.user_id] ?? null
}

async function findUserIdByGoogleSub(googleSub) {
  if (supabase) {
    const { data, error } = await supabase.from('users').select('id').eq('google_sub', googleSub).maybeSingle()
    if (error) throw error
    return data?.id ?? null
  }

  const store = await getDatabase().readStore()
  return store.users_by_google_sub[googleSub] ?? null
}

async function upsertGoogleUser(user) {
  if (supabase) {
    const { error } = await supabase.from('users').upsert(user, { onConflict: 'google_sub' })
    if (error) throw error
    return
  }

  const store = await getDatabase().readStore()
  store.users[user.id] = user
  store.users_by_google_sub[user.google_sub] = user.id
  await getDatabase().writeStore(store)
}

async function createSession(session) {
  if (supabase) {
    const { error } = await supabase.from('sessions').insert(session)
    if (error) throw error
    return
  }

  const store = await getDatabase().readStore()
  store.sessions[session.token] = session
  await getDatabase().writeStore(store)
}

async function deleteSession(token) {
  if (!token) return

  if (supabase) {
    const { error } = await supabase.from('sessions').delete().eq('token', token)
    if (error) throw error
    return
  }

  const store = await getDatabase().readStore()
  delete store.sessions[token]
  await getDatabase().writeStore(store)
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

  const store = await getDatabase().readStore()
  return store.dashboard_snapshots[userId] ?? null
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

  const store = await getDatabase().readStore()
  store.dashboard_snapshots[userId] = {
    snapshot_json: snapshot,
    updated_at: updatedAt,
  }
  await getDatabase().writeStore(store)
}

async function deleteDashboardSnapshot(userId) {
  if (supabase) {
    const { error } = await supabase.from('dashboard_snapshots').delete().eq('user_id', userId)
    if (error) throw error
    return true
  }

  const store = await getDatabase().readStore()
  const deleted = Boolean(store.dashboard_snapshots[userId])
  delete store.dashboard_snapshots[userId]
  await getDatabase().writeStore(store)
  return deleted
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
    storageMessage: getStorageMessage(),
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
      console.log(`Local JSON database: ${databasePath}`)
    }
  })
}

if (!isVercel) {
  await startLocalServer()
}

export default app
