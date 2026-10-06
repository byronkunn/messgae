import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { colorFor, initials } from '../utils.js';

// ---------------------------------------------------------------------------
// Icons (inline SVG, stroke-based, 24px grid)

const P = {
  chat: 'M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z',
  compass: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm3.5-12.5-2 5-5 2 2-5z',
  plus: 'M12 5v14M5 12h14',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 9a7 7 0 0 1 14 0',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm-7 10a7 7 0 0 1 14 0M17 3.5a4 4 0 0 1 0 7M22 21a7 7 0 0 0-4-6.3',
  back: 'M15 18l-6-6 6-6',
  chevron: 'M9 18l6-6-6-6',
  down: 'M6 9l6 6 6-6',
  more: 'M12 5.5h.01M12 12h.01M12 18.5h.01',
  moreH: 'M5.5 12h.01M12 12h.01M18.5 12h.01',
  send: 'M4 12 20 4l-4 16-4-7-8-1z',
  clip: 'M21 11.5 12.5 20a5 5 0 0 1-7-7L14 4.5a3.5 3.5 0 0 1 5 5L10.5 18a2 2 0 0 1-3-3L15 7.5',
  mic: 'M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm-6-3a6 6 0 0 0 12 0M12 18v3',
  image: 'M4 5h16v14H4zM4 16l5-5 4 4 3-3 4 4M15 9h.01',
  file: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
  poll: 'M5 20V10M12 20V4M19 20v-7',
  smile: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 14.5a4 4 0 0 0 7 0M9 9.5h.01M15 9.5h.01',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zm9 2-4-4',
  bell: 'M18 16V11a6 6 0 1 0-12 0v5l-2 2h16zM10 21h4',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.5 7.5 0 0 0-2-1.2L14.5 3h-4l-.4 2.6a7.5 7.5 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.5 7.5 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7.5 7.5 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
  shield: 'M12 3 5 6v6c0 4.5 3 7.7 7 9 4-1.3 7-4.5 7-9V6z',
  x: 'M6 6l12 12M18 6 6 18',
  check: 'M5 12.5 10 17 19 7',
  checks: 'M2 12.5 7 17l9-10M12 16l1 1 9-10',
  pin: 'M15 4.5 19.5 9l-3 1.5-3 3L13 18l-2.5-2.5L5 21M9 11.5l-3.5-.5 3-3 3.5.5',
  reply: 'M10 8 4 13l6 5M4 13h11a5 5 0 0 1 5 5v1',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  download: 'M12 4v11m0 0 4.5-4.5M12 15l-4.5-4.5M5 20h14',
  upload: 'M12 20V9m0 0 4.5 4.5M12 9l-4.5 4.5M5 4h14',
  lock: 'M6 11h12v10H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  hash: 'M5 9h15M4 15h15M10 3 8 21M16 3l-2 18',
  megaphone: 'M3 10v4h3l7 4V6L6 10zM16 8.5a4 4 0 0 1 0 7M18.5 6a7.5 7.5 0 0 1 0 12',
  forum: 'M4 5h12v9H8l-4 3zM8 17h8l4 3V9h-4',
  gallery: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
  copy: 'M8 8h11v11H8zM5 16V5h11',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2zM6.5 6.5h1v1h-1zM16.5 6.5h1v1h-1zM6.5 16.5h1v1h-1z',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A17 17 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 5.4-1.6M9.9 9.9a3 3 0 0 0 4.2 4.2',
  flag: 'M5 21V4m0 0h11l-2 4 2 4H5',
  ban: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM5.6 5.6l12.8 12.8',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-13v4.5l3 2',
  mute: 'M11 5 6 9H3v6h3l5 4zM17 9l4 6M21 9l-4 6',
  volume: 'M11 5 6 9H3v6h3l5 4zM15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13',
  star: 'M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8L3.5 9.7l5.9-.9z',
  chart: 'M4 20V4M4 20h16M8 16v-4M12 16V8M16 16v-6',
  key: 'M14.5 9.5a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zM13 12.5 20 19.5M17 16.5l2-2M15.5 15l2-2',
  device: 'M7 3h10v18H7zM11 18h2',
  laptop: 'M5 5h14v10H5zM2 19h20',
  globe: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z',
  grid: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z',
  video: 'M4 6h11v12H4zM15 10l5-3v10l-5-3',
  music: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-3-3 3 3 0 0 1 3 3zm11-2a3 3 0 1 1-3-3 3 3 0 0 1 3 3z',
  archive: 'M4 4h16v4H4zM5 8v12h14V8M10 12h4',
  share: 'M18 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm12 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8.6 13.5l6.8 4M15.4 6.5l-6.8 4',
  refresh: 'M20 11a8 8 0 0 0-14.8-4M4 4v4h4M4 13a8 8 0 0 0 14.8 4M20 20v-4h-4',
  restore: 'M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zm0-10v6m0-9.5h.01',
  sticker: 'M20 12V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h6zM20 12l-8 8M20 12h-5a3 3 0 0 0-3 3v5M9 9.5h.01M15 9.5h.01',
  gif: 'M4 6h16v12H4zM10 10H8.5v4H10v-1.5M13 10v4M16 14v-4h2M16 12h1.5',
  play: 'M7 4v16l13-8z',
  pause: 'M7 4h3v16H7zM14 4h3v16h-3z',
  stop: 'M6 6h12v12H6z',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4',
  crown: 'M3 8l4 4 5-7 5 7 4-4-2 11H5z',
  audit: 'M9 5H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-3M9 5a3 3 0 0 0 6 0M8 12h8M8 16h5',
  server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
  card: 'M3 6h18v12H3zM3 10h18',
  storage: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zm0 0v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  trend: 'M3 17l6-6 4 4 8-8M15 7h6v6',
};

