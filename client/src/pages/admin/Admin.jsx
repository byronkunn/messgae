import { Fragment, useEffect, useRef, useState } from 'react';
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../../api.js';
import { useApp } from '../../store.jsx';
import { Empty, Icon, IconButton, Loading } from '../../components/ui.jsx';
import { DataTable, Kpi, Pagination, Panel, ReasonProvider, StatusTag, usePaged, useReason } from './common.jsx';
import { Chart } from './Charts.jsx';
import { UsersPage, UserDetail } from './AdminUsers.jsx';
import { CommunicationsPage, ConversationsPage, ConversationInspector, SpacesAdmin, SpaceAdminDetail, FilesAdmin, FileInspector, ReportsPage, ReportDetail } from './AdminContent.jsx';
import { StoragePage, AnalyticsPage } from './AdminAnalytics.jsx';
import { compactNumber, dateTime, formatBytes, formatNumber, relative, roleLabel } from '../../utils.js';

const NAV = [
  ['', 'Overview', 'grid', 'admin.access'],
  ['users', 'Users', 'users', 'users.view'],
  ['communications', 'Communications', 'chat', 'analytics.view'],
  ['conversations', 'Conversations', 'forum', 'conversations.meta'],
  ['groups', 'Groups', 'users', 'conversations.meta'],
  ['spaces', 'Spaces', 'grid', 'conversations.meta'],
  ['files', 'Files', 'file', 'files.inspect'],
  ['storage', 'Storage', 'storage', 'analytics.view'],
  ['reports', 'Reports', 'flag', 'reports.review'],
  ['explore', 'Explore', 'compass', 'explore.manage'],
  ['analytics', 'Analytics', 'chart', 'analytics.view'],
  ['security', 'Security', 'shield', 'analytics.view'],
  ['billing', 'Billing', 'card', 'billing.view'],
  ['system', 'System', 'server', 'system.view'],
  ['audit', 'Audit Logs', 'audit', 'audit.view'],
];

