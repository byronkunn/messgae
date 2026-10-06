export function formatBytes(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = Number(n);
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export const formatNumber = (n) => (n === null || n === undefined ? '—' : Number(n).toLocaleString());

export function compactNumber(n) {
  if (n === null || n === undefined) return '—';
  return Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n);
}

export function timeShort(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const diff = (now - d) / 86400000;
  if (diff < 7) return d.toLocaleDateString([], { weekday: 'short' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return d.toLocaleDateString();
}

export const clock = (ts) => new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
export const dateTime = (ts) => (ts ? new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const dateOnly = (ts) => (ts ? new Date(ts).toLocaleDateString([], { dateStyle: 'medium' }) : '—');

export function dayLabel(ts) {
  const d = new Date(ts);
  const now = new Date();
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === now.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
}

export function relative(ts) {
  if (!ts) return 'never';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 0) {
    const f = -s;
    if (f < 3600) return `in ${Math.ceil(f / 60)} min`;
    if (f < 86400) return `in ${Math.round(f / 3600)} h`;
    return `in ${Math.round(f / 86400)} days`;
  }
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} days ago`;
  return dateOnly(ts);
}

const COLORS = ['#4f6bff', '#e0613a', '#2fa37a', '#a256e6', '#d64583', '#1f9bd1', '#c7922a', '#5b6bd6', '#16a3a3', '#8a5cf6'];
export function colorFor(key = '') {
  let h = 0;
  for (const ch of String(key)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

export function initials(name = '?') {
  const parts = String(name).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const chars = parts.length === 1 ? [...parts[0]].slice(0, 2) : [[...parts[0]][0], [...parts[parts.length - 1]][0]];
  return chars.join('').toUpperCase();
}

export const extOf = (name = '') => (/\.([a-z0-9]{1,6})$/i.exec(name)?.[1] || 'FILE').toUpperCase();

export const STICKERS = {
  wave: '👋', heart: '❤️', laugh: '😂', fire: '🔥', party: '🎉', thumbs: '👍', cool: '😎', cry: '😢',
  think: '🤔', car: '🏎️', cat: '🐱', dog: '🐶', rocket: '🚀', clap: '👏', pray: '🙏', ok: '👌',
};

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
export const EMOJIS = [
  '😀', '😃', '😄', '😁', '😆', '😅', '😂', '🤣', '😊', '😇', '🙂', '😉', '😍', '🥰', '😘', '😋', '😜', '🤪', '🤗', '🤔',
  '🤨', '😐', '😑', '😶', '🙄', '😏', '😬', '😌', '😴', '😷', '🤒', '🥵', '🥶', '😎', '🤓', '🧐', '😕', '😟', '😮', '😲',
  '😳', '🥺', '😢', '😭', '😱', '😤', '😡', '🤬', '💀', '💩', '🤡', '👻', '👽', '🤖', '👋', '👌', '✌️', '🤞', '👍', '👎',
  '👏', '🙌', '🙏', '💪', '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💔', '💯', '🔥', '✨', '🎉', '🎁', '🏆', '⚽', '🎮',
  '🎵', '🚗', '🏎️', '✈️', '🚀', '🌙', '☀️', '🌈', '🍕', '🍔', '☕', '🍺', '🐱', '🐶', '🦊', '🐼', '✅', '❌', '⚠️', '❓',
];

export const TOPICS = {
  gaming: { label: 'Gaming', emoji: '🎮' }, technology: { label: 'Technology', emoji: '💻' }, cars: { label: 'Cars', emoji: '🏎️' },
  anime: { label: 'Anime', emoji: '🌸' }, art: { label: 'Art', emoji: '🎨' }, music: { label: 'Music', emoji: '🎵' },
  programming: { label: 'Programming', emoji: '⌨️' }, sports: { label: 'Sports', emoji: '⚽' }, entertainment: { label: 'Entertainment', emoji: '🎬' },
  education: { label: 'Education', emoji: '📚' }, science: { label: 'Science', emoji: '🔬' }, other: { label: 'Other', emoji: '✨' },
};

export const REPORT_REASONS = [
  ['spam', 'Spam'], ['scam', 'Scam or fraud'], ['harassment', 'Harassment or bullying'], ['hate', 'Hate speech'],
  ['violence', 'Violence or threats'], ['sexual_content', 'Sexual content'], ['child_safety', 'Child safety'],
  ['illegal', 'Illegal content'], ['impersonation', 'Impersonation'], ['malware', 'Malware or phishing'],
  ['copyright', 'Copyright'], ['self_harm', 'Self-harm'], ['other', 'Something else'],
];

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function downloadBlob(content, filename, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const roleLabel = (r) => ({ user: 'User', site_moderator: 'Site Moderator', site_admin: 'Site Admin', super_admin: 'Super Admin' }[r] || r);
