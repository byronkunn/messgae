export class ApiError extends Error {
  constructor(status, data) {
    super(data?.error?.message || `Request failed (${status})`);
    this.status = status;
    this.code = data?.error?.code || 'error';
    this.data = data?.error || {};
  }
}

const listeners = new Set();
/** Global hook for auth failures and privileged-session prompts. */
export const onApiError = (fn) => (listeners.add(fn), () => listeners.delete(fn));

export async function api(path, { method = 'GET', body, headers = {}, signal, quiet = false } = {}) {
  const opts = { method, headers: { 'x-requested-with': 'messgae', ...headers }, signal, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const err = new ApiError(res.status, data);
    if (!quiet) listeners.forEach((fn) => fn(err));
    throw err;
  }
  return data;
}

api.get = (p, o) => api(p, o);
api.post = (p, body = {}, o) => api(p, { ...o, method: 'POST', body });
api.patch = (p, body = {}, o) => api(p, { ...o, method: 'PATCH', body });
api.put = (p, body = {}, o) => api(p, { ...o, method: 'PUT', body });
api.del = (p, body, o) => api(p, { ...o, method: 'DELETE', body });

/** Upload with progress (fetch has no upload progress events). */
export function uploadFile(file, { onProgress, filename } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files');
    xhr.setRequestHeader('x-requested-with', 'messgae');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* ignore */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data.file);
      else reject(new ApiError(xhr.status, data));
    };
    xhr.onerror = () => reject(new ApiError(0, { error: { message: 'Network error during upload.' } }));
    const form = new FormData();
    form.append('file', file, filename || file.name);
    xhr.send(form);
  });
}

export const fileUrl = (id, { download = false, ticket } = {}) => {
  const q = new URLSearchParams();
  if (download) q.set('download', '1');
  if (ticket) q.set('ticket', ticket);
  const s = q.toString();
  return `/api/files/${id}/content${s ? `?${s}` : ''}`;
};

export const qs = (obj) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null && v !== '') q.set(k, v);
  const s = q.toString();
  return s ? `?${s}` : '';
};
