// File-signature ("magic number") detection. The server never trusts the MIME type
// sent by the client; it derives the type from the file's first bytes and checks
// that the extension is consistent with it.

const ascii = (buf, start, len) => buf.subarray(start, start + len).toString('latin1');
const startsWith = (buf, bytes, offset = 0) => bytes.every((b, i) => buf[offset + i] === b);

const ZIP_EXT = { docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  epub: 'application/epub+zip', apk: 'application/vnd.android.package-archive', jar: 'application/java-archive' };

const TEXT_EXT = { txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', json: 'application/json', log: 'text/plain',
  xml: 'application/xml', yml: 'text/plain', yaml: 'text/plain', html: 'text/html', htm: 'text/html', svg: 'image/svg+xml',
  js: 'text/javascript', ts: 'text/plain', css: 'text/css', py: 'text/plain', rtf: 'application/rtf', srt: 'text/plain',
  ini: 'text/plain', toml: 'text/plain', c: 'text/plain', cpp: 'text/plain', h: 'text/plain', java: 'text/plain',
  go: 'text/plain', rs: 'text/plain', sh: 'text/plain', sql: 'text/plain', vtt: 'text/vtt' };

/** Which extensions are acceptable for each detected MIME type. */
const EXT_FOR = {
  'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg', 'jfif'], 'image/gif': ['gif'], 'image/webp': ['webp'],
  'image/bmp': ['bmp'], 'image/heic': ['heic', 'heif'], 'image/avif': ['avif'], 'image/x-icon': ['ico'], 'image/tiff': ['tif', 'tiff'],
  'video/mp4': ['mp4', 'm4v', 'mov'], 'video/quicktime': ['mov', 'mp4'], 'video/webm': ['webm', 'mkv', 'weba'], 'video/x-matroska': ['mkv', 'webm'],
  'video/x-msvideo': ['avi'], 'video/3gpp': ['3gp'],
  'audio/mpeg': ['mp3'], 'audio/ogg': ['ogg', 'oga', 'opus'], 'audio/wav': ['wav'], 'audio/flac': ['flac'], 'audio/mp4': ['m4a', 'mp4', 'aac'],
  'audio/webm': ['webm', 'weba'], 'audio/aac': ['aac'],
  'application/pdf': ['pdf'],
  'application/zip': ['zip'], 'application/x-7z-compressed': ['7z'], 'application/vnd.rar': ['rar'], 'application/gzip': ['gz', 'tgz'],
  'application/x-bzip2': ['bz2'], 'application/x-xz': ['xz'], 'application/x-tar': ['tar'],
  'application/msword': ['doc', 'xls', 'ppt', 'msg'],
};

