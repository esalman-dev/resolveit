// File check: works out what an uploaded file really is, and makes its name safe to show.
//
// Security: the browser's claimed type and the file's name are both chosen by the sender, so a
// virus renamed to photo.png would pass a name check. Every allowed format starts with known
// bytes (its "magic bytes"), so the type is read from the file itself.

/** The types attachments may have. Must match the CHECK on attachments.content_type. */
export const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf', 'text/plain'];

/** True when the buffer has these bytes at this position. */
const startsWith = (buffer, bytes, offset = 0) => bytes.every((byte, i) => buffer[offset + i] === byte);

/**
 * True for readable text: valid UTF-8 with no zero bytes.
 * Why: text formats have no magic bytes, and a program file almost always contains zero bytes.
 */
function isPlainText(buffer) {
  if (buffer.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns the file's real type, or null if it isn't an allowed kind of file.
 *
 * @example
 * detectType(pngBytes, 'screenshot.png') // 'image/png'
 * detectType(exeBytes, 'photo.png')      // null
 */
export function detectType(buffer, name) {
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(buffer, [0x47, 0x49, 0x46, 0x38])) return 'image/gif'; // "GIF8"
  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && startsWith(buffer, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp'; // "RIFF", then "WEBP" at byte 8
  }
  if (startsWith(buffer, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // "%PDF-"
  // Note: text is only accepted with a .txt or .log name, so random text files aren't.
  if (/\.(txt|log)$/i.test(name) && isPlainText(buffer)) return 'text/plain';
  return null;
}

/**
 * Makes an uploaded file name safe to store and show: no folders, no control characters,
 * at most 200 characters.
 *
 * @example
 * cleanFileName('C:\\Users\\me\\error.png') // 'error.png'
 */
export function cleanFileName(name) {
  const base = String(name ?? '').split(/[\\/]/).pop();
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return cleaned || 'file';
}
