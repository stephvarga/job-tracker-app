import { useState, useEffect, useRef, useCallback } from 'react'
import type { Session as AuthSession } from '@supabase/supabase-js'
import { supabase } from './supabaseClient'
import Login from './Login'
import styles from './App.module.css'
import { buildCsv } from './csv'
import {
  startOfShopDay,
  startOfNextShopDay,
  startOfShopWeek,
  shopDateStamp,
  formatShopDate,
  formatTime,
  formatHoursMinutes
} from './time'

interface Job {
  id: string
  name: string
  is_general: boolean
  created_at: string
  isRunning?: boolean
  startedAt?: number | null
  totalSeconds?: number
  weeklySeconds?: number
}

interface Session {
  id?: string
  clocked_in_at?: string
  clocked_out_at?: string | null
  total_seconds?: number
}

interface TimeEntry {
  id?: string
  job_id: string
  session_id?: string
  started_at: string
  ended_at?: string | null
  duration_seconds?: number
}

function exportToCSV(jobs: Job[], sessionSeconds: number, tab: 'today' | 'week') {
  const rows = [
    ['Job Name', 'Total Time'],
    ...jobs.map(j => [
      j.name,
      formatTime(tab === 'today' ? (j.totalSeconds ?? 0) : (j.weeklySeconds ?? 0))
    ]),
    [],
    [tab === 'today' ? 'Total Session Time' : 'Total Week Time', formatTime(sessionSeconds)]
  ]
  const blob = new Blob([buildCsv(rows)], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `job-times-${tab}-${shopDateStamp()}.csv`
  a.click()
  URL.revokeObjectURL(url)
}

function buildWeeklySummary(jobs: Job[]): string {
  const formatted = formatShopDate(startOfShopWeek())

  const lines = jobs
    .filter(j => (j.weeklySeconds ?? 0) > 0)
    .map(j => `${j.name.padEnd(20)} ${formatHoursMinutes(j.weeklySeconds ?? 0)}`)

  const total = jobs.reduce((sum, j) => sum + (j.weeklySeconds ?? 0), 0)

  return [
    `⚙️ Time Tracker: Week of ${formatted}`,
    '',
    ...lines,
    '',
    `Total: ${formatHoursMinutes(total)}`
  ].join('\n')
}

function shareViaEmail(jobs: Job[]) {
  const subject = encodeURIComponent('Weekly Hours')
  const body = encodeURIComponent(buildWeeklySummary(jobs))
  window.open(`mailto:?subject=${subject}&body=${body}`)
}

function shareViaText(jobs: Job[]) {
  const body = encodeURIComponent(buildWeeklySummary(jobs))
  window.open(`sms:?&body=${body}`)
}

/** Job names are free text; anything past this is a mistake or an attack. */
const MAX_JOB_NAME = 120

function secondsBetween(from: string, to: string | number): number {
  const end = typeof to === 'number' ? to : new Date(to).getTime()
  return Math.max(0, Math.floor((end - new Date(from).getTime()) / 1000))
}

export default function App() {
  const [authSession, setAuthSession] = useState<AuthSession | null>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [jobs, setJobs] = useState<Job[]>([])
  const [session, setSession] = useState<Session | null>(null)
  const [activeEntry, setActiveEntry] = useState<TimeEntry | null>(null)
  const [newJobName, setNewJobName] = useState('')
  const [loading, setLoading] = useState(true)
  const [tab, setTab] = useState<'today' | 'week'>('today')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Clock state lives in state, not refs, so render stays pure and the
  // displayed timer is derived from a value React knows about.
  const [nowMs, setNowMs] = useState(() => Date.now())
  const [sessionBaseSeconds, setSessionBaseSeconds] = useState(0)
  const [sessionStartMs, setSessionStartMs] = useState<number | null>(null)

  // Guards against a double-tap firing two writes for the same action.
  const inFlightRef = useRef(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setAuthSession(data.session)
      setAuthLoading(false)
    })

    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => {
      setAuthSession(next)
    })

    return () => listener.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), 1000)
    return () => clearInterval(id)
  }, [])

  /**
   * Close out time entries that were left open by a crash, a locked phone or a
   * dropped connection. If the parent session was clocked out we know exactly
   * when work stopped, so that time is recoverable. If it wasn't, we can't
   * invent an end time: we surface it instead of silently dropping the hours,
   * which is what the old code did.
   */
  const recoverOrphanedEntries = useCallback(async (currentSessionId: string | null) => {
    const { data: openEntries, error: openErr } = await supabase
      .from('time_entries')
      .select('*')
      .is('ended_at', null)

    if (openErr) throw openErr
    if (!openEntries?.length) return 0

    const orphans = (openEntries as TimeEntry[]).filter(e => e.session_id !== currentSessionId)
    if (!orphans.length) return 0

    // An entry with no session_id has no clock-out to recover from. It can't be
    // fixed, so it's counted as stranded rather than quietly skipped.
    const sessionIds = [...new Set(orphans.map(e => e.session_id).filter(Boolean))] as string[]
    if (!sessionIds.length) return orphans.length
    const { data: parents, error: parentErr } = await supabase
      .from('sessions')
      .select('id, clocked_out_at')
      .in('id', sessionIds)

    if (parentErr) throw parentErr

    const closedAt = new Map<string, string>()
    for (const s of parents ?? []) {
      if (s.clocked_out_at) closedAt.set(s.id, s.clocked_out_at)
    }

    let stranded = 0
    for (const entry of orphans) {
      const endedAt = entry.session_id ? closedAt.get(entry.session_id) : undefined
      if (!endedAt) {
        stranded++
        continue
      }
      const { error: fixErr } = await supabase
        .from('time_entries')
        .update({
          ended_at: endedAt,
          duration_seconds: secondsBetween(entry.started_at, endedAt)
        })
        .eq('id', entry.id!)
      if (fixErr) throw fixErr
    }

    return stranded
  }, [])

  /**
   * `silent` refreshes in the background without blanking the screen: used
   * when the tab regains focus, where a full-page spinner would be jarring.
   */
  const loadData = useCallback(async ({ silent = false } = {}) => {
    if (!silent) setLoading(true)
    setError(null)
    setNotice(null)

    try {
      // Open session first: recovery needs to know which entry is legitimately
      // still running.
      const { data: sessionResults, error: sessionErr } = await supabase
        .from('sessions')
        .select('*')
        .is('clocked_out_at', null)
        .order('clocked_in_at', { ascending: false })
        .limit(1)

      if (sessionErr) throw sessionErr
      const sessionData: Session | null = sessionResults?.[0] ?? null

      const stranded = await recoverOrphanedEntries(sessionData?.id ?? null)

      // `.eq('archived', false)` silently excludes rows where archived IS NULL,
      // which is every job created before that column existed.
      const { data: jobsData, error: jobsErr } = await supabase
        .from('jobs')
        .select('*')
        .not('archived', 'is', true)
        .order('is_general', { ascending: false })
        .order('created_at', { ascending: true })

      if (jobsErr) throw jobsErr

      // One fetch for the week; today is a subset, partitioned client-side so
      // the two tabs can never disagree with each other. All three boundaries
      // come from a single instant: calling new Date() three times could
      // straddle midnight and produce a day that isn't inside its own week.
      const now = new Date()
      const weekStart = startOfShopWeek(now)
      const dayStart = startOfShopDay(now)
      const nextDayStart = startOfNextShopDay(now)

      const { data: weekEntries, error: entriesErr } = await supabase
        .from('time_entries')
        .select('*')
        .gte('started_at', weekStart.toISOString())

      if (entriesErr) throw entriesErr

      let openEntry: TimeEntry | null = null
      if (sessionData?.id) {
        const { data: openEntries, error: openErr } = await supabase
          .from('time_entries')
          .select('*')
          .eq('session_id', sessionData.id)
          .is('ended_at', null)
          .order('started_at', { ascending: false })
          .limit(1)

        if (openErr) throw openErr
        openEntry = openEntries?.[0] ?? null
      }

      const todayTotals: Record<string, number> = {}
      const weekTotals: Record<string, number> = {}

      for (const entry of (weekEntries ?? []) as TimeEntry[]) {
        if (!entry.duration_seconds) continue
        weekTotals[entry.job_id] = (weekTotals[entry.job_id] ?? 0) + entry.duration_seconds

        const startedMs = new Date(entry.started_at).getTime()
        if (startedMs >= dayStart.getTime() && startedMs < nextDayStart.getTime()) {
          todayTotals[entry.job_id] = (todayTotals[entry.job_id] ?? 0) + entry.duration_seconds
        }
      }

      setJobs(
        (jobsData ?? []).map((job: Job) => ({
          ...job,
          isRunning: openEntry?.job_id === job.id,
          startedAt:
            openEntry && openEntry.job_id === job.id
              ? new Date(openEntry.started_at).getTime()
              : null,
          totalSeconds: todayTotals[job.id] ?? 0,
          weeklySeconds: weekTotals[job.id] ?? 0
        }))
      )
      setActiveEntry(openEntry)
      setSession(sessionData)

      if (sessionData?.clocked_in_at) {
        setSessionStartMs(new Date(sessionData.clocked_in_at).getTime())
        setSessionBaseSeconds(sessionData.total_seconds ?? 0)
      } else {
        setSessionStartMs(null)
        setSessionBaseSeconds(0)
      }

      if (stranded > 0) {
        setNotice(
          `${stranded} unfinished ${stranded === 1 ? 'entry' : 'entries'} from a previous ` +
            `session had no clock-out, so that time isn't counted. Check your hours before invoicing.`
        )
      }
    } catch (e) {
      // Never render an empty list as if it were real. An empty shop timer and
      // a failed request look identical, and that's how hours go missing
      // without anyone noticing.
      setError(
        e instanceof Error
          ? `Couldn't load your data: ${e.message}`
          : "Couldn't load your data."
      )
    } finally {
      setLoading(false)
    }
  }, [recoverOrphanedEntries])

  const hasLoadedRef = useRef(false)

  useEffect(() => {
    if (authSession && !hasLoadedRef.current) {
      hasLoadedRef.current = true
      loadData()
    }
    if (!authSession) {
      hasLoadedRef.current = false
    }
  }, [authSession, loadData])

  // A phone that's been asleep has a stale timer and possibly a dead socket.
  // Refetch whenever the tab comes back to the foreground.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState === 'visible' && hasLoadedRef.current) {
        setNowMs(Date.now())
        loadData({ silent: true })
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [loadData])

  async function handleSignOut() {
    // scope: 'local' signs out this device only. supabase-js defaults to
    // 'global', which revokes every refresh token for the account: so one
    // person tapping Sign Out on the shop phone would kick the laptop out
    // mid-shift, stranding whatever entry was running on it.
    await supabase.auth.signOut({ scope: 'local' })
  }

  function sessionSecondsAt(at: number): number {
    if (sessionStartMs === null) return sessionBaseSeconds
    return sessionBaseSeconds + Math.max(0, Math.floor((at - sessionStartMs) / 1000))
  }

  function getLiveSeconds(job: Job): number {
    const base = tab === 'today' ? (job.totalSeconds ?? 0) : (job.weeklySeconds ?? 0)
    if (!job.isRunning || !job.startedAt) return base
    return base + Math.max(0, Math.floor((nowMs - job.startedAt) / 1000))
  }

  function getTotalDisplaySeconds(): number {
    if (tab === 'today') return sessionSecondsAt(nowMs)
    return jobs.reduce((sum, j) => sum + getLiveSeconds(j), 0)
  }

  /** Serialises writes and turns any failure into a visible message. */
  async function run(label: string, fn: () => Promise<void>) {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setBusy(true)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(
        e instanceof Error ? `${label}: ${e.message}` : `${label}. Check your connection.`
      )
      // Re-sync from the server so the UI can't drift from what was persisted.
      await loadData()
    } finally {
      inFlightRef.current = false
      setBusy(false)
    }
  }

  function handleClockIn() {
    return run('Clock in failed', async () => {
      const now = new Date().toISOString()
      const { data, error: insertErr } = await supabase
        .from('sessions')
        .insert({ clocked_in_at: now, total_seconds: 0 })
        .select()
        .single()

      if (insertErr) throw insertErr

      setSession(data)
      setSessionStartMs(new Date(data.clocked_in_at).getTime())
      setSessionBaseSeconds(0)

      const generalJob = jobs.find(j => j.is_general)
      if (!generalJob) {
        setNotice(
          "No 'General' job exists, so unallocated time won't be tracked this session."
        )
        return
      }

      const { data: entry, error: entryErr } = await supabase
        .from('time_entries')
        .insert({ job_id: generalJob.id, session_id: data.id, started_at: now })
        .select()
        .single()

      if (entryErr) throw entryErr

      setActiveEntry(entry)
      setJobs(prev =>
        prev.map(j =>
          j.id === generalJob.id
            ? { ...j, isRunning: true, startedAt: new Date(now).getTime() }
            : { ...j, isRunning: false, startedAt: null }
        )
      )
    })
  }

  function handleClockOut() {
    return run('Clock out failed', async () => {
      if (!session?.id) return
      const nowIso = new Date().toISOString()
      const nowTs = Date.now()
      const totalSeconds = sessionSecondsAt(nowTs)

      // Close the session first. If closing the running entry succeeded but the
      // session update then failed, the app would show you clocked in with no
      // running job and the entry double-counted on retry.
      const { error: sessionErr } = await supabase
        .from('sessions')
        .update({ clocked_out_at: nowIso, total_seconds: totalSeconds })
        .eq('id', session.id)

      if (sessionErr) throw sessionErr

      if (activeEntry?.id) {
        const duration = secondsBetween(activeEntry.started_at, nowTs)
        const { error: entryErr } = await supabase
          .from('time_entries')
          .update({ ended_at: nowIso, duration_seconds: duration })
          .eq('id', activeEntry.id)

        // The session is already closed, so recovery on next load will finish
        // this entry using the session's clock-out time. Nothing is lost.
        if (entryErr) throw entryErr

        setJobs(prev =>
          prev.map(j =>
            j.id === activeEntry.job_id
              ? {
                  ...j,
                  isRunning: false,
                  startedAt: null,
                  totalSeconds: (j.totalSeconds ?? 0) + duration,
                  weeklySeconds: (j.weeklySeconds ?? 0) + duration
                }
              : { ...j, isRunning: false, startedAt: null }
          )
        )
      } else {
        setJobs(prev => prev.map(j => ({ ...j, isRunning: false, startedAt: null })))
      }

      setSessionBaseSeconds(totalSeconds)
      setSessionStartMs(null)
      setSession(null)
      setActiveEntry(null)
    })
  }

  /** Closes the running entry and credits its time to the job. */
  async function stopActiveEntry(nowIso: string, nowTs: number) {
    if (!activeEntry?.id) return
    const duration = secondsBetween(activeEntry.started_at, nowTs)
    const { error: stopErr } = await supabase
      .from('time_entries')
      .update({ ended_at: nowIso, duration_seconds: duration })
      .eq('id', activeEntry.id)

    if (stopErr) throw stopErr

    const stoppedJobId = activeEntry.job_id
    setJobs(prev =>
      prev.map(j =>
        j.id === stoppedJobId
          ? {
              ...j,
              isRunning: false,
              startedAt: null,
              totalSeconds: (j.totalSeconds ?? 0) + duration,
              weeklySeconds: (j.weeklySeconds ?? 0) + duration
            }
          : { ...j, isRunning: false, startedAt: null }
      )
    )
  }

  async function startEntry(jobId: string, sessionId: string, nowIso: string) {
    const { data: entry, error: startErr } = await supabase
      .from('time_entries')
      .insert({ job_id: jobId, session_id: sessionId, started_at: nowIso })
      .select()
      .single()

    if (startErr) throw startErr

    setActiveEntry(entry)
    setJobs(prev =>
      prev.map(j =>
        j.id === jobId
          ? { ...j, isRunning: true, startedAt: new Date(nowIso).getTime() }
          : { ...j, isRunning: false, startedAt: null }
      )
    )
  }

  function handleJobClick(jobId: string) {
    if (!session?.id) return
    const clickedJob = jobs.find(j => j.id === jobId)
    if (!clickedJob || clickedJob.is_general) return

    return run('Failed to save', async () => {
      const sessionId = session.id!
      const nowIso = new Date().toISOString()
      const nowTs = Date.now()

      await stopActiveEntry(nowIso, nowTs)

      // Tapping the running job stops it and falls back to General.
      if (clickedJob.isRunning) {
        const generalJob = jobs.find(j => j.is_general)
        if (generalJob) await startEntry(generalJob.id, sessionId, nowIso)
        else setActiveEntry(null)
        return
      }

      await startEntry(jobId, sessionId, nowIso)
    })
  }

  function addJob() {
    // Bounded here as well as on the input, since the input's maxLength is a
    // UI affordance a determined user can bypass.
    const name = newJobName.trim().slice(0, MAX_JOB_NAME)
    if (!name) return

    return run('Could not add job', async () => {
      const { data, error: insertErr } = await supabase
        .from('jobs')
        .insert({ name, is_general: false })
        .select()
        .single()

      if (insertErr) throw insertErr

      setJobs(prev => [
        ...prev,
        { ...data, isRunning: false, startedAt: null, totalSeconds: 0, weeklySeconds: 0 }
      ])
      setNewJobName('')
    })
  }

  function archiveJob(id: string, name: string) {
    if (
      !window.confirm(
        `Remove "${name}"? Its tracked hours will be kept, but it will no longer show in the list.`
      )
    ) {
      return
    }

    return run(`Couldn't remove "${name}"`, async () => {
      const { error: archiveErr } = await supabase
        .from('jobs')
        .update({ archived: true })
        .eq('id', id)

      if (archiveErr) throw archiveErr
      setJobs(prev => prev.filter(j => j.id !== id))
    })
  }

  const generalJob = jobs.find(j => j.is_general)
  const specificJobs = jobs.filter(j => !j.is_general)
  const activeJob = jobs.find(j => j.isRunning)
  const isClockedIn = !!session

  const spinner = (
    <div className={styles.container}>
      <div className={styles.inner}>
        <p style={{ color: '#71717a', textAlign: 'center', paddingTop: '48px' }}>Loading...</p>
      </div>
    </div>
  )

  // Order matters. `loading` starts true and only clears once loadData runs,
  // and loadData only runs when authenticated: so checking it before the auth
  // check strands a signed-out user on the spinner forever.
  if (authLoading) return spinner
  if (!authSession) return <Login />
  if (loading && !error) return spinner

  return (
    <div className={styles.container}>
      <div className={styles.inner}>

        {/* Header */}
        <div className={styles.header}>
          <h1 className={styles.title}>🔥 Shop Timer</h1>
          <div className={styles.headerActions}>
            <button
              className={styles.exportBtn}
              onClick={() => exportToCSV(jobs, getTotalDisplaySeconds(), tab)}
            >
              Export CSV
            </button>
            <button className={styles.signOutBtn} onClick={handleSignOut}>
              Sign Out
            </button>
          </div>
        </div>

        {error && (
          <div className={styles.banner} role="alert">
            <span>{error}</span>
            <button className={styles.bannerBtn} onClick={() => loadData()}>Retry</button>
          </div>
        )}

        {notice && (
          <div className={styles.bannerWarn} role="status">
            <span>{notice}</span>
            <button className={styles.bannerBtn} onClick={() => setNotice(null)}>Dismiss</button>
          </div>
        )}

        {/* Tabs */}
        <div className={styles.tabs}>
          <button
            className={`${styles.tab} ${tab === 'today' ? styles.tabActive : ''}`}
            onClick={() => setTab('today')}
          >
            Today
          </button>
          <button
            className={`${styles.tab} ${tab === 'week' ? styles.tabActive : ''}`}
            onClick={() => setTab('week')}
          >
            This Week
          </button>
        </div>

        {/* Clock In/Out */}
        <div className={styles.sessionBox}>
          <div>
            <p className={styles.sessionLabel}>
              {tab === 'today' ? 'Session Time' : 'Week Total'}
            </p>
            <p className={styles.sessionTime}>{formatTime(getTotalDisplaySeconds())}</p>
            {activeJob && <p className={styles.activeJob}>▶ {activeJob.name}</p>}
          </div>
          {tab === 'today' && (
            <button
              className={`${styles.clockBtn} ${isClockedIn ? styles.clockOut : styles.clockIn}`}
              onClick={isClockedIn ? handleClockOut : handleClockIn}
              disabled={busy}
            >
              {isClockedIn ? 'Clock Out' : 'Clock In'}
            </button>
          )}
        </div>

        {tab === 'today' && !isClockedIn && (
          <p className={styles.hint}>Clock in to start tracking jobs</p>
        )}

        {/* General */}
        {generalJob && (
          <div
            className={`${styles.jobRow} ${generalJob.isRunning && tab === 'today' ? styles.jobRowActive : ''} ${!isClockedIn || tab === 'week' ? styles.jobRowDisabled : ''} ${styles.generalRow}`}
          >
            <div className={styles.jobLeft}>
              <div
                className={`${styles.dot} ${generalJob.isRunning && tab === 'today' ? styles.dotActive : ''}`}
              />
              <div>
                <span className={styles.jobName}>General</span>
                <span className={styles.generalHint}>, miscellaneous shop prep</span>
              </div>
            </div>
            <div className={styles.jobRight}>
              <span className={styles.jobTime}>{formatTime(getLiveSeconds(generalJob))}</span>
            </div>
          </div>
        )}

        {/* Add Job, only show on Today tab */}
        {tab === 'today' && (
          <div className={styles.addRow}>
            <input
              className={styles.input}
              type="text"
              value={newJobName}
              maxLength={MAX_JOB_NAME}
              onChange={e => setNewJobName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addJob()}
              placeholder="Job name or address..."
            />
            <button className={styles.addBtn} onClick={addJob} disabled={busy}>+ Add</button>
          </div>
        )}

        {/* Job List */}
        <div className={styles.jobList}>
          {specificJobs.length === 0 && (
            <p className={styles.empty}>
              {tab === 'today' ? 'No jobs yet, add one above' : 'No jobs tracked this week'}
            </p>
          )}
          {specificJobs.map(job => {
            const rowClass = [
              styles.jobRow,
              job.isRunning && tab === 'today' ? styles.jobRowActive : '',
              !isClockedIn || tab === 'week' ? styles.jobRowDisabled : ''
            ].join(' ')
            return (
              <div
                key={job.id}
                className={rowClass}
                onClick={() => tab === 'today' && handleJobClick(job.id)}
              >
                <div className={styles.jobLeft}>
                  <div
                    className={`${styles.dot} ${job.isRunning && tab === 'today' ? styles.dotActive : ''}`}
                  />
                  <span className={styles.jobName}>{job.name}</span>
                </div>
                <div className={styles.jobRight}>
                  <span className={styles.jobTime}>{formatTime(getLiveSeconds(job))}</span>
                  {tab === 'today' && (
                    <button
                      className={styles.deleteBtn}
                      onClick={e => {
                        e.stopPropagation()
                        archiveJob(job.id, job.name)
                      }}
                    >
                      ×
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {/* Share buttons, only on week tab */}
        {tab === 'week' && (
          <div className={styles.shareRow}>
            <button className={styles.shareBtn} onClick={() => shareViaEmail(jobs)}>
              ✉️ Send via Email
            </button>
            <button className={styles.shareBtn} onClick={() => shareViaText(jobs)}>
              💬 Send via Text
            </button>
          </div>
        )}

      </div>
    </div>
  )
}