function detectSignature(buf, ext) {
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(buf, 0, 6) === 'GIF87a' || ascii(buf, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 4) === 'WEBP') return 'image/webp';
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 4) === 'WAVE') return 'audio/wav';
  if (ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 4) === 'AVI ') return 'video/x-msvideo';
  if (ascii(buf, 0, 2) === 'BM') return 'image/bmp';
  if (startsWith(buf, [0x00, 0x00, 0x01, 0x00])) return 'image/x-icon';
  if (startsWith(buf, [0x49, 0x49, 0x2a, 0x00]) || startsWith(buf, [0x4d, 0x4d, 0x00, 0x2a])) return 'image/tiff';
  if (ascii(buf, 4, 4) === 'ftyp') {
    const brand = ascii(buf, 8, 4);
    if (/^(heic|heix|hevc|mif1|msf1)/.test(brand)) return 'image/heic';
    if (/^avi[fs]/.test(brand)) return 'image/avif';
    if (/^M4A|^M4B/.test(brand)) return 'audio/mp4';
    if (/^qt/.test(brand)) return 'video/quicktime';
    if (/^3g/.test(brand)) return 'video/3gpp';
    if (ext === 'm4a') return 'audio/mp4';
    return 'video/mp4';
  }
  if (startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3])) {
    const head = ascii(buf, 0, 64);
    if (head.includes('webm')) return ext === 'weba' || ext === 'ogg' ? 'audio/webm' : 'video/webm';
    return 'video/x-matroska';
  }
  if (ascii(buf, 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0 && ext === 'mp3')) return 'audio/mpeg';
  if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return 'audio/aac';
  if (ascii(buf, 0, 4) === 'OggS') return 'audio/ogg';
  if (ascii(buf, 0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(buf, 0, 5) === '%PDF-') return 'application/pdf';
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04]) || startsWith(buf, [0x50, 0x4b, 0x05, 0x06])) {
    return ZIP_EXT[ext] || 'application/zip';
  }
  if (startsWith(buf, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return 'application/x-7z-compressed';
  if (ascii(buf, 0, 6) === 'Rar!\x1a\x07') return 'application/vnd.rar';
  if (startsWith(buf, [0x1f, 0x8b])) return 'application/gzip';
  if (ascii(buf, 0, 3) === 'BZh') return 'application/x-bzip2';
  if (startsWith(buf, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return 'application/x-xz';
  if (buf.length > 262 && ascii(buf, 257, 5) === 'ustar') return 'application/x-tar';
  if (startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])) return 'application/msword';
  if (ascii(buf, 0, 2) === 'MZ' || startsWith(buf, [0x7f, 0x45, 0x4c, 0x46]) ||
      startsWith(buf, [0xcf, 0xfa, 0xed, 0xfe]) || startsWith(buf, [0xca, 0xfe, 0xba, 0xbe])) return 'application/x-executable';
  return null;
}

function looksLikeText(buf) {
  if (buf.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf.subarray(0, Math.min(buf.length, 4096 - 4)));
    return true;
  } catch {
    return false;
  }
}

export function extensionOf(filename) {
  const m = /\.([a-z0-9]{1,10})$/i.exec(filename || '');
  return m ? m[1].toLowerCase() : '';
}

/**
 * Detects the real type of a file from its first bytes.
 * Returns { mime, category } or throws { mismatch } when the extension lies about
 * the content (e.g. an executable renamed to .jpg).
 */
export function detectFileType(head, filename) {
  const ext = extensionOf(filename);
  const sig = detectSignature(head, ext);
  if (sig) {
    const allowed = EXT_FOR[sig];
    const knownTypedExt = Object.values(EXT_FOR).flat().includes(ext) || ext in TEXT_EXT;
    if (allowed && ext && knownTypedExt && !allowed.includes(ext) && !(sig === 'application/zip' && ZIP_EXT[ext])) {
      return { error: `File content (${sig}) does not match its .${ext} extension.` };
    }
    if (sig === 'application/x-executable' && ext && (ext in TEXT_EXT || Object.values(EXT_FOR).flat().includes(ext))) {
      return { error: `File content does not match its .${ext} extension.` };
    }
    return { mime: sig, category: categoryOf(sig) };
  }
  if (looksLikeText(head)) {
    const mime = TEXT_EXT[ext] || 'text/plain';
    return { mime, category: 'document' };
  }
  // Unknown binary: allowed as a generic file, but a media extension must not be spoofed.
  if (ext && Object.values(EXT_FOR).flat().includes(ext)) {
    return { error: `File content does not look like a valid .${ext} file.` };
  }
  return { mime: 'application/octet-stream', category: 'other' };
}

export function categoryOf(mime) {
  if (mime.startsWith('image/') && mime !== 'image/svg+xml') return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (/zip|7z|rar|gzip|bzip2|x-xz|x-tar|java-archive|android.package/.test(mime) && !/officedocument|opendocument|epub/.test(mime)) {
    return 'archive';
  }
  if (mime === 'application/pdf' || mime.startsWith('text/') || /officedocument|opendocument|msword|epub|json|xml|rtf|svg/.test(mime)) {
    return 'document';
  }
  return 'other';
}

/** Types that are safe to render inline from our origin. Everything else is forced to download. */
export const INLINE_SAFE = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/mpeg', 'audio/ogg', 'audio/wav', 'audio/flac', 'audio/mp4', 'audio/webm', 'audio/aac',
]);
