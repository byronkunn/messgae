import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../../api.js';
import { useApp } from '../../store.jsx';
import { Loading, Tabs } from '../../components/ui.jsx';
import { DataTable, Kpi, Panel, RangePicker } from './common.jsx';
import { BarList, Chart } from './Charts.jsx';
import { compactNumber, formatBytes, formatNumber } from '../../utils.js';

export function StoragePage() {
  const { handleError } = useApp();
  const [d, setD] = useState(null);
  useEffect(() => {
    api.get('/api/admin/storage').then(setD).catch(handleError);
  }, [handleError]);
  if (!d) return <Loading />;
  const f = d.forecast;
  return (
    <>
      <h1>Storage</h1>
      <div className="kpis">
        <Kpi label="Current storage" value={formatBytes(f.currentBytes)} sub={`${formatBytes(f.physicalBytes)} physical after dedup`} />
        <Kpi label="Growth" value={`+${formatBytes(f.growthPerWeekBytes)}/week`} />
        <Kpi label="Estimated in 90 days" value={formatBytes(f.estimate90dBytes)} sub={`${formatBytes(f.estimate180dBytes)} in 180 days`} />
        <Kpi label="Files" value={compactNumber(d.totals.files)} sub={`avg ${formatBytes(d.totals.averageFileSize)}`} />
        <Kpi label="Uploads (30d)" value={compactNumber(d.totals.uploads30d)} />
        <Kpi label="Downloads (30d)" value={compactNumber(d.totals.downloads30d)} />
        <Kpi label="Bandwidth (30d)" value={formatBytes(d.totals.bandwidth30d)} />
        <Kpi label="In trash" value={formatBytes(d.totals.trashBytes)} />
      </div>
      <Panel title="Storage growth (28 days) and forecast basis"><Chart series={f.daily} labels={['Stored bytes']} bytes /></Panel>
      <div className="panel-grid">
        <Panel title="Storage by file type"><BarList rows={d.byType} label={(r) => r.category} value={(r) => r.bytes} format={formatBytes} /></Panel>
        <Panel title="Storage by account tier"><BarList rows={d.byPlan} label={(r) => `${r.plan} (${formatNumber(r.users)} users)`} value={(r) => r.bytes} format={formatBytes} /></Panel>
        <Panel title="Largest accounts" pad={false}>
          <DataTable rows={d.largestAccounts} columns={[
            { key: 'u', label: 'User', primary: true, render: (r) => <Link to={`/admin/users/${r.id}`}>@{r.username}</Link> },
            { key: 'files', label: 'Files', num: true, render: (r) => formatNumber(r.files) },
            { key: 'bytes', label: 'Storage', num: true, render: (r) => formatBytes(r.bytes) },
          ]} />
        </Panel>
        <Panel title="Largest groups & Spaces" pad={false}>
          <DataTable rows={[...d.largestGroups.map((g) => ({ ...g, kind: 'group' })), ...d.largestSpaces.map((s) => ({ ...s, kind: 'space' }))].sort((a, b) => b.bytes - a.bytes).slice(0, 10)} columns={[
            { key: 'n', label: 'Name', primary: true, render: (r) => <Link to={r.kind === 'space' ? `/admin/spaces/${r.id}` : `/admin/conversations/${r.id}`}>{r.name}</Link> },
            { key: 'k', label: 'Kind', render: (r) => r.kind },
            { key: 'b', label: 'Shared storage', num: true, render: (r) => formatBytes(r.bytes) },
          ]} />
        </Panel>
      </div>
    </>
  );
}

const SECTIONS = [['users', 'Users'], ['messaging', 'Messaging'], ['groups', 'Groups'], ['spaces', 'Spaces'], ['storage', 'Storage'], ['bandwidth', 'Bandwidth'], ['engagement', 'Engagement'], ['revenue', 'Revenue'], ['moderation', 'Moderation'], ['security', 'Security']];

const KPI_LABELS = {
  totalUsers: 'Total users', dau: 'Daily active users', wau: 'Weekly active users', mau: 'Monthly active users', newRegistrations: 'New registrations', returningUsers: 'Returning users',
  messagesPerHour: 'Messages / hour', messagesPerDay: 'Messages / day', messagesPerMonth: 'Messages / month', dmsCreated: 'DMs created', groupsCreated: 'Groups created',
  activeConversations: 'Active conversations', replies: 'Replies', reactions: 'Reactions', attachments: 'Attachments', totalGroups: 'Total groups', newGroups: 'New groups',
  activeGroups: 'Active groups', publicGroups: 'Public groups', averageMembers: 'Avg members', totalSpaces: 'Total Spaces', newSpaces: 'New Spaces', publicSpaces: 'Public Spaces',
  discoverable: 'In Explore', channels: 'Channels', spacePro: 'Space Pro', totalStorage: 'Total storage', physicalStorage: 'Physical storage', dedupSavings: 'Dedup savings',
  growthPerWeek: 'Growth / week', estimate90d: '90-day estimate', uploads: 'Uploads', averageFileSize: 'Average file size', bandwidth: 'Bandwidth', downloads: 'Downloads',
  linkDownloads: 'Link downloads', views: 'Media views', stickiness: 'DAU / MAU %', messagesPerSender: 'Messages / sender', reactionsPerMessage: 'Reactions / message',
  replyRate: 'Reply rate %', pollVotes: 'Poll votes', shareLinksCreated: 'Share links created', plusSubscribers: 'Plus subscribers', spaceProSubscriptions: 'Space Pro',
  estimatedMrr: 'Estimated MRR ($)', conversionRate: 'Plus conversion %', reportsFiled: 'Reports filed', open: 'Open reports', escalated: 'Escalated', resolved: 'Resolved',
  actions: 'Moderation actions', medianHoursToResolve: 'Median hours to resolve', failedLogins: 'Failed logins', logins: 'Logins', lockedAccounts: 'Locked accounts',
  recoveryRotations: 'Recovery key rotations', staffWithout2fa: 'Staff without 2FA', privilegedElevations: 'Privileged sessions',
};
const BYTE_KPIS = new Set(['totalStorage', 'physicalStorage', 'dedupSavings', 'growthPerWeek', 'estimate90d', 'averageFileSize', 'bandwidth']);

