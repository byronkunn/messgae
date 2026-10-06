import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useApp } from '../../store.jsx';
import { Avatar, Loading, Modal, Field } from '../../components/ui.jsx';
import { Back, DataTable, Kpi, Pagination, Panel, StatusTag, usePaged } from './common.jsx';
import { dateTime, downloadBlob, formatBytes, formatNumber, relative, roleLabel } from '../../utils.js';

export function UsersPage() {
  const nav = useNavigate();
  const paged = usePaged('/api/admin/users');
  const f = paged.params;
  return (
    <>
      <h1>Users</h1>
      <Panel pad={false}>
        <div className="filters">
          <input className="input" placeholder="Username, display name, Account ID or user ID" value={f.q || ''} onChange={(e) => paged.setFilter({ q: e.target.value })} />
          <select className="input" value={f.state || ''} onChange={(e) => paged.setFilter({ state: e.target.value || undefined })} aria-label="State">
            <option value="">Any state</option><option value="active">Active</option><option value="restricted">Restricted</option><option value="suspended">Suspended</option><option value="banned">Banned</option>
          </select>
          <select className="input" value={f.role || ''} onChange={(e) => paged.setFilter({ role: e.target.value || undefined })} aria-label="Role">
            <option value="">Any role</option><option value="user">User</option><option value="site_moderator">Site Moderator</option><option value="site_admin">Site Admin</option><option value="super_admin">Super Admin</option>
          </select>
          <select className="input" value={f.plan || ''} onChange={(e) => paged.setFilter({ plan: e.target.value || undefined })} aria-label="Plan">
            <option value="">Any plan</option><option value="free">Free</option><option value="plus">Plus</option>
          </select>
          <select className="input" value={`${f.sort || 'created'}:${f.dir || 'desc'}`} onChange={(e) => { const [sort, dir] = e.target.value.split(':'); paged.setFilter({ sort, dir }); }} aria-label="Sort">
            <option value="created:desc">Newest</option><option value="created:asc">Oldest</option><option value="last_seen:desc">Recently active</option><option value="username:asc">Username A–Z</option>
          </select>
        </div>
        <DataTable rows={paged.data?.items} onRow={(u) => nav(`/admin/users/${u.id}`)} columns={[
          { key: 'username', label: 'User', primary: true, render: (u) => <span className="row"><Avatar name={u.displayName} fileId={u.avatarFileId} size={28} /><span><b>@{u.username}</b><div className="tiny muted">{u.displayName}</div></span></span> },
          { key: 'role', label: 'Role', render: (u) => (u.siteRole === 'user' ? '—' : <span className="tag accent">{roleLabel(u.siteRole)}</span>) },
          { key: 'state', label: 'State', render: (u) => <StatusTag value={u.state} /> },
          { key: 'plan', label: 'Plan' },
          { key: 'created', label: 'Joined', render: (u) => relative(u.createdAt) },
          { key: 'seen', label: 'Last seen', render: (u) => relative(u.lastSeenAt) },
        ]} />
        <Pagination {...paged} />
      </Panel>
    </>
  );
}

