import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../store.jsx';
import { Panes } from '../components/Shell.jsx';
import Conversation from '../components/Conversation.jsx';
import { Avatar, Empty, Icon, IconButton, Loading } from '../components/ui.jsx';
import { timeShort } from '../utils.js';

export function ChatList({ activeId }) {
  const { conversations, spaces, me } = useApp();
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const list = useMemo(() => {
    let l = conversations || [];
    if (filter === 'unread') l = l.filter((c) => c.unread > 0);
    if (filter === 'dm') l = l.filter((c) => c.type === 'dm');
    if (filter === 'group') l = l.filter((c) => c.type === 'group');
    if (q.trim()) {
      const s = q.trim().toLowerCase();
      l = l.filter((c) => c.name.toLowerCase().includes(s) || c.otherUser?.username?.toLowerCase().includes(s));
    }
    return l;
  }, [conversations, filter, q]);

  return (
    <>
      <header className="pane-header">
        <h1>Chats</h1>
        <IconButton icon="bell" label="Notifications" onClick={() => nav('/notifications')} className="hide-tablet" />
        <IconButton icon="plus" label="New chat" onClick={() => nav('/new')} />
      </header>
      <div className="pane-body">
        {spaces?.length > 0 && (
          <div className="spaces-strip" aria-label="Your Spaces">
            {spaces.map((s) => (
              <Link key={s.id} to={`/spaces/${s.id}`}>
                <Avatar name={s.name} fileId={s.iconFileId} size={52} square />
                <span className="ellipsis" style={{ width: '100%' }}>{s.name}</span>
                {s.unread > 0 && <span className="badge">{s.unread}</span>}
              </Link>
            ))}
          </div>
        )}
        <div style={{ padding: '10px 16px 0' }}>
          <div className="search"><Icon name="search" className="icon-sm" /><input placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search chats" /></div>
        </div>
        <div className="chips">
          {[['all', 'All'], ['unread', 'Unread'], ['dm', 'Direct'], ['group', 'Groups']].map(([k, l]) => (
            <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{l}</button>
          ))}
        </div>
        {!conversations ? <Loading /> : !list.length ? (
          <Empty icon="chat" title={q || filter !== 'all' ? 'Nothing found' : 'No conversations yet'} action={!q && filter === 'all' && <Link className="btn btn-primary" to="/new">Start a conversation</Link>}>
            {!q && filter === 'all' && 'Find people or groups to message, or join a Space from Explore.'}
          </Empty>
        ) : (
          <div className="list" role="list">
            {list.map((c) => (
              <Link key={c.id} to={`/chats/${c.id}`} className={`list-item ${activeId === c.id ? 'active' : ''}`} role="listitem">
                <Avatar name={c.name} fileId={c.avatarFileId} online={c.otherUser?.online} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row between">
                    <b className="ellipsis">{c.name}</b>
                    <span className="tiny faint" style={{ flex: 'none' }}>{timeShort(c.lastMessage?.createdAt || c.lastMessageAt)}</span>
                  </div>
                  <div className="row between">
                    <span className="small muted ellipsis">
                      {c.lastMessage ? `${c.type !== 'dm' && c.lastMessage.senderName ? `${c.lastMessage.senderId === me.user.id ? 'You' : c.lastMessage.senderName}: ` : c.lastMessage.senderId === me.user.id ? 'You: ' : ''}${c.lastMessage.text}` : c.type === 'group' ? `${c.memberCount} members` : 'No messages yet'}
                    </span>
                    <span className="row" style={{ gap: 4, flex: 'none' }}>
                      {c.muted && <Icon name="mute" className="icon-sm faint" />}
                      {c.unread > 0 && <span className={`badge ${c.muted ? 'muted-badge' : ''}`}>{c.unread > 99 ? '99+' : c.unread}</span>}
                    </span>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

export default function ChatsPage() {
  const { id } = useParams();
  const nav = useNavigate();
  return (
    <Panes
      detail={!!id}
      list={<ChatList activeId={id} />}
      main={id ? <Conversation key={id} id={id} onBack={() => nav('/chats')} /> : <Empty icon="chat" title="Select a conversation">Choose a chat from the list, or start a new one.</Empty>}
    />
  );
}
