export class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export const bad = (message, code = 'bad_request') => new HttpError(400, code, message);
export const forbidden = (message = 'You do not have permission to do that.', code = 'forbidden') =>
  new HttpError(403, code, message);
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found.`);

/** Wraps a route handler so thrown errors and rejected promises reach the error middleware. */
export const h = (fn) => (req, res, next) => {
  try {
    const out = fn(req, res, next);
    if (out && typeof out.then === 'function') out.catch(next);
  } catch (err) {
    next(err);
  }
};

// ---------------------------------------------------------------------------
// Input validation helpers. They throw 400s with a readable message.

export function str(value, name, { min = 0, max = 1000, trim = true, pattern } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw bad(`${name} must be text.`);
  let v = trim ? value.trim() : value;
  // Strip control characters other than newline/tab.
  v = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (v.length < min) throw bad(min === 1 ? `${name} is required.` : `${name} must be at least ${min} characters.`);
  if (v.length > max) throw bad(`${name} must be at most ${max} characters.`);
  if (pattern && v && !pattern.test(v)) throw bad(`${name} is not valid.`);
  return v;
}

export function oneOf(value, name, options, fallback) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw bad(`${name} is required.`);
  }
  if (!options.includes(value)) throw bad(`${name} must be one of: ${options.join(', ')}.`);
  return value;
}

export function int(value, name, { min = -Infinity, max = Infinity, fallback } = {}) {
  if (value === undefined || value === null || value === '') {
    if (fallback !== undefined) return fallback;
    throw bad(`${name} is required.`);
  }
  const n = Number(value);
  if (!Number.isInteger(n)) throw bad(`${name} must be a whole number.`);
  if (n < min || n > max) throw bad(`${name} must be between ${min} and ${max}.`);
  return n;
}

export const bool = (value, fallback = false) =>
  value === undefined || value === null ? fallback : value === true || value === 'true' || value === 1 || value === '1';

export const now = () => Date.now();

export function parseJson(text, fallback) {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}

export function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

export function describeDevice(ua = '') {
  const s = String(ua);
  let os = 'Unknown OS';
  if (/iPhone|iPod/.test(s)) os = 'iPhone';
  else if (/iPad/.test(s)) os = 'iPad';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Windows/.test(s)) os = 'Windows';
  else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS';
  else if (/Linux/.test(s)) os = 'Linux';
  let browser = 'Browser';
  if (/Edg\//.test(s)) browser = 'Edge';
  else if (/Firefox\//.test(s)) browser = 'Firefox';
  else if (/Chrome\//.test(s)) browser = 'Chrome';
  else if (/Safari\//.test(s)) browser = 'Safari';
  else if (/node|undici|curl/i.test(s)) browser = 'API client';
  const type = /Mobile|iPhone|Android(?!.*Tablet)/.test(s) ? 'mobile' : /iPad|Tablet/.test(s) ? 'tablet' : 'desktop';
  return { name: `${browser} on ${os}`, type };
}