function GlobalSearch() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [open, setOpen] = useState(false);
  const box = useRef(null);
  useEffect(() => {
    if (q.trim().length < 2) return setResults(null);
    const t = setTimeout(() => api.get(`/api/admin/search?q=${encodeURIComponent(q.trim())}`, { quiet: true }).then((r) => setResults(r.results)).catch(() => setResults([])), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const close = (e) => !box.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const icon = { user: 'user', dm: 'chat', group: 'users', channel: 'hash', space: 'grid', message: 'chat', file: 'file', report: 'flag' };
  return (
    <div ref={box} style={{ position: 'relative', flex: 1, maxWidth: 560 }}>
      <div className="search">
        <Icon name="search" className="icon-sm" />
        <input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} placeholder="Search users, conversations, files, messages, groups..." aria-label="Admin global search" />
      </div>
      {open && results && (
        <div className="menu" style={{ position: 'absolute', top: 46, left: 0, right: 0, maxHeight: 420, overflowY: 'auto' }}>
          {!results.length ? <div className="p-4 small muted">No matches. Try a username, Account ID, any ID, filename or SHA-256 hash.</div> : results.map((r) => (
            <button key={`${r.type}-${r.id}`} onClick={() => { setOpen(false); setQ(''); nav(r.path); }}>
              <Icon name={icon[r.type] || 'info'} className="icon-sm" />
              <span className="grow" style={{ minWidth: 0 }}><b className="ellipsis" style={{ display: 'block' }}>{r.title}</b><span className="tiny muted">{r.type} · {r.subtitle}</span></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function PrivilegeBadge() {
  const { me, elevate, refreshMe } = useApp();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15000);
    return () => clearInterval(t);
  }, []);
  const until = me.session?.elevatedUntil;
  if (until && until > now) return <span className="tag warn" title="Privileged session active">Privileged · {Math.ceil((until - now) / 60000)}m</span>;
  return <button className="btn btn-sm btn-ghost" onClick={async () => { if (await elevate()) refreshMe(); }}><Icon name="lock" className="icon-sm" /> Elevate</button>;
}

function Overview() {
  const { handleError } = useApp();
  const [d, setD] = useState(null);
  useEffect(() => {
    api.get('/api/admin/overview').then(setD).catch(handleError);
  }, [handleError]);
  if (!d) return <Loading />;
  return (
    <>
      <h1>Overview</h1>
      <div className="kpis">
        <Kpi label="Open reports" value={formatNumber(d.reports.open)} sub={`${d.reports.reviewing} reviewing · ${d.reports.escalated} escalated`} />
        {d.users && <>
          <Kpi label="Users" value={compactNumber(d.users.total)} sub={`+${formatNumber(d.users.new24h)} in 24h`} />
          <Kpi label="Daily active" value={compactNumber(d.users.dau)} sub={`${formatNumber(d.users.onlineNow)} online now`} />
          <Kpi label="Messages today" value={compactNumber(d.messaging.today)} sub={`${formatNumber(d.messaging.activeConversations24h)} active conversations`} />
          <Kpi label="Storage" value={formatBytes(d.storage.totalBytes)} sub={`${formatNumber(d.storage.uploads24h)} uploads in 24h`} />
          <Kpi label="Spaces" value={formatNumber(d.spaces)} />
          <Kpi label="Groups" value={formatNumber(d.groups)} />
          <Kpi label="Suspended / banned" value={formatNumber(d.users.suspended)} />
        </>}
      </div>
      {d.messagesSeries && <Panel title="Messages · last 24 hours"><Chart series={d.messagesSeries} labels={['Messages']} /></Panel>}
      <Panel title="Your access">
        <div className="small">Role: <b>{roleLabel(d.me.role)}</b> · 2FA {d.me.totpEnabled ? 'on' : 'off'} · {d.me.elevatedUntil ? `privileged until ${dateTime(d.me.elevatedUntil)}` : 'not elevated'}</div>
        <div className="row wrap mt-3" style={{ gap: 4 }}>{d.me.capabilities.map((c) => <span key={c} className="tag">{c}</span>)}</div>
      </Panel>
    </>
  );
}

function ExploreAdmin() {
  const { privileged, handleError, toast } = useApp();
  const { ask } = useReason();
  const [kind, setKind] = useState('space');
  const [removedOnly, setRemovedOnly] = useState(false);
  const paged = usePaged('/api/admin/explore', { kind: 'space' });
  const toggle = async (row) => {
    const reason = await ask();
    if (!reason) return;
    try {
      await privileged(() => api.post(`/api/admin/explore/${row.kind}/${row.id}`, { removed: !row.exploreRemoved, reason }));
      toast(row.exploreRemoved ? 'Restored to Explore' : 'Removed from Explore');
      paged.reload();
    } catch (err) {
      handleError(err);
    }
  };
  return (
    <>
      <h1>Explore</h1>
      <Panel pad={false} title="Public listings" actions={
        <div className="row wrap">
          <div className="segmented">{[['space', 'Spaces'], ['group', 'Groups']].map(([k, l]) => <button key={k} className={kind === k ? 'on' : ''} onClick={() => { setKind(k); paged.setFilter({ kind: k }); }}>{l}</button>)}</div>
          <label className="check small"><input type="checkbox" checked={removedOnly} onChange={(e) => { setRemovedOnly(e.target.checked); paged.setFilter({ removed: e.target.checked ? '1' : undefined }); }} />Removed only</label>
        </div>
      }>
        <DataTable rows={paged.data?.items} columns={[
          { key: 'name', label: 'Name', primary: true, render: (r) => <Link to={r.kind === 'space' ? `/admin/spaces/${r.id}` : `/admin/conversations/${r.id}`}>{r.name}</Link> },
          { key: 'members', label: 'Members', num: true, render: (r) => formatNumber(r.members) },
          { key: 'topic', label: 'Topic' },
          { key: 'discoverable', label: 'Listed', render: (r) => (r.exploreRemoved ? <StatusTag value="removed" /> : r.discoverable ? <span className="tag ok">listed</span> : <span className="tag">unlisted</span>) },
          { key: 'created', label: 'Created', render: (r) => relative(r.createdAt) },
          { key: 'act', label: '', render: (r) => <button className={`btn btn-sm ${r.exploreRemoved ? '' : 'btn-danger'}`} onClick={() => toggle(r)}>{r.exploreRemoved ? 'Restore' : 'Remove from Explore'}</button> },
        ]} />
        <Pagination {...paged} />
      </Panel>
    </>
  );
}

function SecurityPage() {
  const { handleError } = useApp();
  const [d, setD] = useState(null);
  const sessions = usePaged('/api/admin/sessions', { pageSize: 25 });
  useEffect(() => {
    api.get('/api/admin/security').then(setD).catch(handleError);
  }, [handleError]);
  if (!d) return <Loading />;
  return (
    <>
      <h1>Security</h1>
      <div className="kpis">
        <Kpi label="Failed logins (24h)" value={formatNumber(d.failedLogins24h)} />
        <Kpi label="Locked accounts" value={formatNumber(d.lockedAccounts)} />
        <Kpi label="Active sessions" value={compactNumber(d.activeSessions)} />
        <Kpi label="Staff without 2FA" value={formatNumber(d.staff.filter((s) => !s.totpEnabled).length)} />
      </div>
      <div className="panel-grid">
        <Panel title="Staff accounts" pad={false}>
          <DataTable rows={d.staff} columns={[
            { key: 'username', label: 'Staff', primary: true, render: (s) => <Link to={`/admin/users/${s.id}`}>@{s.username}</Link> },
            { key: 'role', label: 'Role', render: (s) => roleLabel(s.role) },
            { key: 'totp', label: '2FA', render: (s) => (s.totpEnabled ? <span className="tag ok">on</span> : <span className="tag danger">off</span>) },
            { key: 'ev', label: 'Evidence Access', render: (s) => (s.evidenceAccess ? <span className="tag warn">granted</span> : '—') },
            { key: 'seen', label: 'Last seen', render: (s) => relative(s.lastSeenAt) },
          ]} />
        </Panel>
        <Panel title="Controls in place">
          <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{d.controls.map((c) => <li key={c}>{c}</li>)}</ul>
          {d.topFailedIps.length > 0 && <><div className="label mt-3">Top failed-login IPs (24h)</div>{d.topFailedIps.map((r) => <div key={r.ip} className="small mono">{r.ip} — {r.count}</div>)}</>}
        </Panel>
      </div>
      <Panel title="Recent sensitive access" pad={false}>
        <DataTable rows={d.recentSensitive} columns={[
          { key: 'action', label: 'Action', primary: true },
          { key: 'actor', label: 'Staff', render: (a) => `@${a.actorUsername}` },
          { key: 'target', label: 'Target', render: (a) => <code className="small">{a.targetId}</code> },
          { key: 'reason', label: 'Reason' },
          { key: 'at', label: 'When', render: (a) => dateTime(a.createdAt) },
        ]} />
      </Panel>
      <Panel title="Active sessions" pad={false}>
        <DataTable rows={sessions.data?.items} columns={[
          { key: 'username', label: 'User', primary: true, render: (s) => <Link to={`/admin/users/${s.userId}`}>@{s.username}</Link> },
          { key: 'device', label: 'Device', render: (s) => s.deviceName },
          { key: 'ip', label: 'IP', render: (s) => <span className="mono small">{s.ip}</span> },
          { key: 'active', label: 'Last active', render: (s) => relative(s.lastActiveAt) },
        ]} />
        <Pagination {...sessions} />
      </Panel>
    </>
  );
}

function BillingPage() {
  const { handleError } = useApp();
  const [d, setD] = useState(null);
  useEffect(() => {
    api.get('/api/admin/billing').then(setD).catch(handleError);
  }, [handleError]);
  if (!d) return <Loading />;
  return (
    <>
      <h1>Billing</h1>
      <div className="notice warn mb-3">{d.notice}</div>
      <div className="kpis">
        <Kpi label="Estimated MRR" value={`$${formatNumber(d.estimatedMrr)}`} />
        {d.plans.map((p) => <Kpi key={p.id} label={`${p.label} users`} value={formatNumber(p.users)} sub={p.priceMonthly ? `$${p.priceMonthly}/mo` : 'Free'} />)}
        {d.spacePlans.map((p) => <Kpi key={p.id} label={p.label} value={formatNumber(p.spaces)} sub={p.priceMonthly ? `$${p.priceMonthly}/mo` : 'Free'} />)}
      </div>
      <Panel title="Plan limits" pad={false}>
        <DataTable rows={d.plans} columns={[
          { key: 'label', label: 'Plan', primary: true },
          { key: 'storage', label: 'Storage', render: (p) => formatBytes(p.storageBytes) },
          { key: 'upload', label: 'Max upload', render: (p) => formatBytes(p.uploadBytes) },
          { key: 'links', label: 'Active links', num: true, render: (p) => formatNumber(p.activeLinks) },
          { key: 'group', label: 'Group size', num: true, render: (p) => formatNumber(p.groupMembers) },
          { key: 'trash', label: 'Trash retention', render: (p) => `${p.trashRetentionDays} days` },
        ]} />
      </Panel>
    </>
  );
}

function SystemPage() {
  const { handleError, privileged, toast, me } = useApp();
  const [d, setD] = useState(null);
  useEffect(() => {
    api.get('/api/admin/system').then(setD).catch(handleError);
  }, [handleError]);
  const verify = async () => {
    try {
      const r = await privileged(() => api.post('/api/admin/audit/verify'));
      toast(r.ok ? `Audit chain intact (${formatNumber(r.count)} entries)` : `Audit chain BROKEN at ${r.brokenAt}`, { error: !r.ok, duration: 6000 });
    } catch (err) {
      handleError(err);
    }
  };
  if (!d) return <Loading />;
  return (
    <>
      <h1>System</h1>
      <div className="kpis">
        <Kpi label="Version" value={d.version} sub={`Node ${d.node}`} />
        <Kpi label="Uptime" value={`${Math.floor(d.uptimeSeconds / 3600)}h ${Math.floor((d.uptimeSeconds % 3600) / 60)}m`} sub={d.environment} />
        <Kpi label="Memory" value={`${d.memoryMb} MB`} />
        <Kpi label="Online users" value={formatNumber(d.realtime.onlineUsers)} />
      </div>
      <div className="panel-grid">
        <Panel title="Storage backends">
          <dl className="kv">
            <dt>Database</dt><dd>SQLite {d.database.sqlite} · {formatBytes(d.database.bytes)} (+{formatBytes(d.database.walBytes || 0)} WAL)</dd>
            <dt>Blob store</dt><dd>{formatNumber(d.blobStore.objects)} objects · {formatBytes(d.blobStore.bytesOnDisk)} on disk (encrypted)</dd>
            {Object.entries(d.keys).map(([k, v]) => <Fragment key={k}><dt>Key: {k}</dt><dd>{v === 'missing' ? <span className="danger-text">missing</span> : v}</dd></Fragment>)}
          </dl>
        </Panel>
        <Panel title="Row counts">
          <dl className="kv">{Object.entries(d.counts).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{formatNumber(v)}</dd></Fragment>)}</dl>
        </Panel>
      </div>
      {me.user.capabilities.includes('audit.verify') && <Panel title="Audit integrity"><p className="small muted">Recomputes the hash chain over the entire audit log to detect tampering.</p><button className="btn" onClick={verify}>Verify audit log</button></Panel>}
    </>
  );
}

function AuditPage() {
  const paged = usePaged('/api/admin/audit', { pageSize: 50 });
  const [open, setOpen] = useState(null);
  const f = paged.params;
  return (
    <>
      <h1>Audit Logs</h1>
      <Panel pad={false}>
        <div className="filters">
          <input className="input" placeholder="Actor (username or ID)" value={f.actor || ''} onChange={(e) => paged.setFilter({ actor: e.target.value })} />
          <input className="input" placeholder="Action prefix (e.g. file.)" value={f.action || ''} onChange={(e) => paged.setFilter({ action: e.target.value })} />
          <input className="input" placeholder="Target ID" value={f.targetId || ''} onChange={(e) => paged.setFilter({ targetId: e.target.value })} />
          <input className="input" placeholder="Reason / detail contains" value={f.q || ''} onChange={(e) => paged.setFilter({ q: e.target.value })} />
          <input className="input" type="date" value={f.from || ''} onChange={(e) => paged.setFilter({ from: e.target.value })} aria-label="From" />
          <input className="input" type="date" value={f.to || ''} onChange={(e) => paged.setFilter({ to: e.target.value })} aria-label="To" />
        </div>
        <DataTable rows={paged.data?.items} onRow={setOpen} columns={[
          { key: 'seq', label: '#', num: true },
          { key: 'action', label: 'Action', primary: true, render: (a) => <code>{a.action}</code> },
          { key: 'actor', label: 'Admin', render: (a) => (a.actorUsername ? `@${a.actorUsername}` : '—') },
          { key: 'target', label: 'Target', render: (a) => (a.targetId ? <span className="small">{a.targetType} <code>{a.targetId}</code></span> : '—') },
          { key: 'reason', label: 'Reason', render: (a) => <span className="small">{a.reason || '—'}</span> },
          { key: 'at', label: 'Timestamp', render: (a) => dateTime(a.createdAt) },
        ]} />
        <Pagination {...paged} />
      </Panel>
      {open && (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setOpen(null)}>
          <div className="sheet wide" role="dialog" aria-label="Audit entry">
            <div className="sheet-header"><h2>Audit entry #{open.seq}</h2><IconButton icon="x" label="Close" onClick={() => setOpen(null)} /></div>
            <div className="sheet-body">
              <dl className="kv">
                <dt>Action</dt><dd><code>{open.action}</code></dd>
                <dt>Admin</dt><dd>@{open.actorUsername} ({roleLabel(open.actorRole)})</dd>
                <dt>Target</dt><dd>{open.targetType} {open.targetId}</dd>
                <dt>Reason</dt><dd>{open.reason || '—'}</dd>
                <dt>Timestamp</dt><dd>{dateTime(open.createdAt)}</dd>
                <dt>IP</dt><dd className="mono">{open.ip}</dd>
                <dt>Session</dt><dd className="mono">{open.sessionId}</dd>
                <dt>User agent</dt><dd className="small">{open.userAgent}</dd>
                <dt>Hash</dt><dd className="mono tiny">{open.hash}</dd>
                <dt>Detail</dt><dd><pre className="small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{open.detail ? JSON.stringify(open.detail, null, 2) : '—'}</pre></dd>
              </dl>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function AdminLayout() {
  const { me } = useApp();
  const loc = useLocation();
  const nav = useNavigate();
  const caps = new Set(me.user.capabilities);
  const items = NAV.filter(([, , , cap]) => caps.has(cap));
  const section = loc.pathname.split('/')[2] || '';
  if (!caps.has('admin.access')) return <Empty icon="lock" title="Staff only" action={<Link className="btn" to="/chats">Back to chats</Link>} />;
  if (!me.user.totpEnabled) {
    return (
      <div className="auth"><div className="auth-card card">
        <h1 className="mb-3">Enable two-factor authentication</h1>
        <p className="muted">Staff accounts must use an authenticator app before accessing administration tools.</p>
        <Link className="btn btn-primary" to="/settings/security">Set up 2FA</Link>
      </div></div>
    );
  }
  return (
    <div className="admin">
      <header className="admin-top">
        <IconButton icon="back" label="Back to app" onClick={() => nav('/chats')} />
        <b className="hide-mobile" style={{ marginRight: 8 }}>Admin</b>
        <GlobalSearch />
        <PrivilegeBadge />
      </header>
      <div className="tabs admin-tabs">
        {items.map(([k, l]) => <NavLink key={k} to={`/admin/${k}`} end={k === ''} className={({ isActive }) => (isActive || (k && section === k) ? 'on' : '')}>{l}</NavLink>)}
      </div>
      <div className="admin-body">
        <nav className="admin-nav" aria-label="Admin">
          {items.map(([k, l, ic]) => (
            <NavLink key={k} to={`/admin/${k}`} end={k === ''} className={({ isActive }) => (isActive || (k && section === k) ? 'on' : '')}><Icon name={ic} className="icon-sm" />{l}</NavLink>
          ))}
        </nav>
        <main className="admin-main">
          <Routes>
            <Route index element={<Overview />} />
            <Route path="users" element={<UsersPage />} />
            <Route path="users/:id" element={<UserDetail />} />
            <Route path="communications" element={<CommunicationsPage />} />
            <Route path="conversations" element={<ConversationsPage />} />
            <Route path="groups" element={<ConversationsPage fixedType="group" />} />
            <Route path="conversations/:id" element={<ConversationInspector />} />
            <Route path="spaces" element={<SpacesAdmin />} />
            <Route path="spaces/:id" element={<SpaceAdminDetail />} />
            <Route path="files" element={<FilesAdmin />} />
            <Route path="files/:id" element={<FileInspector />} />
            <Route path="storage" element={<StoragePage />} />
            <Route path="reports" element={<ReportsPage />} />
            <Route path="reports/:id" element={<ReportDetail />} />
            <Route path="explore" element={<ExploreAdmin />} />
            <Route path="analytics" element={<AnalyticsPage />} />
            <Route path="security" element={<SecurityPage />} />
            <Route path="billing" element={<BillingPage />} />
            <Route path="system" element={<SystemPage />} />
            <Route path="audit" element={<AuditPage />} />
            <Route path="*" element={<Empty icon="info" title="Not found" />} />
          </Routes>
        </main>
      </div>
    </div>
  );
}

export default function AdminApp() {
  return (
    <ReasonProvider>
      <AdminLayout />
    </ReasonProvider>
  );
}
