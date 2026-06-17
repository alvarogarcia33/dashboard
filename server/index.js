import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
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
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim()
const openaiModel = process.env.OPENAI_MODEL ?? 'gpt-5.5'
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
const googleWorkspaceScope = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/tasks.readonly'

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
        google_connections: {},
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

async function getStorageStatus() {
  if (!supabase) {
    return {
      database: getStorageMode(),
      storageMessage: getStorageMessage(),
    }
  }

  const { error } = await supabase.from('users').select('id', { count: 'exact', head: true }).limit(1)

  if (error) {
    return {
      database: 'supabase-error',
      storageMessage:
        error.message === 'Invalid API key'
          ? 'Supabase rechazo SUPABASE_SERVICE_ROLE_KEY. Copia la service_role key del proyecto correcto.'
          : `Supabase no respondio correctamente: ${error.message}`,
    }
  }

  return {
    database: 'supabase',
    storageMessage: 'Supabase configurado y accesible.',
  }
}

async function getSessionUserByToken(token) {
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

async function getSessionUser(request) {
  return getSessionUserByToken(getBearerToken(request))
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
    const { error } = await supabase.from('users').upsert(user, { onConflict: 'id' })
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

async function getGoogleConnection(userId) {
  if (supabase) {
    const { data, error } = await supabase.from('google_connections').select('*').eq('user_id', userId).maybeSingle()
    if (error) throw error
    return data
  }

  const store = await getDatabase().readStore()
  return store.google_connections?.[userId] ?? null
}

async function upsertGoogleConnection(userId, connection) {
  if (supabase) {
    const { error } = await supabase.from('google_connections').upsert(
      {
        user_id: userId,
        refresh_token: connection.refresh_token,
        scope: connection.scope ?? googleWorkspaceScope,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )
    if (error) throw error
    return
  }

  const store = await getDatabase().readStore()
  store.google_connections = store.google_connections ?? {}
  store.google_connections[userId] = {
    user_id: userId,
    refresh_token: connection.refresh_token,
    scope: connection.scope ?? googleWorkspaceScope,
    updated_at: new Date().toISOString(),
  }
  await getDatabase().writeStore(store)
}

async function deleteGoogleConnection(userId) {
  if (supabase) {
    const { error } = await supabase.from('google_connections').delete().eq('user_id', userId)
    if (error) throw error
    return
  }

  const store = await getDatabase().readStore()
  if (store.google_connections) delete store.google_connections[userId]
  await getDatabase().writeStore(store)
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

function getRequestBaseUrl(request) {
  const protocol = request.headers['x-forwarded-proto'] ?? request.protocol
  const host = request.headers['x-forwarded-host'] ?? request.headers.host
  return `${protocol}://${host}`
}

function getGoogleRedirectUri(request) {
  return process.env.GOOGLE_REDIRECT_URI?.trim() || `${getRequestBaseUrl(request)}/api/google/callback`
}

function signGoogleState(token) {
  const payload = Buffer.from(JSON.stringify({ token, createdAt: Date.now() })).toString('base64url')
  const signature = crypto
    .createHmac('sha256', process.env.SESSION_STATE_SECRET || supabaseServiceRoleKey || googleClientId || 'dashboard-state')
    .update(payload)
    .digest('base64url')
  return `${payload}.${signature}`
}

function verifyGoogleState(state) {
  try {
    const [payload, signature] = String(state || '').split('.')
    if (!payload || !signature) return null

    const expected = crypto
      .createHmac('sha256', process.env.SESSION_STATE_SECRET || supabaseServiceRoleKey || googleClientId || 'dashboard-state')
      .update(payload)
      .digest('base64url')
    const signatureBuffer = Buffer.from(signature)
    const expectedBuffer = Buffer.from(expected)
    if (signatureBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)) return null

    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!parsed?.token || Date.now() - Number(parsed.createdAt ?? 0) > 1000 * 60 * 10) return null
    return parsed.token
  } catch {
    return null
  }
}

async function exchangeGoogleCode(code, redirectUri) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: googleClientId,
      client_secret: googleClientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error_description ?? payload.error ?? 'No se pudo conectar Google.')
  return payload
}

async function refreshGoogleAccessToken(refreshToken) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: googleClientId,
      client_secret: googleClientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error_description ?? payload.error ?? 'No se pudo refrescar Google.')
  return payload.access_token
}

async function fetchGoogleTasksWithToken(accessToken) {
  const listsResponse = await fetch('https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=100', {
    headers: { Authorization: `Bearer ${accessToken}` },
  })

  if (!listsResponse.ok) {
    throw new Error('Google Tasks rechazo la solicitud. Revisa que Google Tasks API este habilitada.')
  }

  const listsPayload = await listsResponse.json().catch(() => ({}))
  const taskLists = Array.isArray(listsPayload.items) ? listsPayload.items : []
  const taskGroups = await Promise.all(
    taskLists.map(async (list) => {
      const params = new URLSearchParams({
        showCompleted: 'false',
        showHidden: 'false',
        maxResults: '100',
      })
      const response = await fetch(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(list.id)}/tasks?${params}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })

      if (!response.ok) return []

      const payload = await response.json().catch(() => ({}))
      return (Array.isArray(payload.items) ? payload.items : []).map((task) => ({
        id: `google-task-${list.id}-${task.id}`,
        title: task.title ?? 'Tarea sin titulo',
        listId: list.id,
        listTitle: list.title ?? 'Google Tasks',
        status: task.status ?? 'needsAction',
        due: task.due,
        notes: task.notes,
        updated: task.updated,
      }))
    }),
  )

  return taskGroups.flat()
}

