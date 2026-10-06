import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, qs } from '../../api.js';
import { useApp } from '../../store.jsx';
import { Icon, Loading } from '../../components/ui.jsx';
import { formatNumber } from '../../utils.js';

// ---------------------------------------------------------------------------
// Investigation reason: required for sensitive access, remembered for the session.

const ReasonContext = createContext(null);
export function ReasonProvider({ children }) {
  const [reason, setReason] = useState(() => {
    try {
      return sessionStorage.getItem('investigationReason') || '';
    } catch {
      return '';
    }
  });
  const save = (r) => {
    setReason(r);
    try {
      sessionStorage.setItem('investigationReason', r);
    } catch {
      /* ignore */
    }
  };
  return <ReasonContext.Provider value={{ reason, setReason: save }}>{children}</ReasonContext.Provider>;
}

export function useReason() {
  const { prompt } = useApp();
  const ctx = useContext(ReasonContext);
  const ask = useCallback(async ({ force = false } = {}) => {
    if (ctx.reason && !force) return ctx.reason;
    const r = await prompt({
      title: 'Investigation reason',
      message: 'Sensitive access is recorded in the audit log together with this reason.',
      label: 'Reason (e.g. report ID, legal request)',
      defaultValue: ctx.reason,
      minLength: 5,
      confirmLabel: 'Continue',
    });
    if (r) ctx.setReason(r);
    return r;
  }, [ctx, prompt]);
  return { reason: ctx.reason, ask, clear: () => ctx.setReason('') };
}

// ---------------------------------------------------------------------------
// Server-side pagination hook + controls.

export function usePaged(endpoint, initial = {}, { headers, enabled = true } = {}) {
  const { handleError, privileged } = useApp();
  const [params, setParams] = useState({ pageSize: 50, ...initial });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const headerKey = JSON.stringify(headers || {});
  const load = useCallback(async () => {
    if (!enabled) return;
    const my = ++seq.current;
    setLoading(true);
    try {
      const r = await privileged(() => api.get(`${endpoint}${qs(params)}`, { quiet: true, headers: JSON.parse(headerKey) }));
      if (my === seq.current) setData(r);
    } catch (err) {
      if (my === seq.current) {
        handleError(err);
        setData((d) => d || { items: [], total: 0, page: 1, pages: 1 });
      }
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, [endpoint, params, handleError, privileged, headerKey, enabled]);
  useEffect(() => {
    const t = setTimeout(load, 150);
    return () => clearTimeout(t);
  }, [load]);
  const setFilter = (patch) => setParams((p) => ({ ...p, ...patch, page: 1, cursor: undefined }));
  return { data, loading, params, setParams, setFilter, reload: load };
}

export function Pagination({ data, params, setParams }) {
  if (!data || data.total === null) return null;
  const { page, pages, total, from, to, maxJumpPage } = data;
  const go = (p) => setParams((x) => ({ ...x, page: p, cursor: undefined }));
  const nums = [];
  for (let p = Math.max(1, page - 2); p <= Math.min(pages, page + 2); p++) nums.push(p);
  if (!nums.includes(1)) nums.unshift(1, '…');
  if (!nums.includes(pages) && pages > 1) nums.push('…', pages);
  return (
    <div className="pagination">
      <span className="muted">Showing {formatNumber(from)}–{formatNumber(to)} of {formatNumber(total)}</span>
      <div className="pages">
        <button disabled={!data.prevCursor} onClick={() => setParams((x) => ({ ...x, cursor: data.prevCursor }))} aria-label="Previous page">‹ Prev</button>
        {nums.map((p, i) => (p === '…' ? <span key={`e${i}`} className="faint">…</span> : (
          <button key={p} className={p === page ? 'on' : ''} disabled={p > maxJumpPage && p !== page} title={p > maxJumpPage ? 'Use Next/Prev for deep pages' : ''} onClick={() => go(p)}>{formatNumber(p)}</button>
        )))}
        <button disabled={!data.nextCursor} onClick={() => setParams((x) => ({ ...x, cursor: data.nextCursor }))} aria-label="Next page">Next ›</button>
      </div>
      <select className="input" style={{ width: 'auto', minHeight: 34 }} value={params.pageSize} onChange={(e) => setParams((x) => ({ ...x, pageSize: Number(e.target.value), page: 1, cursor: undefined }))} aria-label="Rows per page">
        {[25, 50, 100].map((n) => <option key={n} value={n}>{n} / page</option>)}
      </select>
    </div>
  );
}

/** Responsive table: stacked cards on phones. columns: [{ key, label, render, num, primary }] */
export function DataTable({ columns, rows, onRow, empty = 'No results.' }) {
  if (!rows) return <Loading />;
  if (!rows.length) return <div className="p-4 muted small">{empty}</div>;
  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="table responsive">
        <thead><tr>{columns.map((c) => <th key={c.key} className={c.num ? 'num' : ''}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id || i} className={onRow ? 'clickable' : ''} onClick={onRow ? () => onRow(r) : undefined}>
              {columns.map((c) => (
                <td key={c.key} data-label={c.label} className={`${c.num ? 'num' : ''} ${c.primary ? 'primary' : ''}`}>{c.render ? c.render(r) : r[c.key]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Kpi({ label, value, sub }) {
  return (
    <div className="kpi">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

export function Panel({ title, actions, children, pad = true }) {
  return (
    <section className="panel">
      {(title || actions) && <div className="panel-head"><h3>{title}</h3>{actions}</div>}
      {pad ? <div className="panel-body">{children}</div> : children}
    </section>
  );
}

export function RangePicker({ value, onChange, allowCustom = true }) {
  const [custom, setCustom] = useState({ from: '', to: '' });
  const presets = [['1h', 'Hour'], ['24h', '24 hours'], ['7d', '7 days'], ['30d', '30 days']];
  return (
    <div className="row wrap">
      <div className="segmented">
        {presets.map(([k, l]) => <button key={k} className={value.range === k ? 'on' : ''} onClick={() => onChange({ range: k })}>{l}</button>)}
        {allowCustom && <button className={value.range === 'custom' ? 'on' : ''} onClick={() => onChange({ range: 'custom', from: custom.from || new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10), to: custom.to || new Date().toISOString().slice(0, 10) })}>Custom</button>}
      </div>
      {value.range === 'custom' && (
        <div className="row">
          <input className="input" type="date" style={{ width: 'auto', minHeight: 36 }} value={value.from} onChange={(e) => { setCustom({ ...custom, from: e.target.value }); onChange({ ...value, from: e.target.value }); }} aria-label="From" />
          <span>–</span>
          <input className="input" type="date" style={{ width: 'auto', minHeight: 36 }} value={value.to} onChange={(e) => { setCustom({ ...custom, to: e.target.value }); onChange({ ...value, to: e.target.value }); }} aria-label="To" />
        </div>
      )}
    </div>
  );
}

export function StatusTag({ value }) {
  const cls = { active: 'ok', ok: 'ok', open: 'warn', reviewing: 'accent', escalated: 'danger', resolved: 'ok', dismissed: '', restricted: 'warn', suspended: 'danger', banned: 'danger', quarantined: 'danger', removed: 'danger' }[value] ?? '';
  return <span className={`tag ${cls}`}>{String(value).replace(/_/g, ' ')}</span>;
}

export function Back({ onClick, label = 'Back' }) {
  return <button className="link-btn small mb-3" onClick={onClick}><Icon name="back" size={14} /> {label}</button>;
}
