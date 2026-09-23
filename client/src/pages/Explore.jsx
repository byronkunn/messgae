import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, qs } from '../api.js';
import { useApp } from '../store.jsx';
import { Panes } from '../components/Shell.jsx';
import { Avatar, Empty, Icon, IconButton, Loading, Modal, Field } from '../components/ui.jsx';
import { compactNumber, TOPICS } from '../utils.js';

const TABS = [['for-you', 'For You'], ['trending', 'Trending'], ['spaces', 'Spaces'], ['groups', 'Groups'], ['channels', 'Channels'], ['topics', 'Topics'], ['new', 'New']];

function ResultCard({ item, onOpen }) {
  const title = item.kind === 'person' ? item.displayName : item.kind === 'channel' ? `#${item.name}` : item.name;
  const sub = item.kind === 'person' ? `@${item.username}` : item.kind === 'channel' ? `in ${item.spaceName}` : `${compactNumber(item.memberCount)} members`;
  return (
    <button className="discover-card" onClick={() => onOpen(item)}>
      <div className="cover" />
      <div className="body">
        <Avatar name={item.kind === 'channel' ? item.spaceName : title} fileId={item.iconFileId || item.avatarFileId || item.spaceIconFileId} size={48} square={item.kind !== 'person' && item.kind !== 'group'} />
        <div className="row between">
          <b className="ellipsis">{title}</b>
          <span className="tag">{item.kind}</span>
        </div>
        <div className="small muted">{sub}{item.activity24h !== undefined ? ` · ${compactNumber(item.activity24h)} msgs today` : ''}</div>
        {(item.description || item.bio) && <div className="small" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{item.description || item.bio}</div>}
        <div className="row wrap" style={{ gap: 4 }}>
          {item.topic && TOPICS[item.topic] && <span className="tag">{TOPICS[item.topic].emoji} {TOPICS[item.topic].label}</span>}
          {item.joinMode === 'approval' && <span className="tag warn">Approval</span>}
          {item.trend?.growthPct > 50 && item.activity24h > 0 && <span className="tag ok">▲ {item.trend.growthPct}%</span>}
          {item.isMember && <span className="tag accent">Joined</span>}
        </div>
      </div>
    </button>
  );
}

function Filters({ value, onChange, onClose }) {
  const [f, setF] = useState(value);
  const set = (k, v) => setF({ ...f, [k]: f[k] === v ? '' : v });
  const Chips = ({ k, options }) => (
    <div className="chips" style={{ padding: 0, flexWrap: 'wrap' }}>
      {options.map(([v, l]) => <button key={v} className={`chip ${f[k] === v ? 'on' : ''}`} onClick={() => set(k, v)}>{l}</button>)}
    </div>
  );
  return (
    <Modal title="Filters" onClose={onClose} footer={<><button className="btn" onClick={() => { onChange({}); onClose(); }}>Reset</button><button className="btn btn-primary" onClick={() => { onChange(f); onClose(); }}>Apply</button></>}>
      <Field label="Type"><Chips k="types" options={[['space', 'Spaces'], ['group', 'Groups'], ['channel', 'Channels'], ['person', 'People']]} /></Field>
      <Field label="Topic"><Chips k="topic" options={Object.entries(TOPICS).map(([k, t]) => [k, `${t.emoji} ${t.label}`])} /></Field>
      <Field label="Size"><Chips k="size" options={[['small', 'Under 50'], ['medium', '50–1,000'], ['large', '1,000+']]} /></Field>
      <Field label="Activity"><Chips k="activity" options={[['quiet', 'Quiet'], ['active', 'Active'], ['very_active', 'Very active']]} /></Field>
      <Field label="Membership"><Chips k="membership" options={[['open', 'Open membership'], ['approval', 'Approval required']]} /></Field>
      <Field label="Sort"><Chips k="sort" options={[['newest', 'Newest'], ['most_active', 'Most active'], ['members', 'Most members']]} /></Field>
      <Field label="Language"><input className="input" value={f.language || ''} placeholder="e.g. en" onChange={(e) => setF({ ...f, language: e.target.value })} maxLength={8} /></Field>
    </Modal>
  );
}

export default function ExplorePage() {
  const nav = useNavigate();
  const { handleError } = useApp();
  const [tab, setTab] = useState('for-you');
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState({});
  const [showFilters, setShowFilters] = useState(false);
  const [data, setData] = useState(null);
  const [more, setMore] = useState(false);

  useEffect(() => {
    setData(null);
    const t = setTimeout(() => {
      api.get(`/api/explore${qs({ tab, q, ...filters })}`).then(setData).catch((err) => { handleError(err); setData({ items: [] }); });
    }, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [tab, q, filters, handleError]);

  const loadMore = async () => {
    setMore(true);
    try {
      const r = await api.get(`/api/explore${qs({ tab, q, ...filters, offset: data.nextOffset })}`);
      setData({ ...r, items: [...data.items, ...r.items] });
    } finally {
      setMore(false);
    }
  };

  const open = (item) => {
    if (item.kind === 'space') nav(`/spaces/${item.id}`);
    else if (item.kind === 'group') nav(`/chats/${item.id}`);
    else if (item.kind === 'channel') nav(`/spaces/${item.spaceId}/c/${item.id}`);
    else if (item.kind === 'person') nav(`/u/${item.username}`);
  };

  const activeFilters = Object.values(filters).filter(Boolean).length;
  const main = (
    <>
      <header className="pane-header">
        <h1>Explore</h1>
      </header>
      <div className="pane-body">
        <div className="row" style={{ padding: '12px 16px 4px' }}>
          <div className="search grow"><Icon name="search" className="icon-sm" /><input placeholder="Search groups, Spaces, channels, topics or people" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search Explore" /></div>
          <IconButton icon="settings" label="Filters" onClick={() => setShowFilters(true)} active={activeFilters > 0} />
        </div>
        <div className="tabs">{TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</div>
        {!data ? <Loading /> : data.topics ? (
          <div className="topic-grid">
            {data.topics.map((t) => (
              <button key={t.topic} className="topic-tile" onClick={() => { setFilters({ ...filters, topic: t.topic }); setTab('spaces'); }}>
                <div className="emoji">{TOPICS[t.topic]?.emoji}</div>
                <b>{TOPICS[t.topic]?.label}</b>
                <div className="tiny muted">{t.spaces} Spaces · {t.groups} groups</div>
              </button>
            ))}
          </div>
        ) : !data.items.length ? (
          <Empty icon="compass" title="Nothing to show yet">
            {q ? 'Try a different search or remove filters.' : 'Public Spaces and groups appear here when their owners make them discoverable.'}
          </Empty>
        ) : (
          <>
            <div className="card-grid">{data.items.map((i) => <ResultCard key={`${i.kind}-${i.id}`} item={i} onOpen={open} />)}</div>
            {data.nextOffset !== null && data.nextOffset !== undefined && <div className="center mb-3"><button className="btn" disabled={more} onClick={loadMore}>Load more</button></div>}
          </>
        )}
      </div>
      {showFilters && <Filters value={filters} onChange={setFilters} onClose={() => setShowFilters(false)} />}
    </>
  );
  return <Panes single main={main} />;
}
