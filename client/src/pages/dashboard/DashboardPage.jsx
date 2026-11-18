// Dashboard page: how the help desk is doing, for staff.
//
// One period choice (24 hours / 7 / 30 / 90 days, kept in the address) scopes everything on the
// page, and each number card shows the change from the period before. Technicians see the team
// numbers and only their own row in the technicians table; admins and owners see every row and
// can change the team goals (the server decides who gets what).

import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router'
import { apiFetch } from '../../lib/api.js'
import { formatDuration } from '../../lib/sla.js'
import { isAdminOrOwner } from '../../lib/roles.js'
import { priorityLabel } from '../../lib/ticketLabels.js'
import { usePageTitle } from '../../lib/usePageTitle.js'
import { PriorityBadge } from '../../components/Badges.jsx'
import { Stars } from '../../components/Stars.jsx'
import StatusDot from '../../components/StatusDot.jsx'
import { BarList, LineChart, Meter, SplitBar } from './charts.jsx'
import './DashboardPage.css'

const PERIODS = [
  { days: 1, label: '24 hours' },
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
]
const MINUTE = 60 * 1000

/** "3 h 10 min" from minutes, or "–" when there's nothing to measure. */
const duration = (minutes) => (minutes === null ? '–' : formatDuration(minutes * MINUTE))
const percent = (n) => (n === null ? '–' : `${Math.round(n)}%`)

/** The dashboard. */
function DashboardPage({ currentUser }) {
  usePageTitle('Dashboard')
  const admin = isAdminOrOwner(currentUser.role)
  const [params, setParams] = useSearchParams()
  const days = PERIODS.some((p) => String(p.days) === params.get('days')) ? Number(params.get('days')) : 7
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    apiFetch(`/api/dashboard?days=${days}`)
      .then((d) => !cancelled && setData(d))
      .catch((err) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [days])

  if (error) return <p className="error" role="alert">{error}</p>
  if (!data) return <p className="hint">Loading the dashboard…</p>
  const loading = data.days !== days // the numbers on screen are still for the previous choice

  const { current: c, previous: p, now } = data
  const periodName = PERIODS.find((x) => x.days === days).label
  const vs = `vs previous ${periodName}`

  return (
    // Why: while a new period loads, the old one stays at lower opacity, so nothing jumps around.
    <div className={loading ? 'dashboard dashboard--loading' : 'dashboard'} aria-busy={loading}>
      <div className="dashboard__periods" role="group" aria-label="Period">
        {PERIODS.map((period) => (
          <button
            key={period.days}
            type="button"
            aria-pressed={period.days === days}
            onClick={() => setParams(period.days === 7 ? {} : { days: String(period.days) }, { replace: true })}
          >
            {period.label}
          </button>
        ))}
      </div>

      <section className="dashboard__tiles" aria-label="Key numbers">
        <Tile label="Open now" value={now.open_now} />
        <Tile label="Overdue now" value={now.overdue_now} alert={now.overdue_now > 0} />
        <Tile label="New tickets" value={c.new_tickets} change={change(c.new_tickets, p.new_tickets)} good={null} vs={vs} />
        <Tile label="Resolved" value={c.resolved} change={change(c.resolved, p.resolved)} good="up" vs={vs} />
        <Tile
          label="First reply"
          value={duration(c.first_reply.average)}
          sub={c.first_reply.median !== null ? `median ${duration(c.first_reply.median)}` : null}
          change={change(c.first_reply.average, p.first_reply.average)}
          good="down"
          vs={vs}
        />
        <Tile
          label="Time to fix"
          value={duration(c.time_to_fix.average)}
          sub={c.time_to_fix.median !== null ? `median ${duration(c.time_to_fix.median)}` : null}
          change={change(c.time_to_fix.average, p.time_to_fix.average)}
          good="down"
          vs={vs}
        />
        <Tile
          label="Self-solved by AI"
          value={percent(c.self_solved_rate)}
          sub={`of ${c.ai_answered} answered`}
          change={points(c.self_solved_rate, p.self_solved_rate)}
          good="up"
          vs={vs}
        />
        <Tile
          label="Average rating"
          value={c.average_rating === null ? '–' : c.average_rating.toFixed(1)}
          stars={c.average_rating}
          sub={`${c.reviews} ${c.reviews === 1 ? 'review' : 'reviews'}`}
          change={points(c.average_rating, p.average_rating, 1, '')}
          good="up"
          vs={vs}
        />
      </section>

      <div className="dashboard__row">
        <Goals goals={data.goals} current={c} admin={admin} onSaved={(goals) => setData((d) => ({ ...d, goals }))} />
        <section className="dashboard__card dashboard__card--wide">
          <LineChart
            title={days === 1 ? 'Tickets per hour' : 'Tickets per day'}
            rows={data.per_bucket.rows}
            series={[
              { key: 'opened', label: 'Opened' },
              { key: 'resolved', label: 'Resolved' },
            ]}
            formatX={(at) =>
              data.per_bucket.unit === 'hour'
                ? new Date(at).toLocaleTimeString([], { hour: 'numeric' })
                : new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })
            }
          />
        </section>
      </div>

      <div className="dashboard__row">
        <section className="dashboard__card">
          {data.by_category.length ? (
            <BarList title="By category" items={data.by_category.map((r) => ({ label: r.name, value: r.count }))} />
          ) : (
            <Empty title="By category" />
          )}
        </section>
        <section className="dashboard__card">
          <BarList title="By priority" items={data.by_priority.map((r) => ({ label: priorityLabel(r.priority), value: r.count }))} />
        </section>
        <section className="dashboard__card">
          <SplitBar
            title="AI help results"
            parts={[
              { label: 'Fixed by user', value: data.ai_results.fixed ?? 0 },
              { label: 'Still broken', value: data.ai_results.still_broken ?? 0 },
              { label: 'Sent to technician', value: data.ai_results.escalated ?? 0 },
              { label: 'No answer', value: data.ai_results.pending ?? 0 },
              { label: 'AI unavailable', value: data.ai_results.failed ?? 0 },
            ]}
          />
        </section>
      </div>

      <div className="dashboard__row">
        <Technicians rows={data.technicians} team={c} openNow={now.open_now} admin={admin} currentUser={currentUser} />
        <Attention items={data.attention} />
      </div>
    </div>
  )
}