async function fetchGoogleMeetingsWithToken(accessToken) {
  const now = new Date()
  const timeMin = new Date(now.getTime() - 1000 * 60 * 60 * 24 * 7).toISOString()
  const timeMax = new Date(now.getTime() + 1000 * 60 * 60 * 24 * 21).toISOString()
  const timeZone = process.env.GOOGLE_TIME_ZONE || 'America/Montevideo'
  const params = new URLSearchParams({
    maxResults: '2500',
    showDeleted: 'false',
    singleEvents: 'true',
    orderBy: 'startTime',
    timeMin,
    timeMax,
    timeZone,
  })

  const calendarListResponse = await fetch(
    'https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader&showHidden=true',
    {
      headers: { Authorization: `Bearer ${accessToken}` },
    },
  )

  if (!calendarListResponse.ok) {
    throw new Error('Google Calendar rechazo la lista de calendarios.')
  }

  const calendarListPayload = await calendarListResponse.json().catch(() => ({}))
  const visibleCalendars = (Array.isArray(calendarListPayload.items) ? calendarListPayload.items : []).filter(
    (calendar) => calendar.id && calendar.selected !== false,
  )
  const calendarsToSync = visibleCalendars.length ? visibleCalendars : [{ id: 'primary', summary: 'Principal', primary: true }]

  const calendarResults = await Promise.all(
    calendarsToSync.map(async (calendar) => {
      try {
        const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendar.id)}/events?${params}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        })

        if (!response.ok) {
          return {
            calendar,
            events: [],
            error: `No se pudo leer ${calendar.summary ?? calendar.id}`,
          }
        }

        const payload = await response.json().catch(() => ({}))
        return {
          calendar,
          events: (Array.isArray(payload.items) ? payload.items : [])
            .filter((event) => event.start?.dateTime && event.end?.dateTime)
            .map((event) => ({
              id: `google-${calendar.id}-${event.id}`,
              title: event.summary ?? 'Evento sin titulo',
              startsAt: event.start.dateTime,
              endsAt: event.end.dateTime,
              source: 'google',
              focus: 'sync',
            })),
          error: '',
        }
      } catch {
        return {
          calendar,
          events: [],
          error: `No se pudo leer ${calendar.summary ?? calendar.id}`,
        }
      }
    }),
  )

  return {
    meetings: calendarResults
      .flatMap((result) => result.events)
      .sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime()),
    calendarsSynced: calendarsToSync.length,
    failedCalendars: calendarResults.filter((result) => result.error).map((result) => result.calendar.summary ?? result.calendar.id),
  }
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

function getErrorMessage(error) {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') return error.message
  return 'No se pudo iniciar sesion.'
}