const CHART_META = {
  registrations: ['New registrations'], activeSenders: ['Active senders'], messages: ['Messages', 'With attachments'], reactions: ['Reactions'], created: ['Created'],
  uploads: ['Uploads', 'Bytes'], cumulative: ['Stored bytes'], bandwidth: ['Bytes served', 'Requests'], senders: ['Active senders'], reports: ['Reports'], logins: ['Logins', 'Failed'],
};

function TrendingPanel() {
  const [type, setType] = useState('groups');
  const [win, setWin] = useState('24h');
  const [d, setD] = useState(null);
  useEffect(() => {
    setD(null);
    api.get(`/api/admin/trending?type=${type}&window=${win}`).then(setD).catch(() => setD({ items: [] }));
  }, [type, win]);
  const link = (r) => (type === 'files' ? `/admin/files/${r.id}` : type === 'spaces' ? `/admin/spaces/${r.id}` : `/admin/conversations/${r.id}`);
  return (
    <Panel title="Trending now" actions={
      <div className="row wrap">
        <div className="segmented">{[['files', 'Files'], ['groups', 'Groups'], ['spaces', 'Spaces'], ['channels', 'Channels']].map(([k, l]) => <button key={k} className={type === k ? 'on' : ''} onClick={() => setType(k)}>{l}</button>)}</div>
        <div className="segmented">{['1h', '6h', '24h'].map((k) => <button key={k} className={win === k ? 'on' : ''} onClick={() => setWin(k)}>{k}</button>)}</div>
      </div>
    } pad={false}>
      <p className="small muted" style={{ padding: '8px 16px 0' }}>Trending = recent activity compared with each item's own baseline over the previous 7 days. Popular (lifetime) rankings are in Files and Communications.</p>
      <DataTable rows={d?.items} empty="Nothing trending in this window." columns={[
        { key: 'name', label: 'Name', primary: true, render: (r) => <Link to={link(r)}>{r.name}</Link> },
        { key: 'recent', label: type === 'files' ? 'Downloads' : 'Messages', num: true, render: (r) => formatNumber(r.recent) },
        { key: 'exp', label: 'Expected', num: true, render: (r) => formatNumber(r.expected) },
        { key: 'growth', label: 'Change', num: true, render: (r) => <span className={r.growthPct >= 0 ? 'ok-text' : 'danger-text'}>{r.growthPct >= 0 ? '+' : ''}{formatNumber(r.growthPct)}%</span> },
      ]} />
    </Panel>
  );
}

export function AnalyticsPage() {
  const { handleError } = useApp();
  const [section, setSection] = useState('users');
  const [range, setRange] = useState({ range: '30d' });
  const [d, setD] = useState(null);
  useEffect(() => {
    setD(null);
    api.get(`/api/admin/analytics${qs({ section, ...range })}`).then(setD).catch(handleError);
  }, [section, range, handleError]);
  return (
    <>
      <div className="row between wrap mb-3"><h1 style={{ margin: 0 }}>Analytics</h1><RangePicker value={range} onChange={setRange} /></div>
      <div className="panel" style={{ overflow: 'visible' }}><Tabs value={section} onChange={setSection} tabs={SECTIONS} /></div>
      {!d ? <Loading /> : (
        <>
          <div className="kpis">
            {Object.entries(d.kpis).map(([k, v]) => <Kpi key={k} label={KPI_LABELS[k] || k} value={BYTE_KPIS.has(k) ? formatBytes(v) : compactNumber(v)} />)}
          </div>
          {Object.entries(d.charts).map(([k, s]) => {
            const keys = Object.keys(s[0] || { value: 0 }).filter((x) => x !== 't');
            const bytes = k === 'cumulative' || k === 'bandwidth';
            return <Panel key={k} title={CHART_META[k]?.[0] || k}><Chart series={s} keys={k === 'uploads' || k === 'bandwidth' ? ['value'] : keys} labels={CHART_META[k]} bytes={bytes} /></Panel>;
          })}
          <div className="panel-grid">
            {Object.entries(d.tables).map(([k, rows]) => (
              <Panel key={k} title={k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}>
                {k === 'note' ? <div className="small muted">{rows[0].message}</div> : (
                  <BarList rows={rows} label={(r) => r.name || r.category || r.reason || r.action || r.channel_type || r.plan || r.ip || r.filename || r.kind} value={(r) => r.members ?? r.count ?? r.bytes ?? r.files ?? 0} format={(v) => (rows[0]?.bytes !== undefined ? formatBytes(v) : compactNumber(v))} />
                )}
              </Panel>
            ))}
          </div>
          {section === 'storage' && <div className="notice info small">Forecast uses a least-squares fit of the last 28 days of logical storage growth.</div>}
        </>
      )}
      {(section === 'messaging' || section === 'groups' || section === 'spaces' || section === 'bandwidth') && <div className="mt-4"><TrendingPanel /></div>}
    </>
  );
}
