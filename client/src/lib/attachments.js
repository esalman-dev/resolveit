// Attachment picker state: uploads picked files at once and tracks them until the form is sent.
//
// A picked file uploads straight away (POST /api/attachments). Sending the form then passes the
// uploaded ids as attachment_ids, which attaches them on the server.

import { useState } from 'react'
import { apiFetch } from './api.js'

export const MAX_FILES = 3 // must match MAX_FILES_PER_ITEM in server/routes/attachments.js

/** "512 KB", "1.2 MB" */
export function formatSize(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

let nextKey = 1

/**
 * State for one picker: the files picked so far, with their upload status.
 * Returns { files, ids, attachments, uploading, notice, add(fileList), remove(key), reset(), discard() }.
 * `ids` are the uploaded files' ids, ready to send as attachment_ids; `attachments` are the
 * same files as the server described them, ready for <AttachmentList>.
 */
export function useAttachmentPicker() {
  const [files, setFiles] = useState([])
  const [notice, setNotice] = useState('')

  const update = (key, changes) => setFiles((list) => list.map((f) => (f.key === key ? { ...f, ...changes } : f)))

  /** Uploads each picked file, up to the limit. */
  function add(fileList) {
    setNotice('')
    const room = MAX_FILES - files.filter((f) => f.status !== 'error').length
    const picked = [...fileList]
    if (picked.length > room) setNotice(`You can attach up to ${MAX_FILES} files.`)
    for (const file of picked.slice(0, Math.max(0, room))) {
      const key = nextKey++
      setFiles((list) => [...list, { key, name: file.name, size: file.size, status: 'uploading' }])
      const form = new FormData()
      form.append('file', file)
      apiFetch('/api/attachments', { method: 'POST', body: form })
        .then((data) => update(key, { status: 'done', id: data.attachment.id, attachment: data.attachment }))
        .catch((err) => update(key, { status: 'error', error: err.message }))
    }
  }

  /** Takes a file off the list; an uploaded one is deleted on the server too. */
  function remove(key) {
    const file = files.find((f) => f.key === key)
    setFiles((list) => list.filter((f) => f.key !== key))
    if (file?.id) apiFetch(`/api/attachments/${file.id}`, { method: 'DELETE' }).catch(() => {})
  }

  /** Empties the list after sending. The files now belong to what was sent, so nothing is deleted. */
  const reset = () => {
    setFiles([])
    setNotice('')
  }

  /** Empties the list and deletes the uploads, when the form is thrown away unsent. */
  function discard() {
    for (const file of files) if (file.id) apiFetch(`/api/attachments/${file.id}`, { method: 'DELETE' }).catch(() => {})
    reset()
  }

  const done = files.filter((f) => f.status === 'done')
  return {
    files,
    notice,
    ids: done.map((f) => f.id),
    attachments: done.map((f) => f.attachment),
    uploading: files.some((f) => f.status === 'uploading'),
    add,
    remove,
    reset,
    discard,
  }
}
