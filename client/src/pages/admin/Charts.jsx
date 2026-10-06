import { useEffect, useMemo, useRef, useState } from 'react';
import { compactNumber, formatBytes } from '../../utils.js';

/** Lightweight responsive SVG line/area chart (no chart library needed). */
export function Chart({ series = [], keys = ['value'], labels, bytes = false, height = 180 }) {
  const [hover, setHover] = useState(null);
  const wrap = useRef(null);
  const [W, setW] = useState(600);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [series.length === 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const H = height;
  const pad = { l: 40, r: 8, t: 10, b: 22 };
  const max = useMemo(() => Math.max(1, ...series.flatMap((p) => keys.map((k) => p[k] || 0))), [series, keys]);
  if (!series.length) return <div ref={wrap} className="small muted">No data for this period.</div>;
  const x = (i) => pad.l + (i / Math.max(1, series.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - v / max) * (H - pad.t - pad.b);
  const fmt = (v) => (bytes ? formatBytes(v) : compactNumber(v));
  const span = series.length > 1 ? series[series.length - 1].t - series[0].t : 0;
  const tick = (t) => new Date(t).toLocaleString([], span <= 2 * 86400000 ? { hour: 'numeric' } : { month: 'short', day: 'numeric' });
  const ticks = [0, Math.floor((series.length - 1) / 2), series.length - 1].filter((v, i, a) => a.indexOf(v) === i);
  return (
    <div ref={wrap}>
      <svg className="chart" viewBox={`0 0 ${W} ${H}`} width={W} height={H} style={{ height }} role="img" aria-label="Chart"
        onMouseMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const i = Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (series.length - 1));
          setHover(Math.max(0, Math.min(series.length - 1, i)));
        }}
        onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line className="grid" x1={pad.l} x2={W - pad.r} y1={y(max * f)} y2={y(max * f)} />
            <text x={pad.l - 4} y={y(max * f) + 3} textAnchor="end">{fmt(max * f)}</text>
          </g>
        ))}
        {keys.map((k, ki) => {
          const d = series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p[k] || 0).toFixed(1)}`).join('');
          return (
            <g key={k}>
              {ki === 0 && <path className="area" d={`${d}L${x(series.length - 1)},${y(0)}L${x(0)},${y(0)}Z`} />}
              <path className={`line ${ki ? `l${ki + 1}` : ''}`} d={d} vectorEffect="non-scaling-stroke" />
            </g>
          );
        })}
        {ticks.map((i) => <text key={i} x={x(i)} y={H - 6} textAnchor={i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle'}>{tick(series[i].t)}</text>)}
        {hover !== null && <line className="grid" x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} style={{ stroke: 'var(--text-3)' }} />}
      </svg>
      <div className="legend">
        {hover !== null && <span><b>{tick(series[hover].t)}</b></span>}
        {keys.map((k, i) => (
          <span key={k}><i className={i ? `l${i + 1}` : ''} />{labels?.[i] || k}{hover !== null ? `: ${fmt(series[hover][k] || 0)}` : ''}</span>
        ))}
      </div>
    </div>
  );
}

export function BarList({ rows, label, value, format = compactNumber }) {
  const max = Math.max(1, ...rows.map((r) => Number(value(r)) || 0));
  if (!rows.length) return <div className="small muted">No data.</div>;
  return (
    <div className="bars">
      {rows.map((r, i) => (
        <div key={i} className="bar-row">
          <span className="ellipsis">{label(r)}</span>
          <div className="bar-track"><div className="bar-fill" style={{ width: `${(Number(value(r)) / max) * 100}%` }} /></div>
          <span className="small bold">{format(value(r))}</span>
        </div>
      ))}
    </div>
  );
}