function ActionDialog({ action, user, onClose, onDone }) {
  const { privileged, handleError, toast } = useApp();
  const [reason, setReason] = useState('');
  const [hours, setHours] = useState(action.hours ?? '');
  const [extra, setExtra] = useState(action.initial || {});
  const run = async () => {
    try {
      const body = { reason, ...(action.withHours ? { hours: hours ? Number(hours) : undefined } : {}), ...extra };
      const r = await privileged(() => request(action.method || 'POST', action.path, body));
      if (action.download) downloadBlob(JSON.stringify(r, null, 2), `export-${user.username}.json`, 'application/json');
      toast(action.done || 'Done');
      onDone();
      onClose();
    } catch (err) {
      handleError(err);
    }
  };
  return (
    <Modal title={`${action.label} — @${user.username}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className={`btn ${action.danger ? 'btn-danger' : 'btn-primary'}`} disabled={reason.trim().length < 5} onClick={run}>{action.label}</button></>}>
      {action.help && <p className="small muted">{action.help}</p>}
      {action.fields?.(extra, setExtra)}
      {action.withHours && (
        <Field label="Duration (hours)" hint={action.hoursHint}>
          <input className="input" type="number" min="1" value={hours} onChange={(e) => setHours(e.target.value)} placeholder={action.hoursOptional ? 'Indefinite' : ''} />
        </Field>
      )}
      <Field label="Reason (recorded in the audit log)"><textarea className="input" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus /></Field>
    </Modal>
  );
}
const request = (method, path, body) => api(path, { method, body, quiet: true });

export function UserDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { me, handleError } = useApp();
  const [d, setD] = useState(null);
  const [action, setAction] = useState(null);
  const caps = new Set(me.user.capabilities);
  const load = useCallback(() => api.get(`/api/admin/users/${id}`).then(setD).catch(handleError), [id, handleError]);
  useEffect(() => {
    load();
  }, [load]);
  if (!d) return <Loading />;
  const u = d.user;
  const base = `/api/admin/users/${u.id}`;
  const actions = [
    { key: 'warn', cap: 'users.warn', label: 'Warn', path: `${base}/warn`, help: 'Sends the user an in-app warning.', done: 'Warning sent' },
    { key: 'restrict', cap: 'users.restrict', label: 'Restrict', path: `${base}/restrict`, withHours: true, hours: 24, help: 'Restricted accounts can read and message existing DMs, but cannot post in groups/Spaces, create groups, Spaces, invites or share links.', done: 'User restricted' },
    { key: 'suspend', cap: 'users.suspend', label: 'Suspend', path: `${base}/suspend`, withHours: true, hours: 72, hoursOptional: caps.has('users.ban'), hoursHint: caps.has('users.ban') ? 'Leave empty for indefinite.' : 'Moderators can only suspend for a fixed time.', danger: true, help: 'Signs the user out everywhere and blocks sign-in.', done: 'User suspended' },
    { key: 'ban', cap: 'users.ban', label: 'Ban', path: `${base}/ban`, danger: true, help: 'Permanently blocks the account and revokes all its share links. Requires a privileged session.', done: 'User banned' },
    { key: 'reinstate', cap: 'users.suspend', label: 'Reinstate', path: `${base}/reinstate`, help: 'Lifts restrictions, suspensions (and bans for admins).', done: 'User reinstated', hidden: u.state === 'active' },
    { key: 'sessions', cap: 'users.security', label: 'Revoke all sessions', path: `${base}/revoke-sessions`, danger: true, done: 'Sessions revoked' },
    { key: '2fa', cap: 'users.security', label: 'Reset 2FA', path: `${base}/reset-2fa`, danger: true, hidden: !u.totpEnabled, done: '2FA reset' },
    { key: 'unlock', cap: 'users.security', label: 'Unlock sign-in', path: `${base}/unlock`, hidden: !u.lockedUntil || u.lockedUntil < Date.now(), done: 'Unlocked' },
    { key: 'plan', cap: 'users.plan', label: 'Change plan', path: `${base}/plan`, method: 'PATCH', initial: { plan: u.plan === 'plus' ? 'free' : 'plus' }, fields: (x, set) => (
      <Field label="Plan"><select className="input" value={x.plan} onChange={(e) => set({ ...x, plan: e.target.value })}><option value="free">Free</option><option value="plus">Plus</option></select></Field>
    ), done: 'Plan updated' },
    { key: 'staff', cap: 'staff.manage', label: 'Staff permissions', path: `${base}/staff`, method: 'PATCH', initial: { role: u.siteRole, evidenceAccess: u.evidenceAccess }, danger: true, help: 'Changing staff roles requires a privileged session and is audited.', fields: (x, set) => (
      <>
        <Field label="Site role"><select className="input" value={x.role} onChange={(e) => set({ ...x, role: e.target.value })}><option value="user">User</option><option value="site_moderator">Site Moderator</option><option value="site_admin">Site Admin</option><option value="super_admin">Super Admin</option></select></Field>
        <label className="check mb-3"><input type="checkbox" checked={x.evidenceAccess} onChange={(e) => set({ ...x, evidenceAccess: e.target.checked })} /><span>Evidence Access (view conversations, download user files, reveal file passwords)</span></label>
      </>
    ), done: 'Staff permissions updated' },
    { key: 'export', cap: 'data.export', label: 'Export data', path: `${base}/export`, download: true, help: 'Exports account data, sessions, files metadata, memberships and messages as JSON. Privileged and audited.', done: 'Export downloaded' },
  ].filter((a) => caps.has(a.cap) && !a.hidden && u.id !== me.user.id);

  return (
    <>
      <Back onClick={() => nav('/admin/users')} label="Users" />
      <div className="row gap-3 mb-3 wrap">
        <Avatar name={u.displayName} fileId={u.avatarFileId} size={64} />
        <div className="grow">
          <h1 style={{ margin: 0 }}>{u.displayName}</h1>
          <div className="muted">@{u.username} · <StatusTag value={u.state} /> {u.siteRole !== 'user' && <span className="tag accent">{roleLabel(u.siteRole)}</span>}</div>
        </div>
      </div>
      <div className="row wrap mb-3">
        {actions.map((a) => <button key={a.key} className={`btn btn-sm ${a.danger ? 'btn-danger' : ''}`} onClick={() => setAction(a)}>{a.label}</button>)}
        <Link className="btn btn-sm" to={`/admin/conversations?memberId=${u.id}`}>Conversations</Link>
        <Link className="btn btn-sm" to={`/admin/reports?targetId=${u.id}&status=all`}>Reports</Link>
      </div>
      <div className="kpis">
        <Kpi label="Messages" value={formatNumber(d.stats.messages)} sub={`${formatNumber(d.stats.messages7d)} in 7 days`} />
        <Kpi label="Storage" value={formatBytes(d.stats.storageBytes)} sub={`${formatNumber(d.stats.files)} files · ${formatNumber(d.stats.activeLinks)} links`} />
        <Kpi label="Bandwidth served" value={formatBytes(d.stats.bandwidthBytes)} />
        <Kpi label="Groups / Spaces" value={`${d.stats.groups} / ${d.stats.spaces}`} sub={`${d.stats.ownedSpaces} Spaces owned`} />
        <Kpi label="Reports" value={`${d.stats.reportsAgainst} against`} sub={`${d.stats.reportsFiled} filed`} />
      </div>
      <div className="panel-grid">
        <Panel title="Account">
          <dl className="kv">
            <dt>User ID</dt><dd className="mono small">{u.id}</dd>
            <dt>Account ID</dt><dd className="mono small">{u.accountId.replace(/(\d{4})(?=\d)/g, '$1 ')}</dd>
            <dt>Joined</dt><dd>{dateTime(u.createdAt)}</dd>
            <dt>Last seen</dt><dd>{dateTime(u.lastSeenAt)}</dd>
            <dt>Plan</dt><dd>{u.plan}</dd>
            <dt>2FA</dt><dd>{u.totpEnabled ? 'Enabled' : 'Off'}</dd>
            <dt>Evidence Access</dt><dd>{u.evidenceAccess ? 'Granted' : 'No'}</dd>
            <dt>Recovery key rotated</dt><dd>{dateTime(u.recoveryRotatedAt)}</dd>
            <dt>Failed sign-ins</dt><dd>{u.failedLogins}{u.lockedUntil > Date.now() ? ` · locked until ${dateTime(u.lockedUntil)}` : ''}</dd>
            {u.state !== 'active' && <><dt>State</dt><dd>{u.state}{u.stateUntil ? ` until ${dateTime(u.stateUntil)}` : ''} — {u.stateReason}</dd></>}
            <dt>Bio</dt><dd>{u.bio || '—'}</dd>
          </dl>
        </Panel>
        <Panel title="Sessions" pad={false}>
          <DataTable rows={d.sessions} empty="No active sessions." columns={[
            { key: 'device', label: 'Device', primary: true, render: (s) => s.deviceName },
            { key: 'ip', label: 'IP', render: (s) => (s.ip ? <span className="mono small">{s.ip}</span> : <span className="faint small">hidden</span>) },
            { key: 'active', label: 'Last active', render: (s) => relative(s.lastActiveAt) },
          ]} />
        </Panel>
      </div>
      <Panel title="Moderation history" pad={false}>
        <DataTable rows={d.moderation} empty="No moderation actions." columns={[
          { key: 'action', label: 'Action', primary: true },
          { key: 'scope', label: 'Scope' },
          { key: 'actor', label: 'By', render: (a) => (a.actor ? `@${a.actor}` : '—') },
          { key: 'reason', label: 'Reason' },
          { key: 'at', label: 'When', render: (a) => dateTime(a.createdAt) },
        ]} />
      </Panel>
      {action && <ActionDialog action={action} user={u} onClose={() => setAction(null)} onDone={load} />}
    </>
  );
}
