import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, ReactNode } from 'react'
import {
  Activity,
  Archive,
  Bot,
  CalendarCheck,
  CalendarDays,
  CheckCircle2,
  Clock3,
  Copy,
  Database,
  Download,
  Edit3,
  FileText,
  MessageSquare,
  Palette,
  Moon,
  Plus,
  RefreshCcw,
  Save,
  SendHorizontal,
  Settings2,
  Sparkles,
  Target,
  Trash2,
  Upload,
  X,
} from 'lucide-react'
import { addDays, format, isSameDay, parseISO, startOfWeek } from 'date-fns'
import { es } from 'date-fns/locale'
import './App.css'

type Meeting = {
  id: string
  title: string
  startsAt: string
  endsAt: string
  source: 'demo' | 'google'
  focus: 'decision' | 'sync' | 'deep-work' | 'personal'
}

type GoogleTask = {
  id: string
  title: string
  listId: string
  listTitle: string
  status: 'needsAction' | 'completed'
  due?: string
  notes?: string
  updated?: string
}

type Project = {
  id: string
  name: string
  area: string
  progress: number
  nextStep: string
  dueDate: string
  status: 'on-track' | 'attention' | 'blocked'
  archived?: boolean
}

type SleepLog = {
  date: string
  hours: number
  quality: number
  bedtime?: string
  wakeTime?: string
}

type ThemeId = 'light' | 'blue' | 'dark-gold' | 'calm'

type GoogleTokenResponse = {
  access_token?: string
  error?: string
  error_description?: string
}

type GoogleTokenClient = {
  callback: (response: GoogleTokenResponse) => void
  requestAccessToken: (options?: { prompt?: string }) => void
}

type GoogleCredentialResponse = {
  credential?: string
  select_by?: string
}

declare global {
  interface Window {
    google?: {
      accounts?: {
        id?: {
          initialize: (config: {
            client_id: string
            callback: (response: GoogleCredentialResponse) => void
            auto_select?: boolean
          }) => void
          renderButton: (
            parent: HTMLElement,
            options: {
              theme?: 'outline' | 'filled_blue' | 'filled_black'
              size?: 'large' | 'medium' | 'small'
              type?: 'standard' | 'icon'
              text?: 'signin_with' | 'signup_with' | 'continue_with' | 'signin'
              shape?: 'rectangular' | 'pill' | 'circle' | 'square'
              width?: number
            },
          ) => void
          disableAutoSelect: () => void
        }
        oauth2?: {
          initTokenClient: (config: {
            client_id: string
            scope: string
            callback: (response: GoogleTokenResponse) => void
          }) => GoogleTokenClient
          revoke: (token: string, done: () => void) => void
        }
      }
    }
  }
}

type DashboardPreferences = {
  metrics: boolean
  agenda: boolean
  tasks: boolean
  sleep: boolean
  projects: boolean
  ai: boolean
}

type DashboardSnapshot = {
  meetings: Meeting[]
  googleTasks: GoogleTask[]
  projects: Project[]
  sleepLogs: SleepLog[]
  theme: ThemeId
  dashboardPreferences: DashboardPreferences
}

type AuthUser = {
  id: string
  email: string
  name: string
  picture?: string
}

type AuthSession = {
  token: string
  expiresAt: string
}

type DailySummary = {
  summary: string
  priorities: string[]
  risks: string[]
  recommendations: string[]
  focusBlocks: string[]
}

type WeeklyReport = {
  title: string
  period: string
  executiveSummary: string
  meetingInsights: string[]
  sleepInsights: string[]
  projectInsights: string[]
  wins: string[]
  risks: string[]
  nextWeekActions: string[]
}

type PlannerMessage = {
  role: 'user' | 'assistant'
  content: string
}

const today = new Date()
const backupVersion = 1
const calendarScope = 'https://www.googleapis.com/auth/calendar.readonly'
const tasksScope = 'https://www.googleapis.com/auth/tasks.readonly'
const googleWorkspaceScope = `${calendarScope} ${tasksScope}`
const googleClientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined
const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? ''
const apiUserId = (import.meta.env.VITE_DEMO_USER_ID as string | undefined) ?? 'demo'
const defaultDashboardPreferences: DashboardPreferences = {
  metrics: true,
  agenda: true,
  tasks: true,
  sleep: true,
  projects: true,
  ai: true,
}

const defaultMeetings: Meeting[] = [
  {
    id: 'm-1',
    title: 'Revision de prioridades',
    startsAt: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 9, 30).toISOString(),
    endsAt: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 10, 0).toISOString(),
    source: 'demo',
    focus: 'decision',
  },
  {
    id: 'm-2',
    title: 'Bloque de trabajo profundo',
    startsAt: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 11, 0).toISOString(),
    endsAt: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 30).toISOString(),
    source: 'demo',
    focus: 'deep-work',
  },
  {
    id: 'm-3',
    title: 'Seguimiento de producto',
    startsAt: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 15, 15).toISOString(),
    endsAt: new Date(today.getFullYear(), today.getMonth(), today.getDate(), 16, 0).toISOString(),
    source: 'demo',
    focus: 'sync',
  },
]

const defaultProjects: Project[] = [
  {
    id: 'p-1',
    name: 'Dashboard personal',
    area: 'Producto',
    progress: 42,
    nextStep: 'Conectar Google Calendar',
    dueDate: format(addDays(today, 14), 'yyyy-MM-dd'),
    status: 'on-track',
  },
  {
    id: 'p-2',
    name: 'Sistema de ventas',
    area: 'Negocio',
    progress: 28,
    nextStep: 'Definir pricing beta',
    dueDate: format(addDays(today, 30), 'yyyy-MM-dd'),
    status: 'attention',
  },
  {
    id: 'p-3',
    name: 'Rutina de descanso',
    area: 'Salud',
    progress: 68,
    nextStep: 'Medir hora de acostarse',
    dueDate: format(addDays(today, 7), 'yyyy-MM-dd'),
    status: 'on-track',
  },
]

const defaultSleep: SleepLog[] = Array.from({ length: 7 }, (_, index) => {
  const date = addDays(today, index - 6)
  const hours = [6.4, 7.1, 6.8, 7.6, 7.2, 6.1, 7.4][index]
  const quality = [68, 78, 72, 86, 81, 61, 84][index]
  const bedtime = ['00:30', '23:50', '00:10', '23:20', '23:45', '01:05', '23:35'][index]
  const wakeTime = ['06:55', '07:00', '06:55', '07:00', '07:00', '07:10', '07:00'][index]
  return { date: format(date, 'yyyy-MM-dd'), hours, quality, bedtime, wakeTime }
})

const focusLabels: Record<Meeting['focus'], string> = {
  decision: 'Decision',
  sync: 'Sincronizacion',
  'deep-work': 'Foco',
  personal: 'Personal',
}

const statusLabels: Record<Project['status'], string> = {
  'on-track': 'En ritmo',
  attention: 'Atencion',
  blocked: 'Bloqueado',
}

const statusOptions: Array<{ value: Project['status']; label: string }> = [
  { value: 'on-track', label: 'En ritmo' },
  { value: 'attention', label: 'Atencion' },
  { value: 'blocked', label: 'Bloqueado' },
]

const themeOptions: Array<{
  id: ThemeId
  name: string
  description: string
  swatches: string[]
  chart: string
  secondaryChart: string
}> = [
  {
    id: 'light',
    name: 'Claro',
    description: 'Limpio y profesional',
    swatches: ['#edf2f7', '#ffffff', '#2563eb'],
    chart: '#2f7dd1',
    secondaryChart: '#6f5adc',
  },
  {
    id: 'blue',
    name: 'Azul',
    description: 'Tecnologico y concentrado',
    swatches: ['#eaf3ff', '#ffffff', '#0f5fb8'],
    chart: '#0f5fb8',
    secondaryChart: '#23a6d5',
  },
  {
    id: 'dark-gold',
    name: 'Oscuro dorado',
    description: 'Premium y nocturno',
    swatches: ['#101014', '#1a1a20', '#d9b65f'],
    chart: '#d9b65f',
    secondaryChart: '#8f7cf6',
  },
  {
    id: 'calm',
    name: 'Verde calma',
    description: 'Natural y balanceado',
    swatches: ['#eef7f2', '#ffffff', '#20855f'],
    chart: '#20855f',
    secondaryChart: '#3f7d8f',
  },
]

function useStoredState<T>(key: string, initialValue: T) {
  const [value, setValue] = useState<T>(() => {
    const stored = localStorage.getItem(key)
    if (!stored) return initialValue

    try {
      return JSON.parse(stored) as T
    } catch {
      localStorage.removeItem(key)
      return initialValue
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value))
    } catch (error) {
      console.warn(`No se pudo guardar ${key} en localStorage`, error)
    }
  }, [key, value])

  return [value, setValue] as const
}

function shortTime(value: string) {
  return format(parseISO(value), 'HH:mm')
}