export function Icon({ name, size, className = '', title, ...rest }) {
  const d = P[name] || P.info;
  return (
    <svg
      className={`icon ${className}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      width={size}
      height={size}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      {...rest}
    >
      {title && <title>{title}</title>}
      <path d={d} />
    </svg>
  );
}

export function IconButton({ icon, label, onClick, className = '', active, disabled, size, ...rest }) {
  return (
    <button type="button" className={`icon-btn ${active ? 'active' : ''} ${className}`} onClick={onClick} aria-label={label} title={label} disabled={disabled} {...rest}>
      <Icon name={icon} size={size} />
    </button>
  );
}

// ---------------------------------------------------------------------------

export function Avatar({ name, fileId, size = 44, square, online, className = '' }) {
  const [failed, setFailed] = useState(false);
  return (
    <span
      className={`avatar ${square ? 'square' : ''} ${className}`}
      style={{ '--size': `${size}px`, background: fileId && !failed ? 'var(--bg-3)' : colorFor(name) }}
      aria-hidden="true"
    >
      {fileId && !failed ? <img src={`/api/files/${fileId}/content`} alt="" loading="lazy" onError={() => setFailed(true)} /> : initials(name)}
      {online && <span className="presence" />}
    </span>
  );
}

export const Spinner = ({ className = '' }) => <div className={`spinner ${className}`} role="status" aria-label="Loading" />;

export function Loading() {
  return (
    <div className="center" style={{ padding: 40 }}>
      <Spinner />
    </div>
  );
}

export function Empty({ icon = 'chat', title, children, action }) {
  return (
    <div className="empty">
      <Icon name={icon} />
      {title && <h3>{title}</h3>}
      {children && <div className="muted small" style={{ maxWidth: 360 }}>{children}</div>}
      {action}
    </div>
  );
}

export function Toggle({ checked, onChange, label, disabled }) {
  return (
    <label className="toggle" aria-label={label}>
      <input type="checkbox" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  );
}

export function Segmented({ value, options, onChange }) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map(([v, label]) => (
        <button key={String(v)} type="button" role="radio" aria-checked={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map(([v, label]) => (
        <button key={v} type="button" role="tab" aria-selected={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}

/** Bottom sheet on phones, centered dialog on larger screens. */
export function Modal({ title, onClose, children, footer, wide, labelledBy }) {
  const ref = useRef(null);
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    document.addEventListener('keydown', onKey);
    const prev = document.activeElement;
    ref.current?.querySelector('input, textarea, select, button:not(.icon-btn)')?.focus?.();
    return () => {
      document.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return createPortal(
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`sheet ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title} aria-labelledby={labelledBy} ref={ref}>
        <div className="sheet-handle" />
        {title !== undefined && (
          <div className="sheet-header">
            <h2>{title}</h2>
            {onClose && <IconButton icon="x" label="Close" onClick={onClose} />}
          </div>
        )}
        <div className="sheet-body">{children}</div>
        {footer && <div className="sheet-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Popover menu anchored to a trigger element. Items: { label, icon, onClick, danger, hidden } or 'sep'.
 */
export function Menu({ anchor, items, onClose }) {
  const ref = useRef(null);
  const [pos, setPos] = useState({ top: -9999, left: -9999 });
  useLayoutEffect(() => {
    const r = anchor?.getBoundingClientRect?.() || { top: window.innerHeight / 2, bottom: window.innerHeight / 2, left: window.innerWidth / 2, right: window.innerWidth / 2 };
    const m = ref.current.getBoundingClientRect();
    let top = r.bottom + 6;
    if (top + m.height > window.innerHeight - 8) top = Math.max(8, r.top - m.height - 6);
    let left = r.right - m.width;
    if (left < 8) left = Math.min(r.left, window.innerWidth - m.width - 8);
    setPos({ top, left: Math.max(8, left) });
  }, [anchor]);
  useEffect(() => {
    const close = (e) => !ref.current?.contains(e.target) && onClose();
    const key = (e) => e.key === 'Escape' && onClose();
    setTimeout(() => document.addEventListener('mousedown', close), 0);
    document.addEventListener('keydown', key);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', key);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);
  return createPortal(
    <div className="menu" role="menu" ref={ref} style={pos}>
      {items.filter((i) => i && !i.hidden).map((item, i) =>
        item === 'sep' ? (
          <hr key={i} />
        ) : item.custom ? (
          <div key={i}>{item.custom(onClose)}</div>
        ) : (
          <button
            key={i}
            role="menuitem"
            type="button"
            className={item.danger ? 'danger' : ''}
            onClick={() => {
              onClose();
              item.onClick?.();
            }}
          >
            {item.icon && <Icon name={item.icon} className="icon-sm" />}
            {item.label}
          </button>
        ),
      )}
    </div>,
    document.body,
  );
}

export function useMenu() {
  const [state, setState] = useState(null);
  const open = (e, items) => setState({ anchor: e.currentTarget, items });
  const element = state ? <Menu anchor={state.anchor} items={state.items} onClose={() => setState(null)} /> : null;
  return [open, element];
}

export function Field({ label, hint, children, htmlFor }) {
  return (
    <div className="field">
      {label && <label htmlFor={htmlFor}>{label}</label>}
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function PaneHeader({ title, back, onBack, children, subtitle }) {
  return (
    <header className={`pane-header ${back || onBack ? 'with-back' : ''}`}>
      {(back || onBack) && <IconButton icon="back" label="Back" onClick={onBack} className={`back-btn ${back === 'always' ? 'always' : ''}`} />}
      <div className="grow">
        {typeof title === 'string' ? <h1 className="ellipsis" style={{ fontSize: back || onBack ? 17 : 20 }}>{title}</h1> : title}
        {subtitle && <div className="small muted ellipsis">{subtitle}</div>}
      </div>
      {children}
    </header>
  );
}
