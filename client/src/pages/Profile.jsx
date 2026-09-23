import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Panes } from '../components/Shell.jsx';
import { Avatar, Empty, Icon, Loading, PaneHeader } from '../components/ui.jsx';
import { ReportDialog } from '../components/FileDialogs.jsx';
import { RichText } from '../components/Message.jsx';
import { copyText, dateOnly, relative, roleLabel } from '../utils.js';

function ProfileView({ user, self, actions }) {
  return (
    <>
      <div className="banner">{user.bannerFileId && <img src={`/api/files/${user.bannerFileId}/content`} alt="" />}</div>
      <div className="profile-hero">
        <Avatar name={user.displayName} fileId={user.avatarFileId} size={96} online={user.online} />
        <h1>{user.displayName}</h1>
        <div className="muted">@{user.username}</div>
        {user.staffBadge && <span className="tag accent"><Icon name="shield" size={12} /> {roleLabel(user.staffBadge)}</span>}
        {(user.statusEmoji || user.statusText) && <div>{user.statusEmoji} {user.statusText}</div>}
        {!self && user.online === false && user.lastSeenAt && <div className="small faint">Last seen {relative(user.lastSeenAt)}</div>}
        {!self && user.online && <div className="small ok-text">Online</div>}
      </div>
      {actions}
      <div className="content-narrow" style={{ padding: '0 16px 24px' }}>
        {user.bio && <div className="card mb-3"><div className="label mb-3">Bio</div><div style={{ whiteSpace: 'pre-wrap' }}><RichText text={user.bio} /></div></div>}
        {user.links?.length > 0 && (
          <div className="card mb-3">
            <div className="label mb-3">Links</div>
            {user.links.map((l) => <div key={l.url}><a href={l.url} target="_blank" rel="noopener noreferrer nofollow">{l.label}</a></div>)}
          </div>
        )}
        {user.spaces?.length > 0 && (
          <div className="card mb-3">
            <div className="label mb-3">Spaces</div>
            <div className="row wrap">{user.spaces.map((s) => <Link key={s.id} to={`/spaces/${s.id}`} className="chip"><Avatar name={s.name} fileId={s.iconFileId} size={20} square /> {s.name}</Link>)}</div>
          </div>
        )}
        {user.mutualGroups?.length > 0 && (
          <div className="card mb-3">
            <div className="label mb-3">Mutual groups</div>
            <div className="row wrap">{user.mutualGroups.map((g) => <Link key={g.id} to={`/chats/${g.id}`} className="chip">{g.name}</Link>)}</div>
          </div>
        )}
        <div className="tiny faint" style={{ textAlign: 'center' }}>Member since {dateOnly(user.createdAt)}</div>
      </div>
    </>
  );
}

export default function ProfilePage() {
  const { me, toast, signOut } = useApp();
  const nav = useNavigate();
  const u = me.user;
  const staff = u.capabilities?.includes('admin.access');
  const main = (
    <>
      <header className="pane-header">
        <h1>Profile</h1>
        <button className="btn btn-sm" onClick={() => nav('/settings/profile')}><Icon name="edit" className="icon-sm" /> Edit</button>
      </header>
      <div className="pane-body">
        <ProfileView user={u} self actions={
          <div className="content-narrow" style={{ padding: '0 16px 12px' }}>
            <button className="card row" style={{ width: '100%', cursor: 'pointer', textAlign: 'left' }} onClick={() => copyText(u.accountId).then(() => toast('Account ID copied'))}>
              <Icon name="key" />
              <div className="grow"><div className="tiny muted">Account ID</div><div className="mono small">{u.accountId}</div></div>
              <Icon name="copy" className="icon-sm faint" />
            </button>
          </div>
        } />
        <div className="content-narrow">
          <div className="settings-group">
            <Link className="list-item" to="/notifications"><Icon name="bell" /><span className="grow">Notifications</span>{me.unread?.notifications > 0 && <span className="badge">{me.unread.notifications}</span>}</Link>
            <Link className="list-item" to="/settings/privacy"><Icon name="eye" /><span className="grow">Privacy</span><Icon name="chevron" className="icon-sm faint" /></Link>
            <Link className="list-item" to="/settings/security"><Icon name="shield" /><span className="grow">Security & devices</span><Icon name="chevron" className="icon-sm faint" /></Link>
            <Link className="list-item" to="/settings/plan"><Icon name="star" /><span className="grow">Plan & storage</span><span className="tag">{me.plan.label}</span></Link>
            <Link className="list-item" to="/settings"><Icon name="settings" /><span className="grow">All settings</span><Icon name="chevron" className="icon-sm faint" /></Link>
            {staff && <Link className="list-item" to="/admin"><Icon name="server" /><span className="grow">Admin</span><Icon name="chevron" className="icon-sm faint" /></Link>}
          </div>
          <div className="settings-group">
            <button className="list-item danger-text" onClick={signOut}><Icon name="logout" /><span className="grow">Sign out of this device</span></button>
          </div>
        </div>
      </div>
    </>
  );
  return <Panes single main={main} />;
}

