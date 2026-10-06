import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApp, useRealtime } from '../store.jsx';
import { Panes } from '../components/Shell.jsx';
import { Avatar, Empty, Icon, IconButton, Loading, PaneHeader } from '../components/ui.jsx';
import { relative } from '../utils.js';

function describe(n) {
  const d = n.data;
  const from = d.from?.displayName || 'Someone';
  switch (n.type) {
    case 'mention': return { icon: 'chat', text: `${from} mentioned ${d.everyone ? 'everyone' : 'you'}${d.conversationName ? ` in ${d.conversationName}` : ''}`, sub: d.snippet };
    case 'reply': return { icon: 'reply', text: `${from} replied to you${d.conversationName ? ` in ${d.conversationName}` : ''}`, sub: d.snippet };
    case 'contact_added': return { icon: 'user', text: `${from} added you as a contact` };
    case 'group_added': return { icon: 'users', text: `${from} added you to ${d.conversationName}` };
    case 'join_request': return { icon: 'users', text: `${from} asked to join ${d.conversationName || d.spaceName}` };
    case 'join_approved': return { icon: 'check', text: `Your request to join ${d.conversationName || d.spaceName} was approved` };
    case 'space_owner': return { icon: 'crown', text: `You are now the owner of ${d.spaceName}` };
    case 'report_update': return { icon: 'flag', text: `Your report was ${d.status}. Thank you for helping keep the community safe.` };
    case 'escalation': return { icon: 'shield', text: `Report escalated by @${d.from}: ${d.reason}` };
    case 'security': return { icon: 'shield', text: d.message };
    case 'moderation': {
      const what = {
        warning: 'You received a warning from moderators', restricted: 'Your account was temporarily restricted', timeout: `You were timed out in ${d.spaceName}`,
        message_removed: 'A message you sent was removed', space_removed: `Your Space ${d.spaceName} was removed`,
        file_removed: `Your file ${d.filename} was removed`, file_quarantined: `Your file ${d.filename} was quarantined for review`,
      }[d.action] || 'Moderation notice';
      return { icon: 'shield', text: what, sub: d.reason };
    }
    default: return { icon: 'bell', text: 'Notification' };
  }
}

export default function NotificationsPage() {
  const { handleError, setMe } = useApp();
  const nav = useNavigate();
  const [items, setItems] = useState(null);
  const [cursor, setCursor] = useState(null);
  const load = useCallback(async (before) => {
    try {
      const r = await api.get(`/api/notifications${before ? `?before=${encodeURIComponent(before)}` : ''}`);
      setItems((list) => (before ? [...(list || []), ...r.notifications] : r.notifications));
      setCursor(r.nextCursor);
      setMe((m) => (m ? { ...m, unread: { ...m.unread, notifications: r.unread } } : m));
    } catch (err) {
      handleError(err);
    }
  }, [handleError, setMe]);
  useEffect(() => {
    load();
  }, [load]);
  useRealtime((e) => e.type === 'notification' && setItems((l) => [e.notification, ...(l || [])]), []);

  const open = async (n) => {
    if (!n.readAt) api.post(`/api/notifications/${n.id}/read`).catch(() => {});
    setItems((l) => l.map((x) => (x.id === n.id ? { ...x, readAt: Date.now() } : x)));
    setMe((m) => ({ ...m, unread: { ...m.unread, notifications: Math.max(0, (m.unread?.notifications || 1) - (n.readAt ? 0 : 1)) } }));
    const d = n.data;
    if (d.spaceId && d.conversationId) nav(`/spaces/${d.spaceId}/c/${d.conversationId}${d.threadId ? `/t/${d.threadId}` : ''}`);
    else if (d.conversationId) nav(`/chats/${d.conversationId}`);
    else if (d.spaceId) nav(`/spaces/${d.spaceId}`);
    else if (n.type === 'escalation') nav(`/admin/reports/${d.reportId}`);
    else if (d.from?.username) nav(`/u/${d.from.username}`);
  };
  const readAll = async () => {
    await api.post('/api/notifications/read-all').catch(handleError);
    load();
  };

  const main = (
    <>
      <PaneHeader title="Notifications" onBack={() => nav(-1)} back="always">
        <IconButton icon="checks" label="Mark all read" onClick={readAll} />
      </PaneHeader>
      <div className="pane-body">
        {!items ? <Loading /> : !items.length ? <Empty icon="bell" title="You're all caught up" /> : (
          <div className="list content-narrow">
            {items.map((n) => {
              const d = describe(n);
              return (
                <button key={n.id} className={`list-item ${n.readAt ? '' : 'active'}`} onClick={() => open(n)}>
                  {n.data.from?.displayName ? <Avatar name={n.data.from.displayName} fileId={n.data.from.avatarFileId} size={40} /> : <span className="center" style={{ width: 40, height: 40, borderRadius: 20, background: 'var(--bg-2)' }}><Icon name={d.icon} /></span>}
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className={n.readAt ? '' : 'bold'}>{d.text}</div>
                    {d.sub && <div className="small muted ellipsis">{d.sub}</div>}
                    <div className="tiny faint">{relative(n.createdAt)}</div>
                  </div>
                </button>
              );
            })}
            {cursor && <div className="center p-4"><button className="btn" onClick={() => load(cursor)}>Load more</button></div>}
          </div>
        )}
      </div>
    </>
  );
  return <Panes detail single main={main} />;
}
