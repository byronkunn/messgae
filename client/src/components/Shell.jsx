import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useApp } from '../store.jsx';
import { Avatar, Icon } from './ui.jsx';

/** Two-pane layout primitive: list | main. On phones only one pane shows at a time. */
export function Panes({ list, main, detail = false, single = false }) {
  return (
    <div className="panes" data-detail={String(detail)} data-single={String(single)}>
      {list && <aside className="list-pane">{list}</aside>}
      <main className="main-pane">{main}</main>
    </div>
  );
}

function Rail() {
  const { me, spaces, conversations } = useApp();
  const unreadChats = (conversations || []).reduce((a, c) => a + (c.muted ? 0 : c.unread || 0), 0);
  const staff = me?.user?.capabilities?.includes('admin.access');
  return (
    <nav className="rail" aria-label="Main">
      <NavLink to="/chats" title="Chats" className={({ isActive }) => (isActive ? 'on' : '')}>
        <Icon name="chat" />
        {unreadChats > 0 && <span className="badge">{unreadChats > 99 ? '99+' : unreadChats}</span>}
      </NavLink>
      <NavLink to="/explore" title="Explore" className={({ isActive }) => (isActive ? 'on' : '')}><Icon name="compass" /></NavLink>
      <NavLink to="/files" title="Files" className={({ isActive }) => (isActive ? 'on' : '')}><Icon name="folder" /></NavLink>
      <div className="rail-sep" />
      {(spaces || []).map((s) => (
        <NavLink key={s.id} to={`/spaces/${s.id}`} title={s.name} className={({ isActive }) => (isActive ? 'on' : '')} style={{ padding: 0, overflow: 'visible' }}>
          <Avatar name={s.name} fileId={s.iconFileId} size={48} square />
          {s.unread > 0 && <span className="badge">{s.unread > 99 ? '99+' : s.unread}</span>}
        </NavLink>
      ))}
      <NavLink to="/new" title="Create or join" className={({ isActive }) => (isActive ? 'on' : '')}><Icon name="plus" /></NavLink>
      <div className="rail-bottom">
        {staff && <NavLink to="/admin" title="Admin"><Icon name="shield" /></NavLink>}
        <NavLink to="/notifications" title="Notifications" className={({ isActive }) => (isActive ? 'on' : '')}>
          <Icon name="bell" />
          {me?.unread?.notifications > 0 && <span className="badge">{me.unread.notifications > 99 ? '99+' : me.unread.notifications}</span>}
        </NavLink>
        <NavLink to="/profile" title="Profile" className={({ isActive }) => (isActive ? 'on' : '')} style={{ padding: 0 }}>
          <Avatar name={me?.user?.displayName} fileId={me?.user?.avatarFileId} size={40} />
        </NavLink>
      </div>
    </nav>
  );
}

function BottomNav() {
  const { conversations, spaces, me } = useApp();
  const { pathname } = useLocation();
  const unread = (conversations || []).reduce((a, c) => a + (c.muted ? 0 : c.unread || 0), 0) + (spaces || []).reduce((a, s) => a + (s.unread || 0), 0);
  const cls = (p) => (pathname.startsWith(p) ? 'on' : '');
  return (
    <nav className="bottom-nav" aria-label="Main">
      <NavLink to="/chats" className={pathname.startsWith('/chats') || pathname.startsWith('/spaces') ? 'on' : ''}>
        <Icon name="chat" />
        Chats
        {unread > 0 && <span className="badge dot">{unread > 99 ? '99+' : unread}</span>}
      </NavLink>
      <NavLink to="/explore" className={cls('/explore')}><Icon name="compass" />Explore</NavLink>
      <NavLink to="/new" className="plus" aria-label="Create or join"><span className="plus-circle"><Icon name="plus" /></span></NavLink>
      <NavLink to="/files" className={cls('/files')}><Icon name="folder" />Files</NavLink>
      <NavLink to="/profile" className={pathname.startsWith('/profile') || pathname.startsWith('/settings') || pathname.startsWith('/notifications') ? 'on' : ''}>
        <Icon name="user" />
        Profile
        {me?.unread?.notifications > 0 && <span className="badge dot">{me.unread.notifications}</span>}
      </NavLink>
    </nav>
  );
}

export default function Shell() {
  const { connected } = useApp();
  return (
    <div className="shell">
      <Rail />
      <Outlet />
      <BottomNav />
      {!connected && (
        <div className="toast" style={{ position: 'fixed', top: 8, left: '50%', transform: 'translateX(-50%)', zIndex: 80, background: 'var(--warn)' }}>
          Reconnecting…
        </div>
      )}
    </div>
  );
}
