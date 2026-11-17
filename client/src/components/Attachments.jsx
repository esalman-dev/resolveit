// Attachments: the "Add a screenshot or file" picker and the list of files on a ticket or comment.
//
// The picker's state (uploading, ids to send) lives in lib/attachments.js (useAttachmentPicker).
//
// Files are private, so they're always fetched through apiFetch with the login token, never by
// a plain link: the browser wouldn't send the token with an <img src> or <a href>.

import { useEffect, useRef, useState } from 'react'
import { apiFetch } from '../lib/api.js'
import { MAX_FILES, formatSize } from '../lib/attachments.js'
import './Attachments.css'

const ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.log' // the file types the server accepts

/**
 * The "Add a screenshot or file" button, a drop zone, and a chip for each picked file.
 *
 * @example
 * const picker = useAttachmentPicker()
 * <AttachmentPicker picker={picker} />
 */
export function AttachmentPicker({ picker, hint, disabled = false }) {
  const input = useRef(null)
  const [dragging, setDragging] = useState(false)
  const full = picker.files.filter((f) => f.status !== 'error').length >= MAX_FILES

  /** Accepts files dropped on the zone. */
  function onDrop(event) {
    event.preventDefault()
    setDragging(false)
    if (!disabled && event.dataTransfer.files.length) picker.add(event.dataTransfer.files)
  }

  return (
    <div
      className={`attach-picker${dragging ? ' attach-picker--dragging' : ''}`}
      onDragOver={(event) => {
        event.preventDefault()
        if (!disabled) setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="attach-picker__row">
        <button type="button" className="link" onClick={() => input.current.click()} disabled={disabled || full}>
          📎 Add a screenshot or file
        </button>
        <span className="attach-picker__hint">or drop it here · images, PDF or .txt/.log, up to 5 MB</span>
        <input
          ref={input}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          onChange={(event) => {
            picker.add(event.target.files)
            event.target.value = '' // so picking the same file again still counts as a change
          }}
        />
      </div>
      {hint && <p className="attach-picker__hint">{hint}</p>}
      {picker.notice && <p className="attach-picker__error" role="alert">{picker.notice}</p>}
      {picker.files.length > 0 && (
        <ul className="attach-chips">
          {picker.files.map((file) => (
            <li key={file.key} className={`attach-chip attach-chip--${file.status}`}>
              <span className="attach-chip__name">{file.name}</span>
              <span className="attach-chip__meta">
                {file.status === 'uploading' ? 'Uploading…' : file.status === 'error' ? file.error : formatSize(file.size)}
              </span>
              <button
                type="button"
                className="attach-chip__remove"
                aria-label={`Remove ${file.name}`}
                onClick={() => picker.remove(file.key)}
                disabled={disabled}
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/** Fetches a private file and gives back a temporary local address for it (revoked on unmount). */
function useFileUrl(id) {
  const [url, setUrl] = useState(null)
  useEffect(() => {
    let objectUrl = null
    let cancelled = false
    apiFetch(`/api/attachments/${id}`, { as: 'blob' })
      .then((blob) => {
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch(() => {})
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl) // frees the memory the file was using
    }
  }, [id])
  return url
}

/** One image: a thumbnail that opens full size in a new tab. */
function ImageAttachment({ file }) {
  const url = useFileUrl(file.id)
  return (
    <li className="attach-thumb">
      <a href={url ?? undefined} target="_blank" rel="noopener noreferrer" title={`${file.name} (${formatSize(file.size_bytes)})`}>
        {url ? <img src={url} alt={file.name} /> : <span className="attach-thumb__loading">Loading…</span>}
      </a>
    </li>
  )
}

/** One PDF or text log: a chip that downloads the file. */
function FileAttachment({ file }) {
  const [error, setError] = useState('')

  async function download() {
    setError('')
    try {
      const blob = await apiFetch(`/api/attachments/${file.id}`, { as: 'blob' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = file.name
      link.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      setError(err.message)
    }
  }

  return (
    <li>
      <button type="button" className="attach-chip attach-chip--file" onClick={download} title={error || 'Download'}>
        <span aria-hidden="true">{file.content_type === 'application/pdf' ? '📄' : '📝'}</span>
        <span className="attach-chip__name">{file.name}</span>
        <span className="attach-chip__meta">{error ? "Couldn't download" : formatSize(file.size_bytes)}</span>
      </button>
    </li>
  )
}

/**
 * The files on a ticket or comment: thumbnails for images, download chips for the rest.
 * Renders nothing when there are none. `className` lets a card add its own padding.
 */
export function AttachmentList({ attachments, className = '' }) {
  if (!attachments?.length) return null
  const images = attachments.filter((a) => a.content_type.startsWith('image/'))
  const others = attachments.filter((a) => !a.content_type.startsWith('image/'))
  return (
    <div className={`attach-list ${className}`.trim()}>
      {images.length > 0 && (
        <ul className="attach-thumbs">
          {images.map((file) => <ImageAttachment key={file.id} file={file} />)}
        </ul>
      )}
      {others.length > 0 && (
        <ul className="attach-chips">
          {others.map((file) => <FileAttachment key={file.id} file={file} />)}
        </ul>
      )}
    </div>
  )
}