function isThemeId(value: unknown): value is ThemeId {
  return typeof value === 'string' && themeOptions.some((option) => option.id === value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeDashboardPreferences(value: unknown): DashboardPreferences {
  if (!isRecord(value)) return defaultDashboardPreferences

  return {
    metrics: typeof value.metrics === 'boolean' ? value.metrics : true,
    agenda: typeof value.agenda === 'boolean' ? value.agenda : true,
    tasks: typeof value.tasks === 'boolean' ? value.tasks : true,
    sleep: typeof value.sleep === 'boolean' ? value.sleep : true,
    projects: typeof value.projects === 'boolean' ? value.projects : true,
    ai: typeof value.ai === 'boolean' ? value.ai : true,
  }
}

function reportListMarkdown(title: string, items: string[]) {
  const content = items.length ? items.map((item) => `- ${item}`).join('\n') : '- Sin datos registrados.'
  return `## ${title}\n\n${content}`
}

function weeklyReportToMarkdown(report: WeeklyReport) {
  return [
    `# ${report.title}`,
    `Periodo: ${report.period}`,
    '',
    report.executiveSummary,
    '',
    reportListMarkdown('Reuniones', report.meetingInsights),
    reportListMarkdown('Sueno', report.sleepInsights),
    reportListMarkdown('Proyectos', report.projectInsights),
    reportListMarkdown('Victorias', report.wins),
    reportListMarkdown('Riesgos', report.risks),
    reportListMarkdown('Proxima semana', report.nextWeekActions),
  ].join('\n\n')
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function reportListHtml(title: string, items: string[]) {
  const listItems = items.length ? items.map((item) => `<li>${escapeHtml(item)}</li>`).join('') : '<li>Sin datos registrados.</li>'
  return `<section><h2>${escapeHtml(title)}</h2><ul>${listItems}</ul></section>`
}

function weeklyReportToHtml(report: WeeklyReport) {
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(report.title)}</title>
  <style>
    body { color: #172033; font-family: Arial, sans-serif; line-height: 1.5; margin: 42px; }
    h1 { margin-bottom: 4px; }
    h2 { margin-top: 24px; color: #1d4d7a; font-size: 16px; }
    .period { color: #667085; margin-top: 0; }
    section { break-inside: avoid; }
  </style>
</head>
<body>
  <h1>${escapeHtml(report.title)}</h1>
  <p class="period">${escapeHtml(report.period)}</p>
  <p>${escapeHtml(report.executiveSummary)}</p>
  ${reportListHtml('Reuniones', report.meetingInsights)}
  ${reportListHtml('Sueno', report.sleepInsights)}
  ${reportListHtml('Proyectos', report.projectInsights)}
  ${reportListHtml('Victorias', report.wins)}
  ${reportListHtml('Riesgos', report.risks)}
  ${reportListHtml('Proxima semana', report.nextWeekActions)}
  <script>window.addEventListener('load', () => window.print())</script>
</body>
</html>`
}

function App() {
  const [meetings, setMeetings] = useStoredState<Meeting[]>('nexus-meetings', defaultMeetings)
  const [googleTasks, setGoogleTasks] = useStoredState<GoogleTask[]>('nexus-google-tasks', [])
  const [projects, setProjects] = useStoredState<Project[]>('nexus-projects', defaultProjects)
  const [sleepLogs, setSleepLogs] = useStoredState<SleepLog[]>('nexus-sleep', defaultSleep)
  const [theme, setTheme] = useStoredState<ThemeId>('nexus-theme', 'light')
  const [dashboardPreferences, setDashboardPreferences] = useStoredState<DashboardPreferences>(
    'nexus-dashboard-preferences',
    defaultDashboardPreferences,
  )
  const [syncMessage, setSyncMessage] = useState(() =>
    googleClientId ? 'Listo para conectar Google Calendar' : 'Configura VITE_GOOGLE_CLIENT_ID para activar Google Calendar.',
  )
  const [calendarAccessToken, setCalendarAccessToken] = useState('')
  const [isCalendarConnected, setIsCalendarConnected] = useState(false)
  const [isCalendarSyncing, setIsCalendarSyncing] = useState(false)
  const [isTasksSyncing, setIsTasksSyncing] = useState(false)
  const [storageMessage, setStorageMessage] = useState('Tus datos se guardan en este navegador')
  const [backendMessage, setBackendMessage] = useState('Comprobando backend...')
  const [isBackendOnline, setIsBackendOnline] = useState(false)
  const [isBackendBusy, setIsBackendBusy] = useState(false)
  const [dailySummary, setDailySummary] = useState<DailySummary | null>(null)
  const [weeklyReport, setWeeklyReport] = useState<WeeklyReport | null>(null)
  const [aiMessage, setAiMessage] = useState('Listo para generar un resumen diario.')
  const [weeklyReportMessage, setWeeklyReportMessage] = useState('Reporte semanal listo para generar.')
  const [isGeneratingSummary, setIsGeneratingSummary] = useState(false)
  const [isGeneratingWeeklyReport, setIsGeneratingWeeklyReport] = useState(false)
  const [plannerMessages, setPlannerMessages] = useState<PlannerMessage[]>([
    {
      role: 'assistant',
      content: 'Preguntame como ordenar tu dia, priorizar proyectos o reorganizar tu semana.',
    },
  ])
  const [plannerDraft, setPlannerDraft] = useState('')
  const [plannerMessage, setPlannerMessage] = useState('Asistente listo.')
  const [isPlannerThinking, setIsPlannerThinking] = useState(false)
  const [authUser, setAuthUser] = useStoredState<AuthUser | null>('nexus-auth-user', null)
  const [authSession, setAuthSession] = useStoredState<AuthSession | null>('nexus-auth-session', null)
  const [authMessage, setAuthMessage] = useState('Inicia sesion para guardar datos en tu cuenta.')
  const [isAuthenticating, setIsAuthenticating] = useState(false)
  const importInputRef = useRef<HTMLInputElement | null>(null)
  const googleTokenClientRef = useRef<GoogleTokenClient | null>(null)
  const googleSignInRef = useRef<HTMLDivElement | null>(null)
  const [projectDraft, setProjectDraft] = useState({
    name: '',
    area: '',
    progress: 25,
    nextStep: '',
    dueDate: format(addDays(today, 14), 'yyyy-MM-dd'),
    status: 'on-track' as Project['status'],
  })
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState<Omit<Project, 'id'>>({
    name: '',
    area: '',
    progress: 0,
    nextStep: '',
    dueDate: format(today, 'yyyy-MM-dd'),
    status: 'on-track',
    archived: false,
  })
  const [sleepDraft, setSleepDraft] = useState({
    date: format(today, 'yyyy-MM-dd'),
    hours: 7.5,
    quality: 80,
    bedtime: '23:30',
    wakeTime: '07:00',
  })
  const [editingSleepDate, setEditingSleepDate] = useState<string | null>(null)
  const [sleepEditDraft, setSleepEditDraft] = useState<SleepLog>({
    date: format(today, 'yyyy-MM-dd'),
    hours: 7.5,
    quality: 80,
    bedtime: '23:30',
    wakeTime: '07:00',
  })

  useEffect(() => {
    const normalized = normalizeDashboardPreferences(dashboardPreferences)
    if (normalized.tasks !== dashboardPreferences.tasks) {
      setDashboardPreferences(normalized)
    }
  }, [dashboardPreferences, setDashboardPreferences])

  const getAuthHeaders = useCallback((): Record<string, string> => {
    return authSession?.token ? { Authorization: `Bearer ${authSession.token}` } : {}
  }, [authSession])

  const handleGoogleCredential = useCallback(
    async (response: GoogleCredentialResponse) => {
      if (!response.credential) {
        setAuthMessage('Google no devolvio una credencial valida.')
        return
      }

      let timeoutId: number | undefined

      try {
        setIsAuthenticating(true)
        setAuthMessage('Verificando sesion con backend...')
        const controller = new AbortController()
        timeoutId = window.setTimeout(() => controller.abort(), 15000)
        const authResponse = await fetch(`${apiBaseUrl}/api/auth/google`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ credential: response.credential }),
          signal: controller.signal,
        })
        window.clearTimeout(timeoutId)
        timeoutId = undefined
        const payload = (await authResponse.json()) as { user?: AuthUser; session?: AuthSession; message?: string }
        if (!authResponse.ok || !payload.user || !payload.session) {
          throw new Error(payload.message ?? 'No se pudo iniciar sesion.')
        }
        setAuthUser(payload.user)
        setAuthSession(payload.session)
        setAuthMessage(`Sesion iniciada: ${payload.user.email}`)
        setBackendMessage('Ahora puedes guardar datos en tu cuenta.')
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') {
          setAuthMessage('Google tardo demasiado en responder. Intenta iniciar sesion otra vez.')
        } else {
          setAuthMessage(error instanceof Error ? error.message : 'No se pudo iniciar sesion.')
        }
      } finally {
        if (timeoutId !== undefined) {
          window.clearTimeout(timeoutId)
        }
        setIsAuthenticating(false)
      }
    },
    [setAuthSession, setAuthUser],
  )

  useEffect(() => {
    if (!googleClientId) {
      return
    }

    let attempts = 0
    const setupGoogleClient = window.setInterval(() => {
      attempts += 1
      const oauth = window.google?.accounts?.oauth2

      if (oauth) {
        googleTokenClientRef.current = oauth.initTokenClient({
          client_id: googleClientId,
          scope: googleWorkspaceScope,
          callback: (response) => {
            if (response.error || !response.access_token) {
              setSyncMessage(response.error_description ?? response.error ?? 'No se pudo autorizar Google Calendar.')
              setIsCalendarConnected(false)
              return
            }

            setCalendarAccessToken(response.access_token)
            setIsCalendarConnected(true)
            setSyncMessage('Google Calendar conectado. Presiona Sincronizar para importar eventos.')
          },
        })
        window.clearInterval(setupGoogleClient)
      }

      if (attempts > 30) {
        window.clearInterval(setupGoogleClient)
        setSyncMessage('No se pudo cargar Google Identity Services.')
      }
    }, 300)

    return () => window.clearInterval(setupGoogleClient)
  }, [])

  useEffect(() => {
    if (!googleClientId || !googleSignInRef.current || authUser || isAuthenticating) {
      return
    }

    let attempts = 0
    const setupGoogleSignIn = window.setInterval(() => {
      attempts += 1
      const identity = window.google?.accounts?.id

      if (identity && googleSignInRef.current) {
        googleSignInRef.current.innerHTML = ''
        identity.initialize({
          client_id: googleClientId,
          callback: (response) => {
            void handleGoogleCredential(response)
          },
          auto_select: false,
        })
        identity.renderButton(googleSignInRef.current, {
          theme: 'outline',
          size: 'large',
          type: 'standard',
          text: 'signin_with',
          shape: 'rectangular',
          width: 220,
        })
        window.clearInterval(setupGoogleSignIn)
      }

      if (attempts > 30) {
        window.clearInterval(setupGoogleSignIn)
        setAuthMessage('No se pudo cargar el boton de Google.')
      }
    }, 300)

    return () => window.clearInterval(setupGoogleSignIn)
  }, [authUser, handleGoogleCredential, isAuthenticating])

  useEffect(() => {
    if (!authSession?.token) {
      return
    }

    let cancelled = false

    async function loadCurrentUser() {
      try {
        const response = await fetch(`${apiBaseUrl}/api/auth/me`, {
          headers: { Authorization: `Bearer ${authSession?.token}` },
        })
        if (!response.ok) throw new Error('Sesion expirada.')
        const payload = (await response.json()) as { user: AuthUser }
        if (!cancelled) {
          setAuthUser(payload.user)
          setAuthMessage(`Sesion activa: ${payload.user.email}`)
        }
      } catch {
        if (!cancelled) {
          setAuthUser(null)
          setAuthSession(null)
          setAuthMessage('Sesion expirada. Inicia sesion otra vez.')
        }
      }
    }

    void loadCurrentUser()

    return () => {
      cancelled = true
    }
  }, [authSession?.token, setAuthSession, setAuthUser])

  useEffect(() => {
    let cancelled = false

    async function checkBackend() {
      try {
        const response = await fetch(`${apiBaseUrl}/api/health`)
        if (!response.ok) throw new Error('Backend sin respuesta valida')
        if (!cancelled) {
          setIsBackendOnline(true)
          setBackendMessage('Backend conectado.')
        }
      } catch {
        if (!cancelled) {
          setIsBackendOnline(false)
          setBackendMessage('Backend offline. Usa npm run dev:api para activarlo.')
        }
      }
    }

    void checkBackend()

    return () => {
      cancelled = true
    }
  }, [])

  const todaysMeetings = useMemo(
    () =>
      meetings
        .filter((meeting) => isSameDay(parseISO(meeting.startsAt), today))
        .sort((a, b) => parseISO(a.startsAt).getTime() - parseISO(b.startsAt).getTime()),
    [meetings],
  )
  const dailyGoogleTasks = useMemo(() => {
    const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0).getTime()
    const endOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 23, 59, 59).getTime()

    return googleTasks
      .filter((task) => {
        if (task.status === 'completed') return false
        if (!task.due) return true
        const dueAt = parseISO(task.due).getTime()
        return dueAt <= endOfToday
      })
      .sort((a, b) => {
        if (!a.due && !b.due) return a.title.localeCompare(b.title)
        if (!a.due) return 1
        if (!b.due) return -1
        return parseISO(a.due).getTime() - parseISO(b.due).getTime()
      })
      .slice(0, 12)
      .map((task) => {
        const dueAt = task.due ? parseISO(task.due).getTime() : null
        return {
          ...task,
          timing: dueAt === null ? 'Sin fecha' : dueAt < startOfToday ? 'Vencida' : 'Hoy',
        }
      })
  }, [googleTasks])

  const weekDays = useMemo(() => {
    const start = startOfWeek(today, { weekStartsOn: 1 })
    return Array.from({ length: 7 }, (_, index) => {
      const day = addDays(start, index)
      const dayMeetings = meetings
        .filter((meeting) => isSameDay(parseISO(meeting.startsAt), day))
        .sort((a, b) => parseISO(a.startsAt).getTime() - parseISO(b.startsAt).getTime())
      return {
        label: format(day, 'EEE', { locale: es }),
        day: format(day, 'd'),
        date: format(day, 'yyyy-MM-dd'),
        meetings: dayMeetings.length,
        events: dayMeetings,
        hours: Number(
          dayMeetings
            .reduce((total, meeting) => {
              const startAt = parseISO(meeting.startsAt).getTime()
              const endAt = parseISO(meeting.endsAt).getTime()
              return total + (endAt - startAt) / 1000 / 60 / 60
            }, 0)
            .toFixed(1),
        ),
      }
    })
  }, [meetings])

  const activeProjects = projects.filter((project) => !project.archived)
  const archivedProjects = projects.filter((project) => project.archived)
  const sortedSleepLogs = [...sleepLogs].sort((a, b) => parseISO(a.date).getTime() - parseISO(b.date).getTime())
  const recentSleepLogs = sortedSleepLogs.slice(-14)
  const projectAverage = activeProjects.length
    ? Math.round(activeProjects.reduce((total, project) => total + project.progress, 0) / activeProjects.length)
    : 0
  const sleepAverage = recentSleepLogs.length
    ? Number((recentSleepLogs.reduce((total, log) => total + log.hours, 0) / recentSleepLogs.length).toFixed(1))
    : 0
  const qualityAverage = recentSleepLogs.length
    ? Math.round(recentSleepLogs.reduce((total, log) => total + log.quality, 0) / recentSleepLogs.length)
    : 0
  const focusHours = weekDays.reduce((total, day) => total + day.hours, 0).toFixed(1)
  const completedProjects = activeProjects.filter((project) => project.progress >= 80).length
  const selectedTheme = themeOptions.find((option) => option.id === theme) ?? themeOptions[0]

  const projectChart = activeProjects.map((project) => ({
    name: project.name,
    progress: project.progress,
  }))

  const projectDistribution = [
    { name: 'En ritmo', value: activeProjects.filter((project) => project.status === 'on-track').length, color: '#22a06b' },
    { name: 'Atencion', value: activeProjects.filter((project) => project.status === 'attention').length, color: '#f59e0b' },
    { name: 'Bloqueado', value: activeProjects.filter((project) => project.status === 'blocked').length, color: '#e5484d' },
  ].filter((item) => item.value > 0)
  const showDashboardGrid =
    dashboardPreferences.agenda || dashboardPreferences.tasks || dashboardPreferences.sleep || dashboardPreferences.projects

  function updateDashboardPreference(key: keyof DashboardPreferences, value: boolean) {
    setDashboardPreferences((current) => ({ ...current, [key]: value }))
  }

  async function logout() {
    try {
      if (authSession?.token) {
        await fetch(`${apiBaseUrl}/api/auth/logout`, {
          method: 'POST',
          headers: getAuthHeaders(),
        })
      }
    } finally {
      window.google?.accounts?.id?.disableAutoSelect()
      setAuthUser(null)
      setAuthSession(null)
      setAuthMessage('Sesion cerrada. Usando usuario demo.')
    }
  }

  function getDashboardSnapshot(): DashboardSnapshot {
    return {
      meetings,
      googleTasks,
      projects,
      sleepLogs,
      theme,
      dashboardPreferences,
    }
  }

  function applyDashboardSnapshot(snapshot: DashboardSnapshot) {
    setMeetings(Array.isArray(snapshot.meetings) ? snapshot.meetings : defaultMeetings)
    setGoogleTasks(Array.isArray(snapshot.googleTasks) ? snapshot.googleTasks : [])
    setProjects(Array.isArray(snapshot.projects) ? snapshot.projects : defaultProjects)
    setSleepLogs(Array.isArray(snapshot.sleepLogs) ? snapshot.sleepLogs : defaultSleep)
    setTheme(isThemeId(snapshot.theme) ? snapshot.theme : 'light')
    setDashboardPreferences(normalizeDashboardPreferences(snapshot.dashboardPreferences))
    setEditingProjectId(null)
    setEditingSleepDate(null)
  }

  async function saveSnapshotToBackend() {
    const targetUserId = authUser?.id ?? apiUserId
    try {
      setIsBackendBusy(true)
      const response = await fetch(`${apiBaseUrl}/api/dashboard/${targetUserId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ snapshot: getDashboardSnapshot() }),
      })
      if (!response.ok) throw new Error('No se pudo guardar en el backend.')
      const payload = (await response.json()) as { updatedAt?: string }
      setIsBackendOnline(true)
      setBackendMessage(`Guardado en backend${payload.updatedAt ? `: ${format(parseISO(payload.updatedAt), 'HH:mm')}` : '.'}`)
    } catch (error) {
      setIsBackendOnline(false)
      setBackendMessage(error instanceof Error ? error.message : 'No se pudo guardar en el backend.')
    } finally {
      setIsBackendBusy(false)
    }
  }

  async function loadSnapshotFromBackend() {
    const targetUserId = authUser?.id ?? apiUserId
    try {
      setIsBackendBusy(true)
      const response = await fetch(`${apiBaseUrl}/api/dashboard/${targetUserId}`, {
        headers: getAuthHeaders(),
      })
      if (!response.ok) throw new Error('No se pudo cargar desde el backend.')
      const payload = (await response.json()) as { exists?: boolean; snapshot?: DashboardSnapshot | null }
      if (!payload.exists || !payload.snapshot) {
        setBackendMessage('No hay datos guardados en backend para este usuario.')
        setIsBackendOnline(true)
        return
      }
      applyDashboardSnapshot(payload.snapshot)
      setIsBackendOnline(true)
      setBackendMessage('Datos cargados desde backend.')
    } catch (error) {
      setIsBackendOnline(false)
      setBackendMessage(error instanceof Error ? error.message : 'No se pudo cargar desde el backend.')
    } finally {
      setIsBackendBusy(false)
    }
  }

  async function generateDailySummary() {
    try {
      setIsGeneratingSummary(true)
      setAiMessage('Generando resumen diario...')
      const response = await fetch(`${apiBaseUrl}/api/openai/daily-summary`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ snapshot: getDashboardSnapshot() }),
      })
      const payload = (await response.json()) as { ok?: boolean; message?: string; summary?: DailySummary; model?: string }
      if (!response.ok || !payload.summary) {
        throw new Error(payload.message ?? 'No se pudo generar el resumen diario.')
      }
      setDailySummary(payload.summary)
      setAiMessage(payload.model ? `Resumen generado con ${payload.model}.` : 'Resumen generado.')
    } catch (error) {
      setAiMessage(error instanceof Error ? error.message : 'No se pudo generar el resumen diario.')
    } finally {
      setIsGeneratingSummary(false)
    }
  }

  async function generateWeeklyReport() {
    try {
      setIsGeneratingWeeklyReport(true)
      setWeeklyReportMessage('Generando reporte semanal...')
      const response = await fetch(`${apiBaseUrl}/api/openai/weekly-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({ snapshot: getDashboardSnapshot() }),
      })
      const payload = (await response.json()) as { ok?: boolean; message?: string; report?: WeeklyReport; model?: string }
      if (!response.ok || !payload.report) {
        throw new Error(payload.message ?? 'No se pudo generar el reporte semanal.')
      }
      setWeeklyReport(payload.report)
      setWeeklyReportMessage(payload.model ? `Reporte generado con ${payload.model}.` : 'Reporte generado.')
    } catch (error) {
      setWeeklyReportMessage(error instanceof Error ? error.message : 'No se pudo generar el reporte semanal.')
    } finally {
      setIsGeneratingWeeklyReport(false)
    }
  }

  async function sendPlannerMessage(message = plannerDraft) {
    const trimmed = message.trim()
    if (!trimmed || isPlannerThinking) return

    const nextMessages: PlannerMessage[] = [...plannerMessages, { role: 'user', content: trimmed }]
    setPlannerMessages(nextMessages)
    setPlannerDraft('')

    try {
      setIsPlannerThinking(true)
      setPlannerMessage('Pensando plan...')
      const response = await fetch(`${apiBaseUrl}/api/openai/planner-chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
        body: JSON.stringify({
          snapshot: getDashboardSnapshot(),
          messages: nextMessages,
        }),
      })
      const payload = (await response.json()) as { ok?: boolean; message?: string; reply?: string }
      if (!response.ok || !payload.reply) {
        throw new Error(payload.message ?? 'No se pudo responder la pregunta.')
      }
      setPlannerMessages((current) => [...current, { role: 'assistant', content: payload.reply ?? '' }])
      setPlannerMessage('Respuesta generada.')
    } catch (error) {
      setPlannerMessage(error instanceof Error ? error.message : 'No se pudo responder la pregunta.')
      setPlannerMessages((current) => [
        ...current,
        {
          role: 'assistant',
          content: 'No pude responder ahora. Revisa que el backend y OPENAI_API_KEY esten configurados.',
        },
      ])
    } finally {
      setIsPlannerThinking(false)
    }
  }

  function connectGoogleCalendar() {
    if (!googleClientId) {
      setSyncMessage('Falta VITE_GOOGLE_CLIENT_ID en el archivo .env.')
      return
    }

    if (!googleTokenClientRef.current) {
      setSyncMessage('Google Identity Services aun esta cargando. Intenta de nuevo en unos segundos.')
      return
    }

    googleTokenClientRef.current.requestAccessToken({ prompt: calendarAccessToken ? '' : 'consent' })
  }

  async function fetchGoogleTasks(token: string) {
    const listsResponse = await fetch('https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=100', {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!listsResponse.ok) {
      if (listsResponse.status === 401 || listsResponse.status === 403) {
        throw new Error('Google Tasks necesita permiso. Conecta Google otra vez y habilita Google Tasks API.')
      }
      throw new Error('Google Tasks rechazo la solicitud.')
    }

    const listsPayload = (await listsResponse.json()) as {
      items?: Array<{ id: string; title?: string }>
    }

    const taskLists = listsPayload.items ?? []
    const taskGroups = await Promise.all(
      taskLists.map(async (list) => {
        const params = new URLSearchParams({
          showCompleted: 'false',
          showHidden: 'false',
          maxResults: '100',
        })
        const response = await fetch(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(list.id)}/tasks?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        })

        if (!response.ok) {
          throw new Error(`No se pudieron leer tareas de ${list.title ?? 'una lista'}.`)
        }

        const payload = (await response.json()) as {
          items?: Array<{
            id: string
            title?: string
            status?: 'needsAction' | 'completed'
            due?: string
            notes?: string
            updated?: string
          }>
        }

        return (payload.items ?? []).map((task) => ({
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

  async function syncGoogleCalendar(token = calendarAccessToken) {
    if (!token.trim()) {
      connectGoogleCalendar()
      return
    }

    try {
      setIsCalendarSyncing(true)
      setSyncMessage('Sincronizando Google Calendar y Tasks...')
      const timeMin = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0).toISOString()
      const timeMax = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 7, 23, 59).toISOString()
      const params = new URLSearchParams({
        singleEvents: 'true',
        orderBy: 'startTime',
        timeMin,
        timeMax,
      })
      const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {
        headers: { Authorization: `Bearer ${token}` },
      })

      if (!response.ok) {
        if (response.status === 401) {
          setCalendarAccessToken('')
          setIsCalendarConnected(false)
          setSyncMessage('La sesion de Google expiro. Conecta Google Calendar otra vez.')
          return
        }
        throw new Error('Google Calendar rechazo la solicitud')
      }

      const payload = (await response.json()) as {
        items?: Array<{
          id: string
          summary?: string
          start?: { dateTime?: string; date?: string }
          end?: { dateTime?: string; date?: string }
        }>
      }

      const googleMeetings: Meeting[] = (payload.items ?? [])
        .filter((event) => event.start?.dateTime && event.end?.dateTime)
        .map((event) => ({
          id: `google-${event.id}`,
          title: event.summary ?? 'Evento sin titulo',
          startsAt: event.start?.dateTime ?? '',
          endsAt: event.end?.dateTime ?? '',
          source: 'google',
          focus: 'sync',
        }))

      const importedTasks = await fetchGoogleTasks(token)

      setMeetings((current) => [...current.filter((meeting) => meeting.source !== 'google'), ...googleMeetings])
      setGoogleTasks(importedTasks)
      setSyncMessage(`${googleMeetings.length} eventos y ${importedTasks.length} tareas importadas desde Google`)
      setIsCalendarConnected(true)
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'No se pudo sincronizar Google')
    } finally {
      setIsCalendarSyncing(false)
    }
  }

  async function syncGoogleTasks(token = calendarAccessToken) {
    if (!token.trim()) {
      connectGoogleCalendar()
      return
    }

    try {
      setIsTasksSyncing(true)
      setSyncMessage('Sincronizando tareas...')
      const importedTasks = await fetchGoogleTasks(token)
      setGoogleTasks(importedTasks)
      setSyncMessage(`${importedTasks.length} tareas importadas desde Google Tasks`)
      setIsCalendarConnected(true)
    } catch (error) {
      setSyncMessage(error instanceof Error ? error.message : 'No se pudo sincronizar Google Tasks')
    } finally {
      setIsTasksSyncing(false)
    }
  }

  function disconnectGoogleCalendar() {
    if (calendarAccessToken && window.google?.accounts?.oauth2) {
      window.google.accounts.oauth2.revoke(calendarAccessToken, () => undefined)
    }
    setCalendarAccessToken('')
    setIsCalendarConnected(false)
    setMeetings((current) => current.filter((meeting) => meeting.source !== 'google'))
    setGoogleTasks([])
    setSyncMessage('Google Calendar y Tasks desconectados de esta sesion.')
  }

  function addProject() {
    if (!projectDraft.name.trim()) return
    setProjects((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        name: projectDraft.name,
        area: projectDraft.area || 'General',
        progress: projectDraft.progress,
        nextStep: projectDraft.nextStep || 'Definir proxima accion',
        dueDate: projectDraft.dueDate,
        status: projectDraft.status,
        archived: false,
      },
    ])
    setProjectDraft({
      name: '',
      area: '',
      progress: 25,
      nextStep: '',
      dueDate: format(addDays(today, 14), 'yyyy-MM-dd'),
      status: 'on-track',
    })
  }

  function startProjectEdit(project: Project) {
    setEditingProjectId(project.id)
    setEditDraft({
      name: project.name,
      area: project.area,
      progress: project.progress,
      nextStep: project.nextStep,
      dueDate: project.dueDate,
      status: project.status,
      archived: Boolean(project.archived),
    })
  }

  function cancelProjectEdit() {
    setEditingProjectId(null)
  }

  function saveProjectEdit(projectId: string) {
    if (!editDraft.name.trim()) return
    setProjects((current) =>
      current.map((project) =>
        project.id === projectId
          ? {
              ...project,
              name: editDraft.name.trim(),
              area: editDraft.area.trim() || 'General',
              progress: Math.min(100, Math.max(0, editDraft.progress)),
              nextStep: editDraft.nextStep.trim() || 'Definir proxima accion',
              dueDate: editDraft.dueDate,
              status: editDraft.status,
              archived: editDraft.archived,
            }
          : project,
      ),
    )
    setEditingProjectId(null)
  }

  function toggleProjectArchive(projectId: string) {
    setProjects((current) =>
      current.map((project) => (project.id === projectId ? { ...project, archived: !project.archived } : project)),
    )
    if (editingProjectId === projectId) {
      setEditingProjectId(null)
    }
  }

  function deleteProject(projectId: string) {
    const project = projects.find((item) => item.id === projectId)
    if (project && !window.confirm(`Eliminar "${project.name}" de forma permanente?`)) {
      return
    }
    setProjects((current) => current.filter((project) => project.id !== projectId))
    if (editingProjectId === projectId) {
      setEditingProjectId(null)
    }
  }

  function addSleepLog() {
    const entry: SleepLog = {
      date: sleepDraft.date,
      hours: Math.min(12, Math.max(0, sleepDraft.hours)),
      quality: Math.min(100, Math.max(0, sleepDraft.quality)),
      bedtime: sleepDraft.bedtime,
      wakeTime: sleepDraft.wakeTime,
    }
    setSleepLogs((current) =>
      [...current.filter((log) => log.date !== entry.date), entry].sort(
        (a, b) => parseISO(a.date).getTime() - parseISO(b.date).getTime(),
      ),
    )
  }

  function startSleepEdit(log: SleepLog) {
    setEditingSleepDate(log.date)
    setSleepEditDraft({
      date: log.date,
      hours: log.hours,
      quality: log.quality,
      bedtime: log.bedtime ?? '',
      wakeTime: log.wakeTime ?? '',
    })
  }

  function cancelSleepEdit() {
    setEditingSleepDate(null)
  }

  function saveSleepEdit(originalDate: string) {
    setSleepLogs((current) =>
      [
        ...current.filter((log) => log.date !== originalDate && log.date !== sleepEditDraft.date),
        {
          date: sleepEditDraft.date,
          hours: Math.min(12, Math.max(0, sleepEditDraft.hours)),
          quality: Math.min(100, Math.max(0, sleepEditDraft.quality)),
          bedtime: sleepEditDraft.bedtime,
          wakeTime: sleepEditDraft.wakeTime,
        },
      ].sort((a, b) => parseISO(a.date).getTime() - parseISO(b.date).getTime()),
    )
    setEditingSleepDate(null)
  }

  function deleteSleepLog(date: string) {
    if (!window.confirm(`Eliminar el registro de sueno del ${format(parseISO(date), 'dd/MM/yyyy')}?`)) {
      return
    }
    setSleepLogs((current) => current.filter((log) => log.date !== date))
    if (editingSleepDate === date) {
      setEditingSleepDate(null)
    }
  }

  function exportLocalData() {
    const backup = {
      version: backupVersion,
      exportedAt: new Date().toISOString(),
      app: 'nexus-os-dashboard',
      data: {
        meetings,
        googleTasks,
        projects,
        sleepLogs,
        theme,
        dashboardPreferences,
      },
    }
    const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `nexus-dashboard-backup-${format(new Date(), 'yyyy-MM-dd')}.json`
    link.click()
    URL.revokeObjectURL(url)
    setStorageMessage('Backup exportado. No incluye tokens de Google.')
  }

  function downloadWeeklyReport() {
    if (!weeklyReport) {
      setWeeklyReportMessage('Primero genera un reporte semanal.')
      return
    }

    const blob = new Blob([weeklyReportToMarkdown(weeklyReport)], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    const dateStamp = format(new Date(), 'yyyy-MM-dd')
    link.href = url
    link.download = `nexus-reporte-semanal-${dateStamp}.md`
    link.click()
    URL.revokeObjectURL(url)
    setWeeklyReportMessage('Reporte descargado en Markdown.')
  }

  async function copyWeeklyReport() {
    if (!weeklyReport) {
      setWeeklyReportMessage('Primero genera un reporte semanal.')
      return
    }

    const markdown = weeklyReportToMarkdown(weeklyReport)
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(markdown)
      } else {
        const input = document.createElement('textarea')
        input.value = markdown
        input.style.position = 'fixed'
        input.style.opacity = '0'
        document.body.appendChild(input)
        input.select()
        document.execCommand('copy')
        input.remove()
      }
      setWeeklyReportMessage('Reporte copiado al portapapeles.')
    } catch {
      setWeeklyReportMessage('No se pudo copiar el reporte.')
    }
  }

  function printWeeklyReport() {
    if (!weeklyReport) {
      setWeeklyReportMessage('Primero genera un reporte semanal.')
      return
    }

    const blob = new Blob([weeklyReportToHtml(weeklyReport)], { type: 'text/html;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const printWindow = window.open(url, '_blank', 'noopener,noreferrer')

    if (!printWindow) {
      URL.revokeObjectURL(url)
      setWeeklyReportMessage('El navegador bloqueo la ventana de impresion.')
      return
    }

    window.setTimeout(() => URL.revokeObjectURL(url), 30000)
    setWeeklyReportMessage('Reporte abierto para imprimir o guardar como PDF.')
  }

  function importLocalData(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    const reader = new FileReader()
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result))
        if (!isRecord(parsed) || !isRecord(parsed.data)) {
          throw new Error('Formato de backup invalido')
        }

        const importedMeetings = Array.isArray(parsed.data.meetings) ? (parsed.data.meetings as Meeting[]) : defaultMeetings
        const importedGoogleTasks = Array.isArray(parsed.data.googleTasks) ? (parsed.data.googleTasks as GoogleTask[]) : []
        const importedProjects = Array.isArray(parsed.data.projects) ? (parsed.data.projects as Project[]) : defaultProjects
        const importedSleep = Array.isArray(parsed.data.sleepLogs) ? (parsed.data.sleepLogs as SleepLog[]) : defaultSleep
        const importedTheme = isThemeId(parsed.data.theme) ? parsed.data.theme : 'light'
        const importedPreferences = normalizeDashboardPreferences(parsed.data.dashboardPreferences)

        setMeetings(importedMeetings)
        setGoogleTasks(importedGoogleTasks)
        setProjects(importedProjects)
        setSleepLogs(importedSleep)
        setTheme(importedTheme)
        setDashboardPreferences(importedPreferences)
        setEditingProjectId(null)
        setEditingSleepDate(null)
        setStorageMessage('Backup importado correctamente.')
      } catch (error) {
        setStorageMessage(error instanceof Error ? error.message : 'No se pudo importar el backup.')
      }
    }
    reader.readAsText(file)
  }

  function resetLocalData() {
    if (!window.confirm('Restablecer los datos locales del dashboard? Esta accion reemplaza proyectos, sueno, reuniones, tareas y paleta.')) {
      return
    }
    setMeetings(defaultMeetings)
    setGoogleTasks([])
    setProjects(defaultProjects)
    setSleepLogs(defaultSleep)
    setTheme('light')
    setDashboardPreferences(defaultDashboardPreferences)
    setCalendarAccessToken('')
    setIsCalendarConnected(false)
    setEditingProjectId(null)
    setEditingSleepDate(null)
    setStorageMessage('Datos restablecidos a la version inicial.')
  }

  return (
    <main className="app-shell" data-theme={selectedTheme.id}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Activity size={22} />
          </div>
          <div>
            <strong>Nexus OS</strong>
            <span>Dashboard personal</span>
          </div>
        </div>

        <nav className="nav-list" aria-label="Secciones">
          {dashboardPreferences.agenda && (
            <a href="#agenda">
              <CalendarDays size={18} /> Agenda
            </a>
          )}
          {dashboardPreferences.tasks && (
            <a href="#tareas">
              <CheckCircle2 size={18} /> Tareas
            </a>
          )}
          {dashboardPreferences.sleep && (
            <a href="#sueno">
              <Moon size={18} /> Sueno
            </a>
          )}
          {dashboardPreferences.projects && (
            <a href="#proyectos">
              <Target size={18} /> Proyectos
            </a>
          )}
          {dashboardPreferences.ai && (
            <a href="#ai">
              <Bot size={18} /> AI
            </a>
          )}
        </nav>

        <section className="account-panel">
          <div className="panel-title">
            <Bot size={17} />
            Cuenta
          </div>
          {authUser ? (
            <div className="account-card">
              {authUser.picture ? <img src={authUser.picture} alt="" /> : <div className="account-fallback">{authUser.name[0]}</div>}
              <div>
                <strong>{authUser.name}</strong>
                <span>{authUser.email}</span>
              </div>
            </div>
          ) : isAuthenticating ? (
            <div className="auth-loading">Verificando con Google...</div>
          ) : (
            <div ref={googleSignInRef} className="google-signin-slot" />
          )}
          <p>{authMessage}</p>
          {authUser && (
            <button type="button" className="subtle-button" onClick={() => void logout()}>
              Cerrar sesion
            </button>
          )}
        </section>

        <section className="theme-panel" aria-labelledby="theme-title">
          <div className="panel-title" id="theme-title">
            <Palette size={17} />
            Paleta
          </div>
          <div className="theme-options">
            {themeOptions.map((option) => (
              <button
                className={option.id === selectedTheme.id ? 'theme-option active' : 'theme-option'}
                key={option.id}
                type="button"
                onClick={() => setTheme(option.id)}
                aria-pressed={option.id === selectedTheme.id}
              >
                <span className="swatches" aria-hidden="true">
                  {option.swatches.map((color) => (
                    <i key={color} style={{ background: color }} />
                  ))}
                </span>
                <span>
                  <strong>{option.name}</strong>
                  <small>{option.description}</small>
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="settings-panel">
          <div className="panel-title">
            <Settings2 size={17} />
            Dashboard
          </div>
          <div className="preference-list">
            <label>
              <input
                type="checkbox"
                checked={dashboardPreferences.metrics}
                onChange={(event) => updateDashboardPreference('metrics', event.target.checked)}
              />
              Indicadores
            </label>
            <label>
              <input
                type="checkbox"
                checked={dashboardPreferences.agenda}
                onChange={(event) => updateDashboardPreference('agenda', event.target.checked)}
              />
              Agenda semanal
            </label>
            <label>
              <input
                type="checkbox"
                checked={dashboardPreferences.tasks}
                onChange={(event) => updateDashboardPreference('tasks', event.target.checked)}
              />
              Google Tasks
            </label>
            <label>
              <input
                type="checkbox"
                checked={dashboardPreferences.sleep}
                onChange={(event) => updateDashboardPreference('sleep', event.target.checked)}
              />
              Sueno
            </label>
            <label>
              <input
                type="checkbox"
                checked={dashboardPreferences.projects}
                onChange={(event) => updateDashboardPreference('projects', event.target.checked)}
              />
              Proyectos
            </label>
            <label>
              <input
                type="checkbox"
                checked={dashboardPreferences.ai}
                onChange={(event) => updateDashboardPreference('ai', event.target.checked)}
              />
              AI
            </label>
          </div>
          <button type="button" className="subtle-button" onClick={() => setDashboardPreferences(defaultDashboardPreferences)}>
            Restaurar vista
          </button>
        </section>

        <section className="storage-panel">
          <div className="panel-title">
            <Download size={17} />
            Datos locales
          </div>
          <div className="storage-actions">
            <button type="button" onClick={exportLocalData}>
              <Download size={16} />
              Exportar
            </button>
            <button type="button" onClick={() => importInputRef.current?.click()}>
              <Upload size={16} />
              Importar
            </button>
            <button type="button" className="secondary-danger" onClick={resetLocalData}>
              <RefreshCcw size={16} />
              Reset
            </button>
          </div>
          <input ref={importInputRef} type="file" accept="application/json" hidden onChange={importLocalData} />
          <p>{storageMessage}</p>
        </section>

        <section className="backend-panel">
          <div className="panel-title">
            <Database size={17} />
            Backend API
          </div>
          <div className={isBackendOnline ? 'connection-status connected' : 'connection-status'}>
            {isBackendOnline ? 'Online' : 'Offline'}
          </div>
          <div className="backend-actions">
            <button type="button" onClick={() => void saveSnapshotToBackend()} disabled={isBackendBusy}>
              <Save size={16} />
              Guardar
            </button>
            <button type="button" onClick={() => void loadSnapshotFromBackend()} disabled={isBackendBusy}>
              <Download size={16} />
              Cargar
            </button>
          </div>
          <p>{backendMessage}</p>
        </section>

        <section className="integration-panel">
          <div className="panel-title">
            <CalendarCheck size={17} />
            Google Calendar + Tasks
          </div>
          <div className={isCalendarConnected ? 'connection-status connected' : 'connection-status'}>
            {isCalendarConnected ? 'Conectado por OAuth' : 'No conectado'}
          </div>
          <div className="calendar-actions">
            <button type="button" onClick={connectGoogleCalendar} disabled={!googleClientId}>
              <CalendarCheck size={16} />
              Conectar
            </button>
            <button type="button" onClick={() => void syncGoogleCalendar()} disabled={isCalendarSyncing || !googleClientId}>
              <RefreshCcw size={16} />
              {isCalendarSyncing ? 'Sincronizando' : 'Sync agenda'}
            </button>
            <button type="button" onClick={() => void syncGoogleTasks()} disabled={isTasksSyncing || !googleClientId}>
              <CheckCircle2 size={16} />
              {isTasksSyncing ? 'Sincronizando' : 'Sync tareas'}
            </button>
            {isCalendarConnected && (
              <button type="button" className="secondary-danger" onClick={disconnectGoogleCalendar}>
                <X size={16} />
                Desconectar
              </button>
            )}
          </div>
          <p>{syncMessage}</p>
        </section>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">{format(today, "EEEE d 'de' MMMM", { locale: es })}</p>
            <h1>Tu dia, tus proyectos y tu energia en una sola vista.</h1>
          </div>
          <button type="button" className="primary-action" onClick={() => void generateDailySummary()} disabled={isGeneratingSummary}>
            <Sparkles size={18} />
            {isGeneratingSummary ? 'Generando' : 'Resumen AI'}
          </button>
        </header>

        {dashboardPreferences.metrics && (
          <section className="metric-grid" aria-label="Indicadores principales">
            <Metric icon={<CalendarDays />} label="Reuniones hoy" value={todaysMeetings.length.toString()} trend="+ semana visible" />
            <Metric icon={<CheckCircle2 />} label="Tareas visibles" value={dailyGoogleTasks.length.toString()} trend="hoy, vencidas o sin fecha" />
            <Metric icon={<Moon />} label="Sueno promedio" value={`${sleepAverage}h`} trend={`${qualityAverage}% calidad`} />
            <Metric icon={<Target />} label="Progreso medio" value={`${projectAverage}%`} trend={`${completedProjects} casi listos`} />
            <Metric icon={<Clock3 />} label="Horas ocupadas" value={`${focusHours}h`} trend="esta semana" />
          </section>
        )}

        {showDashboardGrid && (
          <section className="dashboard-grid">
            {dashboardPreferences.agenda && (
              <article className="surface agenda-card" id="agenda">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Hoy</p>
                <h2>Reuniones y bloques</h2>
              </div>
              <span>{todaysMeetings.length} eventos</span>
            </div>

            <div className="timeline">
              {todaysMeetings.length ? (
                todaysMeetings.map((meeting) => (
                  <div className={`timeline-item ${meeting.focus}`} key={meeting.id}>
                    <time>
                      {shortTime(meeting.startsAt)} - {shortTime(meeting.endsAt)}
                    </time>
                    <div>
                      <strong>{meeting.title}</strong>
                      <span>{focusLabels[meeting.focus]}</span>
                    </div>
                  </div>
                ))
              ) : (
                <div className="empty-state compact">
                  <strong>Dia libre de reuniones.</strong>
                  <span>Sin eventos importados para hoy.</span>
                </div>
              )}
            </div>
              </article>
            )}

            {dashboardPreferences.agenda && (
              <article className="surface week-card">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Calendario semanal</p>
                <h2>Semana visible</h2>
              </div>
              <span>{focusHours}h ocupadas</span>
            </div>
            <div className="weekly-calendar">
              {weekDays.map((day) => (
                <div className={day.date === format(today, 'yyyy-MM-dd') ? 'week-day active' : 'week-day'} key={day.date}>
                  <div className="week-day-header">
                    <span>{day.label}</span>
                    <strong>{day.day}</strong>
                  </div>
                  <div className="week-day-load">
                    <i style={{ width: `${Math.max(8, Math.min(100, day.hours * 18))}%`, background: selectedTheme.chart }} />
                  </div>
                  <div className="week-events">
                    {day.events.length ? (
                      <>
                        {day.events.slice(0, 3).map((event) => (
                          <div className={`week-event ${event.focus}`} key={event.id}>
                            <time>
                              {shortTime(event.startsAt)} - {shortTime(event.endsAt)}
                            </time>
                            <span>{event.title}</span>
                          </div>
                        ))}
                        {day.events.length > 3 && <small>+{day.events.length - 3} mas</small>}
                      </>
                    ) : (
                      <small>Libre</small>
                    )}
                  </div>
                </div>
              ))}
            </div>
              </article>
            )}

            {dashboardPreferences.tasks && (
              <article className="surface tasks-card" id="tareas">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">Google Tasks</p>
                    <h2>Tareas diarias</h2>
                  </div>
                  <span>{dailyGoogleTasks.length} visibles</span>
                </div>

                <div className="task-list">
                  {dailyGoogleTasks.length ? (
                    dailyGoogleTasks.map((task) => (
                      <div className="task-row" key={task.id}>
                        <CheckCircle2 size={18} />
                        <div>
                          <strong>{task.title}</strong>
                          <span>
                            {task.timing} - {task.listTitle}
                          </span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="empty-state">
                      <strong>No hay tareas importadas para hoy.</strong>
                      <span>Conecta Google y usa Sync tareas para traerlas.</span>
                    </div>
                  )}
                </div>
              </article>
            )}

            {dashboardPreferences.sleep && (
              <article className="surface sleep-card" id="sueno">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Recuperacion</p>
                <h2>Control del sueno</h2>
              </div>
            </div>
            <div className="chart-box">
              <div className="sleep-chart-lite">
                {recentSleepLogs.map((log) => (
                  <div className="sleep-chart-column" key={log.date}>
                    <span style={{ height: `${Math.max(12, Math.min(100, log.hours * 10))}%`, background: selectedTheme.secondaryChart }} />
                    <small>{format(parseISO(log.date), 'dd/MM')}</small>
                  </div>
                ))}
              </div>
            </div>
            <div className="sleep-entry-form">
              <label>
                Fecha
                <input
                  type="date"
                  value={sleepDraft.date}
                  onChange={(event) => setSleepDraft((draft) => ({ ...draft, date: event.target.value }))}
                />
              </label>
              <label>
                Horas
                <input
                  type="number"
                  min="0"
                  max="12"
                  step="0.1"
                  value={sleepDraft.hours}
                  onChange={(event) => setSleepDraft((draft) => ({ ...draft, hours: Number(event.target.value) }))}
                />
              </label>
              <label>
                Calidad
                <input
                  type="number"
                  min="0"
                  max="100"
                  value={sleepDraft.quality}
                  onChange={(event) => setSleepDraft((draft) => ({ ...draft, quality: Number(event.target.value) }))}
                />
              </label>
              <label>
                Dormi
                <input
                  type="time"
                  value={sleepDraft.bedtime}
                  onChange={(event) => setSleepDraft((draft) => ({ ...draft, bedtime: event.target.value }))}
                />
              </label>
              <label>
                Desperte
                <input
                  type="time"
                  value={sleepDraft.wakeTime}
                  onChange={(event) => setSleepDraft((draft) => ({ ...draft, wakeTime: event.target.value }))}
                />
              </label>
              <button type="button" onClick={addSleepLog}>
                <CheckCircle2 size={16} />
                Guardar
              </button>
            </div>
            <div className="sleep-history">
              <div className="section-heading compact">
                <div>
                  <p className="eyebrow">Historial</p>
                  <h3>Ultimos registros</h3>
                </div>
                <span>{recentSleepLogs.length} entradas</span>
              </div>
              <div className="sleep-list">
                {recentSleepLogs.length === 0 ? (
                  <div className="empty-state">No hay registros de sueno todavia.</div>
                ) : (
                  [...recentSleepLogs].reverse().map((log) => (
                    <article className="sleep-row" key={log.date}>
                      {editingSleepDate === log.date ? (
                        <>
                          <div className="sleep-edit-grid">
                            <input
                              type="date"
                              value={sleepEditDraft.date}
                              onChange={(event) => setSleepEditDraft((draft) => ({ ...draft, date: event.target.value }))}
                              aria-label="Fecha del registro de sueno"
                            />
                            <input
                              type="number"
                              min="0"
                              max="12"
                              step="0.1"
                              value={sleepEditDraft.hours}
                              onChange={(event) =>
                                setSleepEditDraft((draft) => ({ ...draft, hours: Number(event.target.value) }))
                              }
                              aria-label="Horas dormidas"
                            />
                            <input
                              type="number"
                              min="0"
                              max="100"
                              value={sleepEditDraft.quality}
                              onChange={(event) =>
                                setSleepEditDraft((draft) => ({ ...draft, quality: Number(event.target.value) }))
                              }
                              aria-label="Calidad del sueno"
                            />
                            <input
                              type="time"
                              value={sleepEditDraft.bedtime ?? ''}
                              onChange={(event) => setSleepEditDraft((draft) => ({ ...draft, bedtime: event.target.value }))}
                              aria-label="Hora de dormir"
                            />
                            <input
                              type="time"
                              value={sleepEditDraft.wakeTime ?? ''}
                              onChange={(event) => setSleepEditDraft((draft) => ({ ...draft, wakeTime: event.target.value }))}
                              aria-label="Hora de despertar"
                            />
                          </div>
                          <div className="project-actions">
                            <button type="button" onClick={() => saveSleepEdit(log.date)} aria-label="Guardar registro de sueno">
                              <Save size={16} />
                            </button>
                            <button type="button" onClick={cancelSleepEdit} aria-label="Cancelar edicion de sueno">
                              <X size={16} />
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <div>
                            <strong>{format(parseISO(log.date), 'dd/MM/yyyy')}</strong>
                            <span>
                              {log.bedtime || '--:--'} - {log.wakeTime || '--:--'}
                            </span>
                          </div>
                          <strong>{log.hours}h</strong>
                          <small>{log.quality}% calidad</small>
                          <div className="project-actions">
                            <button type="button" onClick={() => startSleepEdit(log)} aria-label={`Editar sueno ${log.date}`}>
                              <Edit3 size={16} />
                            </button>
                            <button type="button" onClick={() => deleteSleepLog(log.date)} aria-label={`Eliminar sueno ${log.date}`}>
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </>
                      )}
                    </article>
                  ))
                )}
              </div>
            </div>
              </article>
            )}

            {dashboardPreferences.projects && (
              <article className="surface project-chart">
            <div className="section-heading">
              <div>
                <p className="eyebrow">Portafolio</p>
                <h2>Distribucion de estado</h2>
              </div>
            </div>
            <div className="donut-wrap">
              <div className="status-stack">
                {projectDistribution.map((entry) => (
                  <span
                    key={entry.name}
                    style={{
                      width: `${Math.max(8, (entry.value / Math.max(1, activeProjects.length)) * 100)}%`,
                      background: entry.color,
                    }}
                  />
                ))}
              </div>
              <div className="legend">
                {projectDistribution.map((entry) => (
                  <span key={entry.name}>
                    <i style={{ background: entry.color }} />
                    {entry.name}: {entry.value}
                  </span>
                ))}
              </div>
            </div>
              </article>
            )}
          </section>
        )}

        {dashboardPreferences.projects && (
          <section className="surface projects-section" id="proyectos">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Trabajo activo</p>
              <h2>Proyectos con progreso</h2>
            </div>
            <span>{activeProjects.length} activos</span>
          </div>

          <div className="project-board">
            <div className="project-list">
              {activeProjects.length === 0 ? (
                <div className="empty-state">No hay proyectos activos. Agrega uno nuevo o restaura un proyecto archivado.</div>
              ) : (
                activeProjects.map((project) => (
                  <article className="project-row" key={project.id}>
                    {editingProjectId === project.id ? (
                      <>
                        <div className="project-edit-grid">
                          <input
                            value={editDraft.name}
                            onChange={(event) => setEditDraft((draft) => ({ ...draft, name: event.target.value }))}
                            aria-label="Nombre del proyecto"
                          />
                          <input
                            value={editDraft.area}
                            onChange={(event) => setEditDraft((draft) => ({ ...draft, area: event.target.value }))}
                            aria-label="Area del proyecto"
                          />
                          <input
                            value={editDraft.nextStep}
                            onChange={(event) => setEditDraft((draft) => ({ ...draft, nextStep: event.target.value }))}
                            aria-label="Proxima accion del proyecto"
                          />
                          <input
                            type="date"
                            value={editDraft.dueDate}
                            onChange={(event) => setEditDraft((draft) => ({ ...draft, dueDate: event.target.value }))}
                            aria-label="Fecha objetivo del proyecto"
                          />
                          <label>
                            Progreso {editDraft.progress}%
                            <input
                              type="range"
                              min="0"
                              max="100"
                              value={editDraft.progress}
                              onChange={(event) => setEditDraft((draft) => ({ ...draft, progress: Number(event.target.value) }))}
                            />
                          </label>
                          <select
                            value={editDraft.status}
                            onChange={(event) =>
                              setEditDraft((draft) => ({ ...draft, status: event.target.value as Project['status'] }))
                            }
                            aria-label="Estado del proyecto"
                          >
                            {statusOptions.map((option) => (
                              <option key={option.value} value={option.value}>
                                {option.label}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div className="project-actions">
                          <button type="button" onClick={() => saveProjectEdit(project.id)} aria-label="Guardar cambios">
                            <Save size={16} />
                          </button>
                          <button type="button" onClick={cancelProjectEdit} aria-label="Cancelar edicion">
                            <X size={16} />
                          </button>
                        </div>
                      </>
                    ) : (
                      <>
                        <div>
                          <strong>{project.name}</strong>
                          <span>{project.area} - {project.nextStep}</span>
                          <small className="due-date">Objetivo: {format(parseISO(project.dueDate), 'dd/MM/yyyy')}</small>
                        </div>
                        <div className="progress-shell" aria-label={`${project.progress}% completado`}>
                          <span style={{ width: `${project.progress}%` }} />
                        </div>
                        <small className={project.status}>{statusLabels[project.status]}</small>
                        <strong>{project.progress}%</strong>
                        <div className="project-actions">
                          <button type="button" onClick={() => startProjectEdit(project)} aria-label={`Editar ${project.name}`}>
                            <Edit3 size={16} />
                          </button>
                          <button type="button" onClick={() => toggleProjectArchive(project.id)} aria-label={`Archivar ${project.name}`}>
                            <Archive size={16} />
                          </button>
                          <button type="button" onClick={() => deleteProject(project.id)} aria-label={`Eliminar ${project.name}`}>
                            <Trash2 size={16} />
                          </button>
                        </div>
                      </>
                    )}
                  </article>
                ))
              )}
            </div>

            <div className="project-form">
              <h3>Nuevo proyecto</h3>
              <input
                value={projectDraft.name}
                onChange={(event) => setProjectDraft((draft) => ({ ...draft, name: event.target.value }))}
                placeholder="Nombre"
              />
              <input
                value={projectDraft.area}
                onChange={(event) => setProjectDraft((draft) => ({ ...draft, area: event.target.value }))}
                placeholder="Area"
              />
              <input
                value={projectDraft.nextStep}
                onChange={(event) => setProjectDraft((draft) => ({ ...draft, nextStep: event.target.value }))}
                placeholder="Proxima accion"
              />
              <input
                type="date"
                value={projectDraft.dueDate}
                onChange={(event) => setProjectDraft((draft) => ({ ...draft, dueDate: event.target.value }))}
                aria-label="Fecha objetivo"
              />
              <select
                value={projectDraft.status}
                onChange={(event) =>
                  setProjectDraft((draft) => ({ ...draft, status: event.target.value as Project['status'] }))
                }
                aria-label="Estado inicial"
              >
                {statusOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <label>
                Progreso {projectDraft.progress}%
                <input
                  type="range"
                  min="0"
                  max="100"
                  value={projectDraft.progress}
                  onChange={(event) => setProjectDraft((draft) => ({ ...draft, progress: Number(event.target.value) }))}
                />
              </label>
              <button type="button" onClick={addProject}>
                <Plus size={16} />
                Agregar
              </button>
            </div>
          </div>

          {archivedProjects.length > 0 && (
            <div className="archive-panel">
              <div className="section-heading compact">
                <div>
                  <p className="eyebrow">Archivo</p>
                  <h3>Proyectos archivados</h3>
                </div>
                <span>{archivedProjects.length} guardados</span>
              </div>
              <div className="archive-list">
                {archivedProjects.map((project) => (
                  <article className="archive-row" key={project.id}>
                    <div>
                      <strong>{project.name}</strong>
                      <span>{project.area} - {project.progress}%</span>
                    </div>
                    <div className="project-actions">
                      <button type="button" onClick={() => toggleProjectArchive(project.id)} aria-label={`Restaurar ${project.name}`}>
                        <Archive size={16} />
                      </button>
                      <button type="button" onClick={() => deleteProject(project.id)} aria-label={`Eliminar ${project.name}`}>
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          )}

          <div className="chart-box progress-chart">
            <div className="progress-chart-lite">
              {projectChart.map((project) => (
                <div className="progress-chart-row" key={project.name}>
                  <span>{project.name}</span>
                  <div>
                    <i style={{ width: `${project.progress}%`, background: selectedTheme.chart }} />
                  </div>
                  <strong>{project.progress}%</strong>
                </div>
              ))}
            </div>
          </div>
          </section>
        )}

        {dashboardPreferences.ai && (
          <section className="ai-section" id="ai">
          <div className="ai-copy">
            <p className="eyebrow">OpenAI preparado</p>
            <h2>Resumenes y reportes inteligentes.</h2>
            <p>{aiMessage}</p>
            {dailySummary && (
              <div className="summary-panel">
                <strong>{dailySummary.summary}</strong>
                <SummaryList title="Prioridades" items={dailySummary.priorities} />
                <SummaryList title="Riesgos" items={dailySummary.risks} />
                <SummaryList title="Recomendaciones" items={dailySummary.recommendations} />
                <SummaryList title="Bloques de foco" items={dailySummary.focusBlocks} />
              </div>
            )}
            {weeklyReport && (
              <div className="weekly-report-panel">
                <div className="weekly-report-heading">
                  <FileText size={20} />
                  <div>
                    <strong>{weeklyReport.title}</strong>
                    <span>{weeklyReport.period}</span>
                  </div>
                </div>
                <p>{weeklyReport.executiveSummary}</p>
                <div className="weekly-report-export-actions">
                  <button type="button" onClick={downloadWeeklyReport}>
                    <Download size={16} />
                    Descargar MD
                  </button>
                  <button type="button" onClick={() => void copyWeeklyReport()}>
                    <Copy size={16} />
                    Copiar
                  </button>
                  <button type="button" onClick={printWeeklyReport}>
                    <FileText size={16} />
                    PDF
                  </button>
                </div>
                <div className="weekly-report-grid">
                  <SummaryList title="Reuniones" items={weeklyReport.meetingInsights} />
                  <SummaryList title="Sueno" items={weeklyReport.sleepInsights} />
                  <SummaryList title="Proyectos" items={weeklyReport.projectInsights} />
                  <SummaryList title="Victorias" items={weeklyReport.wins} />
                  <SummaryList title="Riesgos" items={weeklyReport.risks} />
                  <SummaryList title="Proxima semana" items={weeklyReport.nextWeekActions} />
                </div>
              </div>
            )}
          </div>
          <div className="ai-actions">
            <button type="button" onClick={() => void generateDailySummary()} disabled={isGeneratingSummary}>
              <Sparkles size={20} />
              Generar resumen diario
            </button>
            <button type="button" onClick={() => void generateWeeklyReport()} disabled={isGeneratingWeeklyReport}>
              <FileText size={20} />
              Generar reporte semanal
            </button>
            <span className="report-status">{weeklyReportMessage}</span>
            <div className="planner-chat">
              <div className="planner-heading">
                <MessageSquare size={20} />
                <div>
                  <strong>Asistente de planificacion</strong>
                  <span>{plannerMessage}</span>
                </div>
              </div>
              <div className="quick-prompts">
                <button type="button" onClick={() => void sendPlannerMessage('Que deberia hacer primero hoy?')}>
                  Priorizar hoy
                </button>
                <button type="button" onClick={() => void sendPlannerMessage('Que proyecto necesita mas atencion?')}>
                  Revisar proyectos
                </button>
                <button type="button" onClick={() => void sendPlannerMessage('Como reorganizo mi semana segun reuniones y energia?')}>
                  Ordenar semana
                </button>
              </div>
              <div className="planner-messages">
                {plannerMessages.map((message, index) => (
                  <div className={`planner-message ${message.role}`} key={`${message.role}-${index}`}>
                    {message.content}
                  </div>
                ))}
              </div>
              <form
                className="planner-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  void sendPlannerMessage()
                }}
              >
                <input
                  value={plannerDraft}
                  onChange={(event) => setPlannerDraft(event.target.value)}
                  placeholder="Pregunta por tu plan..."
                  aria-label="Pregunta para el asistente de planificacion"
                />
                <button type="submit" disabled={isPlannerThinking || !plannerDraft.trim()} aria-label="Enviar pregunta">
                  <SendHorizontal size={17} />
                </button>
              </form>
            </div>
          </div>
          </section>
        )}
      </section>
    </main>
  )
}

function Metric({ icon, label, value, trend }: { icon: ReactNode; label: string; value: string; trend: string }) {
  return (
    <article className="metric-card">
      <div className="metric-icon">{icon}</div>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{trend}</small>
    </article>
  )
}

function SummaryList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null

  return (
    <div className="summary-list">
      <span>{title}</span>
      <ul>
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

export default App