export function UserProfilePage() {
  const { username } = useParams();
  const nav = useNavigate();
  const { me, handleError, toast, confirm, refreshConversations } = useApp();
  const [user, setUser] = useState(null);
  const [error, setError] = useState(null);
  const [report, setReport] = useState(false);
  const load = useCallback(() => api.get(`/api/users/by-username/${encodeURIComponent(username)}`, { quiet: true }).then((r) => setUser(r.user)).catch(setError), [username]);
  useEffect(() => {
    setUser(null);
    load();
  }, [load]);
  if (error) return <Panes single main={<><PaneHeader title="Profile" onBack={() => nav(-1)} back="always" /><Empty icon="user" title="User not found" /></>} />;
  if (!user) return <Panes single main={<Loading />} />;
  if (user.id === me.user.id) return <ProfilePage />;
  const act = async (fn, msg) => {
    try {
      await fn();
      if (msg) toast(msg);
      load();
    } catch (err) {
      handleError(err);
    }
  };
  const message = async () => {
    try {
      const r = await api.post('/api/conversations/dm', { userId: user.id });
      refreshConversations();
      nav(`/chats/${r.conversation.id}`);
    } catch (err) {
      handleError(err);
    }
  };
  const actions = (
    <div className="action-row">
      <button className="action-tile" onClick={message} disabled={!user.canMessage} title={user.canMessage ? '' : "This person isn't accepting messages from you"}><Icon name="chat" />Message</button>
      <button className="action-tile" onClick={() => act(() => (user.isContact ? api.del(`/api/users/${user.id}/contact`) : api.put(`/api/users/${user.id}/contact`)), user.isContact ? 'Removed from contacts' : 'Added to contacts')}>
        <Icon name={user.isContact ? 'check' : 'plus'} />{user.isContact ? 'Contact' : 'Add contact'}
      </button>
      <button className="action-tile" onClick={() => act(() => (user.muted ? api.del(`/api/users/${user.id}/mute`) : api.put(`/api/users/${user.id}/mute`)), user.muted ? 'Unmuted' : 'Muted')}><Icon name={user.muted ? 'volume' : 'mute'} />{user.muted ? 'Unmute' : 'Mute'}</button>
      <button className="action-tile danger" onClick={async () => {
        if (!user.blocked && !(await confirm({ title: `Block ${user.displayName}?`, message: "They won't be able to message you or add you to groups.", confirmLabel: 'Block', danger: true }))) return;
        act(() => (user.blocked ? api.del(`/api/users/${user.id}/block`) : api.put(`/api/users/${user.id}/block`)), user.blocked ? 'Unblocked' : 'Blocked');
      }}><Icon name="ban" />{user.blocked ? 'Unblock' : 'Block'}</button>
      <button className="action-tile danger" onClick={() => setReport(true)}><Icon name="flag" />Report</button>
    </div>
  );
  const main = (
    <>
      <PaneHeader title={user.displayName} onBack={() => nav(-1)} back="always" />
      <div className="pane-body"><ProfileView user={user} actions={actions} /></div>
      {report && <ReportDialog targetType="user" targetId={user.id} label={user.displayName} onClose={() => setReport(false)} />}
    </>
  );
  return <Panes detail single main={main} />;
}
