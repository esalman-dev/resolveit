// Dashboard charts: small, hand-built charts in plain SVG and HTML (no chart library).
//
// They follow one set of rules, so every chart reads the same way: thin marks, hairline grid,
// text in text colors (the colored mark beside it carries identity), a legend whenever there's
// more than one series, a hover or keyboard tooltip, and a table view for every chart, so no
// number is only reachable by hovering.

import { useEffect, useId, useRef, useState } from 'react'

// Series colors, in a fixed order (checked for color blindness with the dataviz validator).
const SERIES = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4']

/** Rounds a top value up to a clean axis number: 7 → 8, 23 → 25, 140 → 150. */
function niceMax(value) {
  if (value <= 4) return 4
  const step = 10 ** Math.floor(Math.log10(value))
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * step >= value) return m * step
  return value
}

/**
 * A line chart of a few series over time, with a crosshair tooltip and a table view.
 *
 * @param {{ at: string }[]} rows one row per time bucket
 * @param {{ key: string, label: string }[]} series the row fields to draw, in color order
 * @param {(at: string) => string} formatX the label for a bucket ("Nov 17", "3 PM")
 */
export function LineChart({ rows, series, formatX, title }) {
  const [active, setActive] = useState(null) // the bucket under the pointer or keyboard
  const [table, setTable] = useState(false)
  const box = useRef(null)
  const [width, setWidth] = useState(640)

  // Why: the chart is drawn at the box's real width (not a fixed picture scaled down), so the
  // axis text stays the same readable size on a phone. The browser tells us when it changes.
  useEffect(() => {
    if (!box.current) return
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.round(entry.contentRect.width))))
    observer.observe(box.current)
    return () => observer.disconnect()
  }, [table])
  const titleId = useId()

  const W = width
  const H = 220
  const pad = { left: 36, right: 12, top: 12, bottom: 26 }
  const max = niceMax(Math.max(1, ...rows.flatMap((r) => series.map((s) => r[s.key]))))
  const x = (i) => pad.left + (rows.length === 1 ? 0 : (i * (W - pad.left - pad.right)) / (rows.length - 1))
  const y = (v) => pad.top + (1 - v / max) * (H - pad.top - pad.bottom)
  const ticks = [0, max / 2, max]
  const labelAt = [0, Math.floor((rows.length - 1) / 2), rows.length - 1]

  /** Snaps the pointer to the nearest bucket. */
  function track(event) {
    const rect = box.current.getBoundingClientRect()
    const viewX = ((event.clientX - rect.left) / rect.width) * W
    const i = Math.round(((viewX - pad.left) / (W - pad.left - pad.right)) * (rows.length - 1))
    setActive(Math.min(rows.length - 1, Math.max(0, i)))
  }

  /** Arrow keys move the crosshair, so the values are reachable without a mouse. */
  function onKey(event) {
    if (event.key === 'ArrowRight') setActive((i) => Math.min(rows.length - 1, (i ?? -1) + 1))
    else if (event.key === 'ArrowLeft') setActive((i) => Math.max(0, (i ?? rows.length) - 1))
    else return
    event.preventDefault()
  }

  return (
    <figure className="chart">
      <figcaption className="chart__head">
        <span id={titleId} className="chart__title">{title}</span>
        <Legend items={series.map((s, i) => ({ label: s.label, color: SERIES[i], shape: 'line' }))} />
        <button type="button" className="link chart__toggle" onClick={() => setTable((t) => !t)}>
          {table ? 'Show chart' : 'Show as table'}
        </button>
      </figcaption>

      {table ? (
        <DataTable
          caption={title}
          columns={['When', ...series.map((s) => s.label)]}
          rows={rows.map((r) => [formatX(r.at), ...series.map((s) => r[s.key])])}
        />
      ) : (
        <div className="chart__plot" ref={box}>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            role="img"
            aria-labelledby={titleId}
            tabIndex={0}
            onPointerMove={track}
            onPointerLeave={() => setActive(null)}
            onKeyDown={onKey}
            onBlur={() => setActive(null)}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line className="chart__grid" x1={pad.left} x2={W - pad.right} y1={y(t)} y2={y(t)} />
                <text className="chart__tick" x={pad.left - 6} y={y(t) + 4} textAnchor="end">{Math.round(t)}</text>
              </g>
            ))}
            {labelAt.map((i) => (
              <text key={i} className="chart__tick" x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === rows.length - 1 ? 'end' : 'middle'}>
                {formatX(rows[i].at)}
              </text>
            ))}
            {series.map((s, si) => (
              <polyline
                key={s.key}
                className="chart__line"
                stroke={SERIES[si]}
                points={rows.map((r, i) => `${x(i)},${y(r[s.key])}`).join(' ')}
              />
            ))}
            {active !== null && (
              <g>
                <line className="chart__crosshair" x1={x(active)} x2={x(active)} y1={pad.top} y2={H - pad.bottom} />
                {series.map((s, si) => (
                  <circle key={s.key} className="chart__dot" cx={x(active)} cy={y(rows[active][s.key])} r={4} fill={SERIES[si]} />
                ))}
              </g>
            )}
          </svg>
          {active !== null && (
            // Values lead, labels follow; it flips to the left of the crosshair past the middle.
            <div
              className="chart__tooltip"
              style={active > rows.length / 2 ? { right: `${100 - (x(active) / W) * 100 + 2}%` } : { left: `${(x(active) / W) * 100 + 2}%` }}
              role="status"
            >
              <div className="chart__tooltip-title">{formatX(rows[active].at)}</div>
              {series.map((s, si) => (
                <div key={s.key} className="chart__tooltip-row">
                  <span className="chart__key chart__key--line" style={{ background: SERIES[si] }} aria-hidden="true" />
                  <strong>{rows[active][s.key]}</strong> {s.label.toLowerCase()}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </figure>
  )
}

/**
 * Horizontal bars, one hue, value at the tip. For comparing a few named amounts.
 * @param {{ label: string, value: number }[]} items in the order to show them
 */
export function BarList({ items, title, unit = 'tickets' }) {
  const [table, setTable] = useState(false)
  const max = Math.max(1, ...items.map((i) => i.value))
  return (
    <figure className="chart">
      <figcaption className="chart__head">
        <span className="chart__title">{title}</span>
        <button type="button" className="link chart__toggle" onClick={() => setTable((t) => !t)}>
          {table ? 'Show chart' : 'Show as table'}
        </button>
      </figcaption>
      {table ? (
        <DataTable caption={title} columns={['', unit[0].toUpperCase() + unit.slice(1)]} rows={items.map((i) => [i.label, i.value])} />
      ) : (
        <ul className="bar-list">
          {items.map((item) => (
            <li key={item.label} className="bar-list__row" title={`${item.label}: ${item.value} ${unit}`}>
              <span className="bar-list__label">{item.label}</span>
              <span className="bar-list__track">
                <span className="bar-list__bar" style={{ width: `${(item.value / max) * 100}%` }} />
              </span>
              <span className="bar-list__value">{item.value}</span>
            </li>
          ))}
        </ul>
      )}
    </figure>
  )
}

/**
 * One whole split into parts: a thin bar (no text on it) above a list that names each part with
 * its count and share. The list is the legend and carries the numbers.
 * @param {{ label: string, value: number }[]} parts in a fixed order (colors follow the order)
 */
export function SplitBar({ parts, title }) {
  const total = parts.reduce((sum, p) => sum + p.value, 0)
  const share = (v) => (total ? `${Math.round((100 * v) / total)}%` : '–')
  return (
    <figure className="chart">
      <figcaption className="chart__head">
        <span className="chart__title">{title}</span>
        <span className="hint">{total} {total === 1 ? 'request' : 'requests'}</span>
      </figcaption>
      <div className="split-bar" role="img" aria-label={parts.map((p) => `${p.label} ${p.value} (${share(p.value)})`).join(', ')}>
        {parts.filter((p) => p.value > 0).map((p) => (
          <span
            key={p.label}
            className="split-bar__part"
            style={{ flexGrow: p.value, background: SERIES[parts.indexOf(p)] }}
            title={`${p.label}: ${p.value} (${share(p.value)})`}
          />
        ))}
      </div>
      <ul className="split-list">
        {parts.map((p, i) => (
          <li key={p.label}>
            <span className="chart__key" style={{ background: SERIES[i] }} aria-hidden="true" />
            <span className="split-list__label">{p.label}</span>
            <span className="split-list__value">{p.value}</span>
            <span className="split-list__share">{share(p.value)}</span>
          </li>
        ))}
      </ul>
    </figure>
  )
}

/**
 * A ratio against its goal: a bar on a lighter track of the same color, with a mark at the goal.
 * @param value the current number (null = nothing measured yet)
 * @param max the end of the scale (100 for a percent, 5 for stars)
 */
export function Meter({ label, value, goal, max, format }) {
  const met = value !== null && value >= goal
  return (
    <div className="meter">
      <div className="meter__top">
        <span className="meter__label">{label}</span>
        <span className="meter__figure">
          <strong>{value === null ? '–' : format(value)}</strong> / {format(goal)}
        </span>
      </div>
      <div
        className="meter__track"
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value ?? 0}
        aria-valuetext={value === null ? 'No data yet' : `${format(value)}, goal ${format(goal)}`}
      >
        <span className="meter__fill" style={{ width: `${Math.min(100, ((value ?? 0) / max) * 100)}%` }} />
        <span className="meter__goal" style={{ left: `${(goal / max) * 100}%` }} aria-hidden="true" />
      </div>
      <span className={met ? 'meter__status meter__status--met' : 'meter__status'}>
        {value === null ? 'No data in this period' : met ? '✓ Goal met' : 'Below goal'}
      </span>
    </div>
  )
}

/** A legend: a small key (a line or a box, like the mark) and the name for each series. */
function Legend({ items }) {
  return (
    <ul className="legend">
      {items.map((item) => (
        <li key={item.label}>
          <span className={`chart__key${item.shape === 'line' ? ' chart__key--line' : ''}`} style={{ background: item.color }} aria-hidden="true" />
          {item.label}
        </li>
      ))}
    </ul>
  )
}

/** The table view of a chart. */
function DataTable({ caption, columns, rows }) {
  return (
    <div className="table-wrap chart__table">
      <table>
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>{columns.map((c) => <th key={c} scope="col">{c}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>{row.map((cell, j) => (j === 0 ? <th key={j} scope="row">{cell}</th> : <td key={j}>{cell}</td>))}</tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