async function verifyGoogleCredential(credential) {
  const tokenInfoResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`)
  const payload = await tokenInfoResponse.json().catch(() => ({}))

  if (!tokenInfoResponse.ok) {
    throw new Error(payload.error_description ?? payload.error ?? 'Google no pudo validar la credencial.')
  }

  if (payload.aud !== googleClientId) {
    throw new Error('La credencial pertenece a otro Google Client ID.')
  }

  if (!payload.sub || !payload.email) {
    throw new Error('La credencial de Google no incluye usuario o email.')
  }

  const expiresAt = Number(payload.exp ?? 0) * 1000
  if (!expiresAt || expiresAt <= Date.now()) {
    throw new Error('La credencial de Google expiro. Intenta iniciar sesion otra vez.')
  }

  return payload
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

app.get('/api/health', async (_request, response) => {
  const storageStatus = await getStorageStatus()

  response.json({
    ok: true,
    service: 'nexus-dashboard-api',
    ...storageStatus,
    time: new Date().toISOString(),
  })
})

app.post('/api/auth/google', async (request, response) => {
  try {
    if (!googleClientId) {
      response.status(500).json({ ok: false, message: 'GOOGLE_CLIENT_ID no esta configurado en el backend.' })
      return
    }

    const credential = String(request.body?.credential ?? '')
    if (!credential) {
      response.status(400).json({ ok: false, message: 'Falta credential de Google.' })
      return
    }

    let payload
    try {
      payload = await verifyGoogleCredential(credential)
    } catch (error) {
      const message = getErrorMessage(error)
      response.status(401).json({
        ok: false,
        message: `Google rechazo la credencial: ${message}`,
      })
      return
    }

    if (!payload.sub || !payload.email) {
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
  } catch (error) {
    console.error('Google auth failed', error)
    const message = getErrorMessage(error)
    if (message === 'Invalid API key') {
      response.status(500).json({
        ok: false,
        message: 'Supabase rechazo SUPABASE_SERVICE_ROLE_KEY. Revisa la key service_role del proyecto en Vercel.',
      })
      return
    }

    response.status(500).json({
      ok: false,
      message: `Fallo autenticacion Google: ${message}`,
    })
  }
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

app.get('/api/google/status', async (request, response) => {
  try {
    const user = await getSessionUser(request)
    if (!user) {
      response.status(401).json({ ok: false, message: 'No autenticado.' })
      return
    }

    const connection = await getGoogleConnection(user.id)
    response.json({
      ok: true,
      connected: Boolean(connection?.refresh_token),
      scope: connection?.scope ?? '',
      updatedAt: connection?.updated_at ?? null,
    })
  } catch (error) {
    response.status(500).json({ ok: false, message: getErrorMessage(error) })
  }
})

app.get('/api/google/connect-url', async (request, response) => {
  try {
    const token = getBearerToken(request)
    const user = await getSessionUserByToken(token)
    if (!user) {
      response.status(401).json({ ok: false, message: 'No autenticado.' })
      return
    }

    if (!googleClientId || !googleClientSecret) {
      response.status(500).json({
        ok: false,
        message: 'Faltan GOOGLE_CLIENT_ID o GOOGLE_CLIENT_SECRET en el backend.',
      })
      return
    }

    const redirectUri = getGoogleRedirectUri(request)
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth')
    authUrl.search = new URLSearchParams({
      client_id: googleClientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: googleWorkspaceScope,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: signGoogleState(token),
    }).toString()

    response.json({ ok: true, url: authUrl.toString(), redirectUri })
  } catch (error) {
    response.status(500).json({ ok: false, message: getErrorMessage(error) })
  }
})

app.get('/api/google/callback', async (request, response) => {
  try {
    if (request.query.error) {
      response.status(400).send(`<p>Google rechazo la conexion: ${String(request.query.error)}</p>`)
      return
    }

    const code = String(request.query.code ?? '')
    const sessionToken = verifyGoogleState(request.query.state)
    const user = await getSessionUserByToken(sessionToken)
    if (!code || !user) {
      response.status(401).send('<p>No se pudo validar la sesion para conectar Google.</p>')
      return
    }

    if (!googleClientId || !googleClientSecret) {
      response.status(500).send('<p>Faltan GOOGLE_CLIENT_ID o GOOGLE_CLIENT_SECRET en el backend.</p>')
      return
    }

    const tokenPayload = await exchangeGoogleCode(code, getGoogleRedirectUri(request))
    const previousConnection = await getGoogleConnection(user.id)
    const refreshToken = tokenPayload.refresh_token ?? previousConnection?.refresh_token
    if (!refreshToken) {
      response
        .status(400)
        .send('<p>Google no devolvio refresh_token. Desconecta el acceso de la app en tu cuenta Google e intenta conectar otra vez.</p>')
      return
    }

    await upsertGoogleConnection(user.id, {
      refresh_token: refreshToken,
      scope: tokenPayload.scope ?? googleWorkspaceScope,
    })

    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.send(`<!doctype html>
<html lang="es">
<head><meta charset="utf-8" /><title>Google conectado</title></head>
<body>
  <p>Google Calendar y Tasks conectados. Volviendo al dashboard...</p>
  <script>window.location.replace('/?google=connected')</script>
</body>
</html>`)
  } catch (error) {
    response.status(500).send(`<p>No se pudo conectar Google: ${getErrorMessage(error)}</p>`)
  }
})

app.post('/api/google/sync', async (request, response) => {
  try {
    const user = await getSessionUser(request)
    if (!user) {
      response.status(401).json({ ok: false, message: 'No autenticado.' })
      return
    }

    const connection = await getGoogleConnection(user.id)
    if (!connection?.refresh_token) {
      response.status(409).json({ ok: false, connected: false, message: 'Google todavia no esta conectado.' })
      return
    }

    const accessToken = await refreshGoogleAccessToken(connection.refresh_token)
    const [calendarSync, googleTasks] = await Promise.all([
      fetchGoogleMeetingsWithToken(accessToken),
      fetchGoogleTasksWithToken(accessToken),
    ])

    response.json({
      ok: true,
      connected: true,
      meetings: calendarSync.meetings,
      googleTasks,
      calendarsSynced: calendarSync.calendarsSynced,
      failedCalendars: calendarSync.failedCalendars,
      message: `${calendarSync.meetings.length} eventos y ${googleTasks.length} tareas sincronizados automaticamente.`,
      syncedAt: new Date().toISOString(),
    })
  } catch (error) {
    response.status(500).json({ ok: false, message: getErrorMessage(error) })
  }
})

app.delete('/api/google/connection', async (request, response) => {
  try {
    const user = await getSessionUser(request)
    if (!user) {
      response.status(401).json({ ok: false, message: 'No autenticado.' })
      return
    }

    await deleteGoogleConnection(user.id)
    response.json({ ok: true })
  } catch (error) {
    response.status(500).json({ ok: false, message: getErrorMessage(error) })
  }
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