/** The change between two numbers, as a percent of the old one. */
function change(now, before) {
  if (now === null || before === null || before === 0) return null
  const pct = Math.round(((now - before) / before) * 100)
  return { direction: Math.sign(pct), text: `${Math.abs(pct)}%` }
}

/** The change between two rates or averages, in points ("4 pts") or plain units ("0.2"). */
function points(now, before, places = 0, unit = ' pts') {
  if (now === null || before === null) return null
  const diff = Number((now - before).toFixed(places))
  return { direction: Math.sign(diff), text: `${Math.abs(diff).toFixed(places)}${unit}` }
}

/**
 * One number card: a label, the value, an optional small line, and the change from the period
 * before. The change is green when it's good, red when it's bad, gray when neither (more new
 * tickets isn't good or bad), and always says up or down in words, not only in color.
 * @param {'up' | 'down' | null} good which way is good
 */
function Tile({ label, value, sub = null, stars = null, change: delta = null, good = null, vs = '', alert = false }) {
  const tone =
    !delta || delta.direction === 0 || good === null
      ? 'neutral'
      : (delta.direction > 0) === (good === 'up')
        ? 'good'
        : 'bad'
  return (
    <div className={alert ? 'tile tile--alert' : 'tile'}>
      <span className="tile__label">{label}</span>
      <span className="tile__value">
        {value}
        {stars !== null && <Stars stars={Math.round(stars)} />}
      </span>
      {sub && <span className="tile__sub">{sub}</span>}
      {delta && (
        <span className={`tile__change tile__change--${tone}`}>
          {delta.direction === 0 ? 'No change' : `${delta.direction > 0 ? '▲ Up' : '▼ Down'} ${delta.text}`}
          <span className="tile__vs"> {vs}</span>
        </span>
      )}
    </div>
  )
}

