import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../../api.js';
import { useApp } from '../../store.jsx';
import { Avatar, Empty, Icon, Loading, Tabs } from '../../components/ui.jsx';
import { Back, DataTable, Kpi, Pagination, Panel, RangePicker, StatusTag, usePaged, useReason } from './common.jsx';
import { Chart } from './Charts.jsx';
import { compactNumber, dateTime, formatBytes, formatNumber, relative, REPORT_REASONS } from '../../utils.js';

// ---------------------------------------------------------------------------
// Communications dashboard

function Ranking({ title, rows, render, value, format = formatNumber }) {
  return (
    <Panel title={title} pad={false}>
      {!rows?.length ? <div className="p-4 small muted">No activity in this range.</div> : (
        <ol className="rank-list">
          {rows.map((r, i) => <li key={r.id || i}><span className="rank">{i + 1}</span><span className="grow ellipsis">{render(r)}</span><b>{format(value(r))}</b></li>)}
        </ol>
      )}
    </Panel>
  );
}

export function CommunicationsPage() {
  const { handleError } = useApp();
  const [range, setRange] = useState({ range: '7d' });
  const [d, setD] = useState(null);
  useEffect(() => {
    setD(null);
    api.get(`/api/admin/communications${qs(range)}`).then(setD).catch(handleError);
  }, [range, handleError]);
  const convLink = (r) => <Link to={`/admin/conversations/${r.id}`}>{r.type === 'channel' ? `#${r.name}` : r.name}{r.spaceName ? <span className="faint small"> · {r.spaceName}</span> : null}</Link>;
  return (
    <>
      <div className="row between wrap mb-3"><h1 style={{ margin: 0 }}>Communications</h1><RangePicker value={range} onChange={setRange} /></div>
      {!d ? <Loading /> : (
        <>
          <div className="kpis">
            <Kpi label="Messages today" value={compactNumber(d.kpis.messagesToday)} />
            <Kpi label="Messages this week" value={compactNumber(d.kpis.messagesWeek)} />
            <Kpi label="Messages this month" value={compactNumber(d.kpis.messagesMonth)} />
            <Kpi label="Active conversations" value={formatNumber(d.kpis.activeConversations)} sub="in selected range" />
            <Kpi label="Active DMs" value={formatNumber(d.kpis.activeDms)} />
            <Kpi label="Active groups" value={formatNumber(d.kpis.activeGroups)} />
            <Kpi label="Active Spaces" value={formatNumber(d.kpis.activeSpaces)} sub={`${formatNumber(d.kpis.activeChannels)} active channels`} />
            <Kpi label="Messages per active user" value={d.kpis.messagesPerActiveUser} sub={`${formatNumber(d.kpis.activeUsers)} active senders`} />
            <Kpi label="Media messages" value={compactNumber(d.kpis.mediaMessages)} />
            <Kpi label="File messages" value={compactNumber(d.kpis.fileMessages)} />
          </div>
          <Panel title="Message volume"><Chart series={d.series} keys={['value', 'dm', 'grp']} labels={['All', 'DMs', 'Groups']} /></Panel>
          <div className="panel-grid">
            <Ranking title="Most active conversations" rows={d.rankings.conversations} render={convLink} value={(r) => r.messages} />
            <Ranking title="Most active groups" rows={d.rankings.groups} render={convLink} value={(r) => r.messages} />
            <Ranking title="Most active Spaces" rows={d.rankings.spaces} render={(r) => <Link to={`/admin/spaces/${r.id}`}>{r.name}</Link>} value={(r) => r.messages} />
            <Ranking title="Most active channels" rows={d.rankings.channels} render={convLink} value={(r) => r.messages} />
            <Ranking title="Fastest-growing groups" rows={d.rankings.fastestGrowingGroups} render={(r) => <Link to={`/admin/conversations/${r.id}`}>{r.name} <span className="tag ok">+{r.growthPct}%</span></Link>} value={(r) => r.newMembers} />
            <Ranking title="Media-heavy conversations" rows={d.rankings.mediaHeavy} render={convLink} value={(r) => r.media} />
            <Ranking title="File-heavy conversations" rows={d.rankings.fileHeavy} render={convLink} value={(r) => r.files} />
            <Ranking title="Largest storage consumers" rows={d.rankings.storageConsumers} render={(r) => <Link to={`/admin/users/${r.id}`}>@{r.username}</Link>} value={(r) => r.bytes} format={formatBytes} />
          </div>
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Conversations list + inspector

export function ConversationsPage({ fixedType }) {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const paged = usePaged(fixedType === 'group' ? '/api/admin/groups' : '/api/admin/conversations', { memberId: sp.get('memberId') || undefined, sort: 'last_message' });
  const f = paged.params;
  return (
    <>
      <h1>{fixedType === 'group' ? 'Groups' : 'Conversations'}</h1>
      <Panel pad={false}>
        <div className="filters">
          <input className="input" placeholder="Name or conversation / Space ID" value={f.q || ''} onChange={(e) => paged.setFilter({ q: e.target.value })} />
          {!fixedType && (
            <select className="input" value={f.type || ''} onChange={(e) => paged.setFilter({ type: e.target.value || undefined })} aria-label="Type">
              <option value="">All types</option><option value="dm">Direct messages</option><option value="group">Groups</option><option value="channel">Channels</option>
            </select>
          )}
          <input className="input" placeholder="Member user ID" value={f.memberId || ''} onChange={(e) => paged.setFilter({ memberId: e.target.value || undefined })} />
          <select className="input" value={f.sort || 'last_message'} onChange={(e) => paged.setFilter({ sort: e.target.value })} aria-label="Sort">
            <option value="last_message">Recent activity</option><option value="messages">Message count</option><option value="created">Created</option>
          </select>
        </div>
        <DataTable rows={paged.data?.items} onRow={(c) => nav(`/admin/conversations/${c.id}`)} columns={[
          { key: 'name', label: 'Conversation', primary: true, render: (c) => <span>{c.type === 'channel' ? '#' : ''}{c.name}{c.spaceName && <span className="faint small"> · {c.spaceName}</span>}{c.removed && <> <StatusTag value="removed" /></>}</span> },
          { key: 'type', label: 'Type', render: (c) => <span className="tag">{c.type === 'channel' ? c.channelType : c.type}</span> },
          { key: 'members', label: 'Members', num: true, render: (c) => formatNumber(c.memberCount) },
          { key: 'messages', label: 'Messages', num: true, render: (c) => formatNumber(c.messageCount) },
          { key: 'last', label: 'Last activity', render: (c) => relative(c.lastMessageAt) },
          { key: 'created', label: 'Created', render: (c) => relative(c.createdAt) },
        ]} />
        <Pagination {...paged} />
      </Panel>
    </>
  );
}

function AdminMessage({ m, onRemove }) {
  return (
    <div style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
      <div className="row between wrap">
        <span className="small"><b>{m.sender ? <Link to={`/admin/users/${m.sender.id}`}>@{m.sender.username}</Link> : 'system'}</b> <span className="faint">· {dateTime(m.createdAt)}{m.editedAt ? ' · edited' : ''}</span></span>
        <span className="row" style={{ gap: 4 }}>
          <code className="tiny faint">{m.id}</code>
          {!m.deletedAt && m.kind !== 'system' && onRemove && <button className="btn btn-sm btn-danger" onClick={() => onRemove(m)}>Remove</button>}
        </span>
      </div>
      {m.deletedAt ? <div className="small faint">[deleted{m.deletedBy && m.deletedBy !== m.sender?.id ? ' by staff/moderator' : ''}]</div> : (
        <>
          {m.replyTo && <div className="tiny faint">↪ reply to {m.replyTo.id}</div>}
          {m.body && <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.body}</div>}
          {m.kind === 'poll' && m.poll && <div className="small">📊 {m.poll.question} — {m.poll.options.join(' / ')}</div>}
          {m.kind === 'sticker' && <div className="small">[sticker: {m.sticker}]</div>}
          {m.kind === 'system' && <div className="small faint">[system event]</div>}
          {m.attachments.map((a) => <div key={a.id} className="small"><Icon name="file" size={14} /> <Link to={`/admin/files/${a.id}`}>{a.filename}</Link> <span className="faint">{formatBytes(a.size)}</span></div>)}
        </>
      )}
    </div>
  );
}

function ContentTab({ conv, kind }) {
  const { reason, ask } = useReason();
  const { privileged, handleError, toast, me } = useApp();
  const [sp] = useSearchParams();
  const [active, setActive] = useState(!!reason);
  const paged = usePaged(`/api/admin/conversations/${conv.id}/messages`, { kind: kind === 'messages' ? undefined : kind, messageId: sp.get('messageId') || undefined, pageSize: 50 }, { headers: { 'x-investigation-reason': encodeURIComponent(reason || '') }, enabled: active && !!reason });
  const f = paged.params;
  const start = async () => {
    if (await ask()) setActive(true);
  };
  const remove = async (m) => {
    const r = await ask({ force: false });
    if (!r) return;
    try {
      await privileged(() => api.post(`/api/admin/messages/${m.id}/remove`, { reason: r }));
      toast('Message removed');
      paged.reload();
    } catch (err) {
      handleError(err);
    }
  };
  if (!me.user.capabilities.includes('evidence.access')) {
    return <Empty icon="lock" title="Evidence Access required">Your role can see conversation metadata but not message contents. Ask a Super Admin for Evidence Access if your duties require it.</Empty>;
  }
  if (!active || !reason) {
    return (
      <div className="p-4 col gap-3">
        <div className="notice warn">Viewing message contents is sensitive. You'll be asked for an investigation reason and a 2FA confirmation. Every page you load is logged.</div>
        <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={start}>View contents</button>
      </div>
    );
  }
  return (
    <>
      <div className="privileged-banner"><Icon name="eye" className="icon-sm" /> Investigation: “{reason}” <button className="link-btn small" onClick={() => ask({ force: true })}>change</button></div>
      <div className="filters">
        <input className="input" placeholder="Text contains" value={f.text || ''} onChange={(e) => paged.setFilter({ text: e.target.value || undefined })} />
        <input className="input" placeholder="Sender user ID" value={f.userId || ''} onChange={(e) => paged.setFilter({ userId: e.target.value || undefined })} />
        <input className="input" placeholder="Message ID" value={f.messageId || ''} onChange={(e) => paged.setFilter({ messageId: e.target.value || undefined })} />
        <input className="input" placeholder="Filename" value={f.filename || ''} onChange={(e) => paged.setFilter({ filename: e.target.value || undefined })} />
        <select className="input" value={f.fileType || ''} onChange={(e) => paged.setFilter({ fileType: e.target.value || undefined })} aria-label="File type">
          <option value="">Any file type</option>{['image', 'video', 'audio', 'document', 'archive', 'other'].map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input className="input" type="date" value={f.from || ''} onChange={(e) => paged.setFilter({ from: e.target.value || undefined })} aria-label="From date" />
        <input className="input" type="date" value={f.to || ''} onChange={(e) => paged.setFilter({ to: e.target.value || undefined })} aria-label="To date" />
        <select className="input" value={f.dir || 'desc'} onChange={(e) => paged.setFilter({ dir: e.target.value })} aria-label="Order"><option value="desc">Newest first</option><option value="asc">Oldest first</option></select>
      </div>
      {!paged.data ? <Loading /> : !paged.data.items.length ? <div className="p-4 small muted">No messages match.</div> : paged.data.items.map((m) => (
        <AdminMessage key={m.id} m={m} onRemove={me.user.capabilities.includes('content.remove') ? remove : null} />
      ))}
      <Pagination {...paged} />
    </>
  );
}

function MembersTab({ conv }) {
  const paged = usePaged(`/api/admin/conversations/${conv.id}/members`, { pageSize: 50 });
  return (
    <>
      <DataTable rows={paged.data?.items} columns={[
        { key: 'u', label: 'Member', primary: true, render: (m) => <Link to={`/admin/users/${m.id}`}>@{m.username}</Link> },
        { key: 'name', label: 'Name', render: (m) => m.displayName },
        { key: 'role', label: 'Role' },
        { key: 'state', label: 'State', render: (m) => <StatusTag value={m.state} /> },
        { key: 'joined', label: 'Joined', render: (m) => dateTime(m.joinedAt) },
      ]} />
      <Pagination {...paged} />
    </>
  );
}

function ReportsTab({ conv }) {
  const nav = useNavigate();
  const paged = usePaged(`/api/admin/conversations/${conv.id}/reports`, { pageSize: 25 });
  return (
    <>
      <DataTable rows={paged.data?.items} onRow={(r) => nav(`/admin/reports/${r.id}`)} empty="No reports." columns={[
        { key: 'reason', label: 'Reason', primary: true },
        { key: 'target', label: 'Target', render: (r) => r.targetType },
        { key: 'status', label: 'Status', render: (r) => <StatusTag value={r.status} /> },
        { key: 'at', label: 'Filed', render: (r) => relative(r.createdAt) },
      ]} />
      <Pagination {...paged} />
    </>
  );
}

function HistoryTab({ conv }) {
  const paged = usePaged(`/api/admin/conversations/${conv.id}/moderation`, { pageSize: 25 });
  return (
    <>
      <DataTable rows={paged.data?.items} empty="No moderation history." columns={[
        { key: 'action', label: 'Action', primary: true },
        { key: 'actor', label: 'By', render: (a) => (a.actor ? `@${a.actor}` : '—') },
        { key: 'target', label: 'Target', render: (a) => `${a.targetType} ${a.targetId.slice(-8)}` },
        { key: 'reason', label: 'Reason' },
        { key: 'at', label: 'When', render: (a) => dateTime(a.createdAt) },
      ]} />
      <Pagination {...paged} />
    </>
  );
}

export function ConversationInspector() {
  const { id } = useParams();
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const { handleError } = useApp();
  const [d, setD] = useState(null);
  const [tab, setTab] = useState(sp.get('messageId') ? 'messages' : 'members');
  useEffect(() => {
    api.get(`/api/admin/conversations/${id}`).then(setD).catch(handleError);
  }, [id, handleError]);
  if (!d) return <Loading />;
  const c = d.conversation;
  return (
    <>
      <Back onClick={() => nav(-1)} />
      <h1>{c.type === 'channel' ? '#' : ''}{c.name}</h1>
      <div className="notice info mb-3 small">{d.privacyNotice}</div>
      <div className="kpis">
        <Kpi label="Type" value={c.type === 'channel' ? c.channelType : c.type} sub={c.spaceName ? <Link to={`/admin/spaces/${c.spaceId}`}>{c.spaceName}</Link> : c.visibility} />
        <Kpi label="Members" value={formatNumber(c.memberCount)} />
        <Kpi label="Messages" value={formatNumber(c.messageCount)} sub={`${formatNumber(c.messages24h)} in 24h`} />
        <Kpi label="Storage" value={formatBytes(c.storageBytes)} sub={`${formatNumber(c.fileCount)} files`} />
      </div>
      <div className="panel-grid">
        <Panel title="Conversation">
          <dl className="kv">
            <dt>Conversation ID</dt><dd className="mono small">{c.id}</dd>
            <dt>Created</dt><dd>{dateTime(c.createdAt)}</dd>
            <dt>Last activity</dt><dd>{dateTime(c.lastMessageAt)}</dd>
            <dt>Reports</dt><dd>{c.reports}</dd>
            <dt>Settings</dt><dd>{c.locked ? 'Locked · ' : ''}{c.slowModeSeconds ? `Slow mode ${c.slowModeSeconds}s` : 'No slow mode'}</dd>
            {c.description && <><dt>Description</dt><dd>{c.description}</dd></>}
          </dl>
        </Panel>
        <Panel title="Activity (30 days)"><Chart series={fillDays(c.activity)} labels={['Messages']} height={140} /></Panel>
      </div>
      <Panel pad={false}>
        <Tabs value={tab} onChange={setTab} tabs={[['messages', 'Messages'], ['media', 'Media'], ['files', 'Files'], ['links', 'Links'], ['members', 'Members'], ['reports', 'Reports'], ['history', 'Moderation History']]} />
        {['messages', 'media', 'files', 'links'].includes(tab) && <ContentTab key={tab} conv={c} kind={tab} />}
        {tab === 'members' && <MembersTab conv={c} />}
        {tab === 'reports' && <ReportsTab conv={c} />}
        {tab === 'history' && <HistoryTab conv={c} />}
      </Panel>
    </>
  );
}

function fillDays(points) {
  const out = [];
  const day = 86400000;
  const start = Math.floor((Date.now() - 29 * day) / day);
  const map = new Map(points.map((p) => [Math.floor(p.t / day), p.value]));
  for (let i = 0; i < 30; i++) out.push({ t: (start + i) * day, value: map.get(start + i) || 0 });
  return out;
}

// ---------------------------------------------------------------------------
// Spaces

export function SpacesAdmin() {
  const nav = useNavigate();
  const paged = usePaged('/api/admin/spaces');
  const f = paged.params;
  return (
    <>
      <h1>Spaces</h1>
      <Panel pad={false}>
        <div className="filters">
          <input className="input" placeholder="Name or Space ID" value={f.q || ''} onChange={(e) => paged.setFilter({ q: e.target.value })} />
          <select className="input" value={f.visibility || ''} onChange={(e) => paged.setFilter({ visibility: e.target.value || undefined })} aria-label="Visibility"><option value="">Any visibility</option><option value="public">Public</option><option value="private">Private</option></select>
          <label className="check small"><input type="checkbox" checked={f.removed === '1'} onChange={(e) => paged.setFilter({ removed: e.target.checked ? '1' : undefined })} />Removed</label>
        </div>
        <DataTable rows={paged.data?.items} onRow={(s) => nav(`/admin/spaces/${s.id}`)} columns={[
          { key: 'name', label: 'Space', primary: true, render: (s) => <span>{s.name} {s.removed && <StatusTag value="removed" />}</span> },
          { key: 'owner', label: 'Owner', render: (s) => `@${s.ownerUsername}` },
          { key: 'vis', label: 'Visibility', render: (s) => <span className="tag">{s.visibility}{s.discoverable ? ' · listed' : ''}</span> },
          { key: 'members', label: 'Members', num: true, render: (s) => formatNumber(s.members) },
          { key: 'channels', label: 'Channels', num: true },
          { key: 'plan', label: 'Plan' },
          { key: 'created', label: 'Created', render: (s) => relative(s.createdAt) },
        ]} />
        <Pagination {...paged} />
      </Panel>
    </>
  );
}

export function SpaceAdminDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { handleError, privileged, toast, me } = useApp();
  const { ask } = useReason();
  const [d, setD] = useState(null);
  const load = useCallback(() => api.get(`/api/admin/spaces/${id}`).then(setD).catch(handleError), [id, handleError]);
  useEffect(() => {
    load();
  }, [load]);
  const caps = new Set(me.user.capabilities);
  const act = async (path, body, msg) => {
    const reason = await ask();
    if (!reason) return;
    try {
      await privileged(() => api(path, { method: body.method || 'POST', body: { ...body, method: undefined, reason }, quiet: true }));
      toast(msg);
      load();
    } catch (err) {
      handleError(err);
    }
  };
  if (!d) return <Loading />;
  const s = d.space;
  return (
    <>
      <Back onClick={() => nav('/admin/spaces')} label="Spaces" />
      <div className="row gap-3 mb-3"><Avatar name={s.name} size={56} square /><div><h1 style={{ margin: 0 }}>{s.name}</h1><div className="muted small">Owner <Link to={`/admin/users/${s.ownerId}`}>@{s.ownerUsername}</Link> · {s.visibility} · {s.plan}</div></div></div>
      <div className="row wrap mb-3">
        {caps.has('explore.manage') && s.visibility === 'public' && <button className="btn btn-sm" onClick={() => act(`/api/admin/explore/space/${s.id}`, { removed: !s.exploreRemoved }, s.exploreRemoved ? 'Restored to Explore' : 'Removed from Explore')}>{s.exploreRemoved ? 'Restore to Explore' : 'Remove from Explore'}</button>}
        {caps.has('spaces.remove') && <button className={`btn btn-sm ${s.removedAt ? '' : 'btn-danger'}`} onClick={() => act(`/api/admin/spaces/${s.id}/remove`, { restore: !!s.removedAt }, s.removedAt ? 'Space restored' : 'Space removed')}>{s.removedAt ? 'Restore Space' : 'Remove Space'}</button>}
        {caps.has('users.plan') && <button className="btn btn-sm" onClick={() => act(`/api/admin/spaces/${s.id}/plan`, { method: 'PATCH', plan: s.plan === 'pro' ? 'free' : 'pro' }, 'Plan updated')}>Set plan: {s.plan === 'pro' ? 'Free' : 'Space Pro'}</button>}
        <Link className="btn btn-sm" to={`/admin/reports?status=all&targetId=${s.id}`}>Reports</Link>
      </div>
      <div className="kpis">
        <Kpi label="Members" value={formatNumber(s.members)} />
        <Kpi label="Messages (7d)" value={formatNumber(s.messages7d)} />
        <Kpi label="Storage" value={formatBytes(s.storageBytes)} />
        <Kpi label="Reports" value={formatNumber(s.reports)} />
      </div>
      <Panel title="Channels" pad={false}>
        <DataTable rows={d.channels} onRow={(c) => nav(`/admin/conversations/${c.id}`)} columns={[
          { key: 'name', label: 'Channel', primary: true, render: (c) => <span>#{c.name} {c.isPrivate && <span className="tag warn">private</span>} {c.removed && <StatusTag value="removed" />}</span> },
          { key: 'type', label: 'Type', render: (c) => c.channelType },
          { key: 'messages', label: 'Messages', num: true, render: (c) => formatNumber(c.messageCount) },
          { key: 'last', label: 'Last activity', render: (c) => relative(c.lastMessageAt) },
        ]} />
      </Panel>
      <Panel title="Details"><dl className="kv"><dt>Space ID</dt><dd className="mono small">{s.id}</dd><dt>Created</dt><dd>{dateTime(s.createdAt)}</dd><dt>Join mode</dt><dd>{s.joinMode}</dd><dt>Description</dt><dd>{s.description || '—'}</dd></dl></Panel>
    </>
  );
}

// ---------------------------------------------------------------------------
// Files

const FILE_TABS = [['popular', 'Popular'], ['trending', 'Trending'], ['downloaded', 'Most Downloaded'], ['shared', 'Most Shared'], ['bandwidth', 'Most Bandwidth'], ['largest', 'Largest']];

export function FilesAdmin() {
  const nav = useNavigate();
  const [tab, setTab] = useState('popular');
  const paged = usePaged('/api/admin/files', { tab: 'popular' });
  const f = paged.params;
  const metric = {
    popular: ['Downloads', (x) => formatNumber(x.downloads)], trending: ['Recent downloads', (x) => <span>{formatNumber(x.recent)} <span className="tag ok">+{x.growthPct}%</span></span>],
    downloaded: ['Downloads', (x) => formatNumber(x.downloads)], shared: ['Shares', (x) => formatNumber(x.shares)],
    bandwidth: ['Bandwidth', (x) => formatBytes(x.bandwidth)], largest: ['Size', (x) => formatBytes(x.size)],
  }[tab];
  return (
    <>
      <h1>Files</h1>
      <Panel pad={false}>
        <Tabs value={tab} onChange={(t) => { setTab(t); paged.setFilter({ tab: t }); }} tabs={FILE_TABS} />
        <div className="filters">
          <input className="input" placeholder="Filename, file ID or SHA-256" value={f.q || ''} onChange={(e) => paged.setFilter({ q: e.target.value })} />
          <select className="input" value={f.type || ''} onChange={(e) => paged.setFilter({ type: e.target.value || undefined })} aria-label="Type"><option value="">All types</option>{['image', 'video', 'audio', 'document', 'archive', 'other'].map((t) => <option key={t} value={t}>{t}</option>)}</select>
          <select className="input" value={f.status || ''} onChange={(e) => paged.setFilter({ status: e.target.value || undefined })} aria-label="Status"><option value="">Any status</option>{['ok', 'restricted', 'quarantined', 'removed'].map((t) => <option key={t} value={t}>{t}</option>)}</select>
          {tab === 'trending' && <select className="input" value={f.window || '6h'} onChange={(e) => paged.setFilter({ window: e.target.value })} aria-label="Window"><option value="1h">Last hour</option><option value="6h">Last 6 hours</option><option value="24h">Last 24 hours</option></select>}
        </div>
        {tab === 'trending' && <div className="small muted" style={{ padding: '8px 16px' }}>Trending compares recent downloads with each file's own 7-day baseline. Popular reflects lifetime activity.</div>}
        <DataTable rows={paged.data?.items} onRow={(x) => nav(`/admin/files/${x.id}`)} columns={[
          { key: 'name', label: 'File', primary: true, render: (x) => <span>{x.passwordProtected ? '🔒 ' : ''}{x.filename} {x.moderationStatus !== 'ok' && <StatusTag value={x.moderationStatus} />}</span> },
          { key: 'owner', label: 'Uploader', render: (x) => `@${x.ownerUsername}` },
          { key: 'metric', label: metric[0], num: true, render: metric[1] },
          { key: 'size', label: 'Size', num: true, render: (x) => formatBytes(x.size) },
          { key: 'bw', label: 'Bandwidth', num: true, render: (x) => formatBytes(x.bandwidth) },
          { key: 'at', label: 'Uploaded', render: (x) => relative(x.createdAt) },
        ]} />
        <Pagination {...paged} />
      </Panel>
    </>
  );
}

export function FileInspector() {
  const { id } = useParams();
  const nav = useNavigate();
  const { handleError, privileged, toast, me, prompt, elevate, refreshMe } = useApp();
  const { ask } = useReason();
  const [d, setD] = useState(null);
  const [revealed, setRevealed] = useState(null);
  const caps = new Set(me.user.capabilities);
  const load = useCallback(() => api.get(`/api/admin/files/${id}`).then(setD).catch(handleError), [id, handleError]);
  useEffect(() => {
    load();
  }, [load]);
  if (!d) return <Loading />;
  const f = d.file;

  const download = async () => {
    const reason = await ask();
    if (!reason) return;
    // Browser downloads can't carry headers, so make sure the privileged session is active first.
    if (!(me.session?.elevatedUntil > Date.now())) {
      if (!(await elevate())) return;
      await refreshMe();
    }
    location.href = `/api/admin/files/${f.id}/content?reason=${encodeURIComponent(reason)}`;
  };
  const reveal = async () => {
    const reason = await ask();
    if (!reason) return;
    try {
      setRevealed(await privileged(() => api.post(`/api/admin/files/${f.id}/reveal-password`, { reason }, { quiet: true })));
    } catch (err) {
      handleError(err);
    }
  };
  const moderate = async (status) => {
    const reason = await prompt({ title: `Set file status: ${status}`, label: 'Reason (audited)', minLength: 5, multiline: true, danger: status !== 'ok' });
    if (!reason) return;
    try {
      const r = await privileged(() => api.post(`/api/admin/files/${f.id}/moderation`, { status, reason, allCopies: status === 'removed' || status === 'quarantined' }));
      toast(`Updated ${r.affected} file record(s)`);
      load();
    } catch (err) {
      handleError(err);
    }
  };

  return (
    <>
      <Back onClick={() => nav('/admin/files')} label="Files" />
      <h1 style={{ overflowWrap: 'anywhere' }}>{f.filename}</h1>
      <div className="row wrap mb-3">
        <StatusTag value={f.moderationStatus} />
        {caps.has('evidence.access') && <button className="btn btn-sm" onClick={download}><Icon name="download" className="icon-sm" /> Download</button>}
        {f.originMessageId && <Link className="btn btn-sm" to={`/admin/conversations/${f.conversation?.id}?messageId=${f.originMessageId}`}>View message</Link>}
        {f.conversation && <Link className="btn btn-sm" to={`/admin/conversations/${f.conversation.id}`}>View conversation</Link>}
        {caps.has('evidence.access') && f.passwordProtected && <button className="btn btn-sm" onClick={reveal}><Icon name="key" className="icon-sm" /> Reveal stored password</button>}
        {caps.has('content.remove') && (
          <>
            {f.moderationStatus !== 'restricted' && <button className="btn btn-sm" onClick={() => moderate('restricted')}>Restrict sharing</button>}
            {f.moderationStatus !== 'quarantined' && <button className="btn btn-sm btn-danger" onClick={() => moderate('quarantined')}>Quarantine</button>}
            {f.moderationStatus !== 'removed' && <button className="btn btn-sm btn-danger" onClick={() => moderate('removed')}>Remove</button>}
            {f.moderationStatus !== 'ok' && <button className="btn btn-sm" onClick={() => moderate('ok')}>Restore</button>}
          </>
        )}
        <Link className="btn btn-sm" to={`/admin/users/${f.uploader.id}`}>Investigate uploader</Link>
      </div>
      {revealed && (
        <div className="notice warn mb-3">
          <b>Revealed (logged):</b> {revealed.filePassword && <>file password <code>{revealed.filePassword}</code></>}
          {revealed.linkPasswords.map((l) => <div key={l.linkId}>link {l.linkId.slice(-6)}: <code>{l.password}</code></div>)}
        </div>
      )}
      <div className="kpis">
        <Kpi label="Downloads" value={formatNumber(f.downloads)} sub={`${formatNumber(f.uniqueDownloaders)} unique signed-in`} />
        <Kpi label="Shares" value={formatNumber(f.shares)} sub={`${f.attachedInMessages} messages · ${f.links.length} links`} />
        <Kpi label="Views" value={formatNumber(f.views)} />
        <Kpi label="Bandwidth" value={formatBytes(f.bandwidth)} />
        <Kpi label="Size" value={formatBytes(f.size)} />
        <Kpi label="Download velocity" value={`${formatNumber(f.velocity.h1)}/h`} sub={`${formatNumber(f.velocity.h6)} in 6h · ${formatNumber(f.velocity.h24)} in 24h`} />
      </div>
      <div className="panel-grid">
        <Panel title="File record">
          <dl className="kv">
            <dt>File ID</dt><dd className="mono small">{f.id}</dd>
            <dt>Filename</dt><dd>{f.filename}</dd>
            <dt>Uploader</dt><dd><Link to={`/admin/users/${f.uploader.id}`}>@{f.uploader.username}</Link></dd>
            <dt>Originating message</dt><dd className="mono small">{f.originMessageId || '—'}</dd>
            <dt>Conversation</dt><dd>{f.conversation ? `${f.conversation.type}: ${f.conversation.name || f.conversation.id}${f.conversation.spaceName ? ` (${f.conversation.spaceName})` : ''}` : '—'}</dd>
            <dt>Uploaded</dt><dd>{dateTime(f.createdAt)}</dd>
            <dt>MIME type</dt><dd>{f.mime}</dd>
            <dt>Category</dt><dd>{f.category}</dd>
            <dt>SHA-256</dt><dd className="mono tiny">{f.sha256}</dd>
            <dt>Same-content copies</dt><dd>{f.sameContentCopies} (stored once)</dd>
            <dt>Password protected</dt><dd>{f.passwordProtected ? 'Yes (encrypted, recoverable by Evidence Access)' : 'No'}</dd>
            <dt>Trashed / purged</dt><dd>{f.trashed ? 'In trash' : 'No'}{f.purged ? ' · purged by owner' : ''}</dd>
          </dl>
        </Panel>
        <div>
          <Panel title="Share links" pad={false}>
            <DataTable rows={f.links} empty="No links." columns={[
              { key: 'aud', label: 'Audience', primary: true, render: (l) => `${l.audience}${l.passwordProtected ? ' 🔒' : ''}` },
              { key: 'dl', label: 'Downloads', num: true, render: (l) => `${l.downloads}${l.maxDownloads ? `/${l.maxDownloads}` : ''}` },
              { key: 'exp', label: 'Expires', render: (l) => (l.expiresAt ? relative(l.expiresAt) : 'never') },
              { key: 'st', label: 'Status', render: (l) => (l.revokedAt ? <StatusTag value="revoked" /> : <StatusTag value="active" />) },
            ]} />
          </Panel>
          <Panel title="Reports & moderation">
            {!f.reports.length && !f.moderation.length && <div className="small muted">None.</div>}
            {f.reports.map((r) => <div key={r.id} className="small"><Link to={`/admin/reports/${r.id}`}>{r.reason}</Link> · <StatusTag value={r.status} /> · {relative(r.createdAt)}</div>)}
            {f.moderation.map((m, i) => <div key={i} className="small">{m.action} by @{m.actor} — {m.reason} · {relative(m.createdAt)}</div>)}
          </Panel>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Reports

export function ReportsPage() {
  const nav = useNavigate();
  const [sp] = useSearchParams();
  const paged = usePaged('/api/admin/reports', { status: sp.get('status') || 'open', targetId: sp.get('targetId') || undefined });
  const f = paged.params;
  return (
    <>
      <h1>Reports</h1>
      <Panel pad={false}>
        <div className="filters">
          <select className="input" value={f.status} onChange={(e) => paged.setFilter({ status: e.target.value })} aria-label="Status">
            {['open', 'reviewing', 'escalated', 'resolved', 'dismissed', 'all'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
          <select className="input" value={f.reason || ''} onChange={(e) => paged.setFilter({ reason: e.target.value || undefined })} aria-label="Reason">
            <option value="">Any reason</option>{REPORT_REASONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
          <select className="input" value={f.targetType || ''} onChange={(e) => paged.setFilter({ targetType: e.target.value || undefined })} aria-label="Target">
            <option value="">Any target</option>{['user', 'message', 'conversation', 'space', 'file'].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select className="input" value={f.scope || ''} onChange={(e) => paged.setFilter({ scope: e.target.value || undefined })} aria-label="Scope">
            <option value="">Site + Space</option><option value="site">Site only</option><option value="space">Inside Spaces</option>
          </select>
        </div>
        <DataTable rows={paged.data?.items} onRow={(r) => nav(`/admin/reports/${r.id}`)} empty="No reports — nice." columns={[
          { key: 'reason', label: 'Reason', primary: true, render: (r) => <span>{(REPORT_REASONS.find(([k]) => k === r.reason) || [])[1] || r.reason}{r.reason === 'child_safety' && <> <span className="tag danger">priority</span></>}</span> },
          { key: 'target', label: 'Target', render: (r) => <span className="tag">{r.targetType}</span> },
          { key: 'reporter', label: 'Reporter', render: (r) => `@${r.reporter}` },
          { key: 'status', label: 'Status', render: (r) => <StatusTag value={r.status} /> },
          { key: 'at', label: 'Filed', render: (r) => relative(r.createdAt) },
        ]} />
        <Pagination {...paged} />
      </Panel>
    </>
  );
}

export function ReportDetail() {
  const { id } = useParams();
  const nav = useNavigate();
  const { handleError, privileged, toast, prompt, me } = useApp();
  const [d, setD] = useState(null);
  const caps = new Set(me.user.capabilities);
  const load = useCallback(() => api.get(`/api/admin/reports/${id}`).then(setD).catch(handleError), [id, handleError]);
  useEffect(() => {
    load();
  }, [load]);
  if (!d) return <Loading />;
  const r = d.report;
  const setStatus = async (status) => {
    const resolution = await prompt({ title: `Mark report ${status}`, label: 'Resolution note', multiline: true });
    if (resolution === null) return;
    try {
      await api.patch(`/api/admin/reports/${r.id}`, { status, resolution });
      toast('Report updated');
      load();
    } catch (err) {
      handleError(err);
    }
  };
  const act = async (label, path, extra = {}) => {
    const reason = await prompt({ title: label, label: 'Reason (audited, shown to the user where applicable)', minLength: 5, multiline: true, defaultValue: `Report ${r.id}: ${r.reason}`, danger: true });
    if (!reason) return;
    try {
      await privileged(() => api.post(path, { reason, reportId: r.id, ...extra }));
      toast('Action taken');
      load();
    } catch (err) {
      handleError(err);
    }
  };
  const ev = r.evidence;
  const userId = r.targetType === 'user' ? r.targetId : ev.message?.sender?.id || d.target?.senderId || ev.file?.ownerId;
  return (
    <>
      <Back onClick={() => nav('/admin/reports')} label="Reports" />
      <h1>Report · {(REPORT_REASONS.find(([k]) => k === r.reason) || [])[1] || r.reason}</h1>
      <div className="row wrap mb-3">
        <StatusTag value={r.status} />
        <span className="small muted">Filed {dateTime(r.createdAt)} by @{r.reporter} · {d.relatedReports} other reports on this target</span>
      </div>
      <div className="row wrap mb-3">
        <button className="btn btn-sm" onClick={() => setStatus('reviewing')}>Start review</button>
        <button className="btn btn-sm" onClick={() => setStatus('resolved')}>Resolve</button>
        <button className="btn btn-sm" onClick={() => setStatus('dismissed')}>Dismiss</button>
        {caps.has('reports.escalate') && <button className="btn btn-sm" onClick={() => setStatus('escalated')}>Escalate to Admins</button>}
      </div>
      <div className="panel-grid">
        <Panel title="Submitted evidence">
          {r.details && <p><b>Reporter says:</b> {r.details}</p>}
          {ev.message && (
            <>
              <div className="label mb-3">Context the reporter could see</div>
              {(ev.context || [ev.message]).map((m) => (
                <div key={m.id} className="evidence mb-3" style={m.id === ev.message.id ? { outline: '2px solid var(--warn)' } : undefined}>
                  <div className="tiny faint">@{m.sender?.username} · {dateTime(m.createdAt)}</div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{m.body || m.attachments?.map((a) => `📎 ${a.filename}`).join(', ') || `[${m.kind}]`}</div>
                </div>
              ))}
            </>
          )}
          {ev.user && <div className="evidence"><b>@{ev.user.username}</b> ({ev.user.displayName})<div className="small">{ev.user.bio}</div><div className="small">{ev.user.statusText}</div></div>}
          {ev.file && <div className="evidence">📎 <Link to={`/admin/files/${ev.file.id}`}>{ev.file.filename}</Link> · {formatBytes(ev.file.size)} · <span className="mono tiny">{ev.file.sha256?.slice(0, 16)}…</span></div>}
          {ev.space && <div className="evidence">Space <Link to={`/admin/spaces/${ev.space.id}`}>{ev.space.name}</Link><div className="small">{ev.space.description}</div></div>}
          {ev.conversation && <div className="evidence">{ev.conversation.type} <Link to={`/admin/conversations/${ev.conversation.id}`}>{ev.conversation.name || ev.conversation.id}</Link></div>}
        </Panel>
        <Panel title="Actions">
          <div className="col">
            {userId && <Link className="btn btn-sm" to={`/admin/users/${userId}`}>Open user</Link>}
            {r.conversationId && <Link className="btn btn-sm" to={`/admin/conversations/${r.conversationId}${r.targetType === 'message' ? `?messageId=${r.targetId}` : ''}`}>Open conversation inspector</Link>}
            {userId && caps.has('users.warn') && <button className="btn btn-sm" onClick={() => act('Warn user', `/api/admin/users/${userId}/warn`)}>Warn user</button>}
            {userId && caps.has('users.restrict') && <button className="btn btn-sm" onClick={() => act('Restrict user 24h', `/api/admin/users/${userId}/restrict`, { hours: 24 })}>Restrict 24h</button>}
            {userId && caps.has('users.suspend') && <button className="btn btn-sm btn-danger" onClick={() => act('Suspend user 7 days', `/api/admin/users/${userId}/suspend`, { hours: 168 })}>Suspend 7 days</button>}
            {userId && caps.has('users.ban') && <button className="btn btn-sm btn-danger" onClick={() => act('Ban user', `/api/admin/users/${userId}/ban`)}>Ban user</button>}
            {r.targetType === 'message' && caps.has('content.remove') && !d.target?.deleted && <button className="btn btn-sm btn-danger" onClick={() => act('Remove message', `/api/admin/messages/${r.targetId}/remove`)}>Remove message</button>}
            {r.targetType === 'file' && caps.has('content.remove') && <button className="btn btn-sm btn-danger" onClick={() => act('Quarantine file', `/api/admin/files/${r.targetId}/moderation`, { status: 'quarantined', allCopies: true })}>Quarantine file</button>}
            {r.targetType === 'space' && caps.has('explore.manage') && <button className="btn btn-sm" onClick={() => act('Remove from Explore', `/api/admin/explore/space/${r.targetId}`, { removed: true })}>Remove Space from Explore</button>}
            {r.targetType === 'space' && caps.has('spaces.remove') && <button className="btn btn-sm btn-danger" onClick={() => act('Remove Space', `/api/admin/spaces/${r.targetId}/remove`)}>Remove Space</button>}
          </div>
          {d.actions.length > 0 && <><div className="label mt-3">Actions on this report</div>{d.actions.map((a, i) => <div key={i} className="small">{a.action} by @{a.actor} · {relative(a.createdAt)}{a.reason ? ` — ${a.reason}` : ''}</div>)}</>}
          {r.resolution && <div className="notice mt-3 small"><b>Resolution:</b> {r.resolution}</div>}
        </Panel>
      </div>
    </>
  );
}