/** The team goals as meters; admins and owners can change the targets. */
function Goals({ goals, current, admin, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({})
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const target = (metric) => goals.find((g) => g.metric === metric)?.target

  const rows = [
    { metric: 'self_solved_rate', label: 'Self-solved by AI', value: current.self_solved_rate, max: 100, format: (n) => `${Math.round(n)}%`, step: 1 },
    { metric: 'average_rating', label: 'Average rating', value: current.average_rating, max: 5, format: (n) => n.toFixed(1), step: 0.1 },
    { metric: 'fixed_on_time_rate', label: 'Fixed on time', value: current.fixed_on_time_rate, max: 100, format: (n) => `${Math.round(n)}%`, step: 1 },
  ]

  async function save(event) {
    event.preventDefault()
    setBusy(true)
    setError('')
    try {
      const body = { goals: Object.fromEntries(rows.map((r) => [r.metric, Number(draft[r.metric])])) }
      const data = await apiFetch('/api/dashboard/goals', { method: 'PUT', body })
      onSaved(data.goals)
      setEditing(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="dashboard__card" aria-labelledby="goals-heading">
      <div className="chart__head">
        <h2 id="goals-heading" className="chart__title">Team goals</h2>
        {admin && !editing && (
          <button
            type="button"
            className="link chart__toggle"
            onClick={() => {
              setDraft(Object.fromEntries(rows.map((r) => [r.metric, String(target(r.metric))])))
              setEditing(true)
            }}
          >
            Edit goals
          </button>
        )}
      </div>
      {editing ? (
        <form className="goals-form" onSubmit={save}>
          {rows.map((r) => (
            <label key={r.metric}>
              {r.label} {r.max === 100 ? '(%)' : '(stars)'}
              <input
                type="number"
                min={1}
                max={r.max}
                step={r.step}
                required
                value={draft[r.metric]}
                onChange={(e) => setDraft((d) => ({ ...d, [r.metric]: e.target.value }))}
              />
            </label>
          ))}
          {error && <p className="error" role="alert">{error}</p>}
          <div className="goals-form__buttons">
            <button type="button" onClick={() => setEditing(false)} disabled={busy}>Cancel</button>
            <button type="submit" className="primary" disabled={busy}>{busy ? 'Saving…' : 'Save goals'}</button>
          </div>
        </form>
      ) : (
        rows.map((r) => <Meter key={r.metric} label={r.label} value={r.value} goal={target(r.metric)} max={r.max} format={r.format} />)
      )}
    </section>
  )
}

/**
 * The technicians table. Technicians get only their own row from the server, so for them it's
 * "you vs the team"; admins and owners see everyone.
 */
function Technicians({ rows, team, openNow, admin, currentUser }) {
  return (
    <section className="dashboard__card dashboard__card--wide" aria-labelledby="tech-heading">
      <h2 id="tech-heading" className="chart__title">{admin ? 'Technicians' : 'You and the team'}</h2>
      <div className="table-wrap">
        <table className="dashboard__table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Open now</th>
              <th scope="col">Resolved</th>
              <th scope="col">Time to fix</th>
              <th scope="col">On time</th>
              <th scope="col">Rating</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} className={t.id === currentUser.id ? 'dashboard__me' : undefined}>
                <th scope="row">
                  <span className="dashboard__name">
                    <StatusDot status={t.status} />
                    {t.name}
                    {t.id === currentUser.id && <span className="hint">(you)</span>}
                  </span>
                </th>
                <td>{t.open_now}</td>
                <td>{t.resolved}</td>
                <td>{duration(t.fix_avg)}</td>
                <td>{percent(t.fixed_on_time_rate)}</td>
                <td>{t.average_rating === null ? '–' : `${t.average_rating.toFixed(1)} ★ (${t.reviews})`}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="hint">No tickets assigned to you yet.</td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Whole team</th>
              <td>{openNow}</td>
              <td>{team.resolved}</td>
              <td>{duration(team.time_to_fix.average)}</td>
              <td>{percent(team.fixed_on_time_rate)}</td>
              <td>{team.average_rating === null ? '–' : `${team.average_rating.toFixed(1)} ★ (${team.reviews})`}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  )
}

/** The tickets due soonest: overdue ones first, each linking to the ticket. */
function Attention({ items }) {
  const [openedAt] = useState(() => Date.now()) // the clock is read once, not on every redraw
  return (
    <section className="dashboard__card" aria-labelledby="attention-heading">
      <h2 id="attention-heading" className="chart__title">Needs attention</h2>
      {items.length === 0 ? (
        <p className="hint">Nothing open right now.</p>
      ) : (
        <ul className="attention">
          {items.slice(0, 8).map((t) => {
            const left = new Date(t.due_at).getTime() - openedAt
            const late = left < 0
            return (
              <li key={t.id}>
                {/* The whole card is the button: one big target, not a small underlined link. */}
                <Link to={`/tickets/${t.id}`} className={late ? 'attention__item attention__item--late' : 'attention__item'}>
                  <span className="attention__title">
                    <span className="attention__id">#{t.id}</span> {t.title}
                  </span>
                  <span className="attention__meta">
                    <PriorityBadge priority={t.priority} />
                    <span className={late ? 'attention__due attention__due--late' : 'attention__due'}>
                      {t.target === 'reply' ? 'Reply' : 'Fix'} {late ? `overdue ${formatDuration(left)}` : `due in ${formatDuration(left)}`}
                    </span>
                    <span className="attention__who">{t.assigned_to_name ?? 'Unassigned'}</span>
                  </span>
                  <span className="attention__arrow" aria-hidden="true">›</span>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

/** A chart card with nothing to show for the period. */
function Empty({ title }) {
  return (
    <>
      <div className="chart__head"><span className="chart__title">{title}</span></div>
      <p className="hint">No tickets in this period.</p>
    </>
  )
}

export default DashboardPage
