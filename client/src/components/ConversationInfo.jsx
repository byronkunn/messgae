import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, fileUrl } from '../api.js';
import { useApp } from '../store.jsx';
import { Avatar, Empty, Field, Icon, IconButton, Loading, Modal, Toggle, useMenu } from './ui.jsx';
import { FileCard, RichText } from './Message.jsx';
import { MediaViewer, MyFilesPicker } from './FileDialogs.jsx';
import { copyText, dateOnly, relative, timeShort, TOPICS } from '../utils.js';

const TABS = [['overview', 'Info'], ['search', 'Search'], ['media', 'Media'], ['files', 'Files'], ['links', 'Links'], ['pinned', 'Pinned']];

function SearchTab({ conv, onJump }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  useEffect(() => {
    if (q.trim().length < 2) return setResults(null);
    const t = setTimeout(() => api.get(`/api/conversations/${conv.id}/search?q=${encodeURIComponent(q.trim())}`).then((r) => setResults(r.messages)).catch(() => setResults([])), 250);
    return () => clearTimeout(t);
  }, [q, conv.id]);
  return (
    <div className="p-4">
      <div className="search"><Icon name="search" className="icon-sm" /><input autoFocus placeholder="Search messages and file names" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="list mt-3">
        {results === null ? <div className="small muted">Type at least 2 characters.</div> : !results.length ? <div className="small muted">No results.</div> : results.map((m) => (
          <button key={m.id} className="list-item" style={{ padding: '8px 4px' }} onClick={() => onJump(m.id)}>
            <Avatar name={m.sender?.displayName} fileId={m.sender?.avatarFileId} size={32} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row between"><b className="small">{m.sender?.displayName}</b><span className="tiny faint">{timeShort(m.createdAt)}</span></div>
              <div className="small muted ellipsis">{m.body || m.attachments.map((a) => a.filename).join(', ')}</div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

function GalleryTab({ conv, kind, onJump }) {
  const [data, setData] = useState(null);
  const [viewer, setViewer] = useState(null);
  useEffect(() => {
    setData(null);
    api.get(`/api/conversations/${conv.id}/gallery?kind=${kind}`).then(setData).catch(() => setData({ items: [], links: [] }));
  }, [conv.id, kind]);
  if (!data) return <Loading />;
  if (kind === 'links') {
    if (!data.links.length) return <Empty icon="link" title="No links yet" />;
    return (
      <div className="list">
        {data.links.map((l, i) => (
          <div key={i} className="list-item" style={{ cursor: 'default' }}>
            <Icon name="link" />
            <div className="grow" style={{ minWidth: 0 }}>
              <a href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="ellipsis" style={{ display: 'block' }}>{l.url}</a>
              <button className="link-btn tiny" onClick={() => onJump(l.messageId)}>{timeShort(l.createdAt)} · Show message</button>
            </div>
          </div>
        ))}
      </div>
    );
  }
  const items = data.items;
  if (!items.length) return <Empty icon={kind === 'media' ? 'image' : 'file'} title={kind === 'media' ? 'No photos or videos' : 'No files'} />;
  if (kind === 'media') {
    const visible = items.filter((f) => f.available && !f.passwordProtected);
    return (
      <>
        <div className="gallery">
          {visible.map((f, i) => (
            <button key={`${f.id}-${f.messageId}`} style={{ border: 0, padding: 0 }} onClick={() => setViewer(i)} aria-label={f.filename}>
              {f.category === 'image' ? <img src={fileUrl(f.id)} alt="" loading="lazy" /> : <video src={fileUrl(f.id)} preload="metadata" muted />}
            </button>
          ))}
        </div>
        {viewer !== null && <MediaViewer files={visible} index={viewer} onClose={() => setViewer(null)} />}
      </>
    );
  }
  return (
    <div className="col p-4">
      {items.map((f) => (
        <div key={`${f.id}-${f.messageId}`} className="col" style={{ gap: 2 }}>
          <FileCard file={f} />
          <button className="link-btn tiny" style={{ alignSelf: 'flex-start' }} onClick={() => onJump(f.messageId)}>{timeShort(f.sentAt)} · Show in chat</button>
        </div>
      ))}
    </div>
  );
}

function PinnedTab({ conv, onJump }) {
  const [msgs, setMsgs] = useState(null);
  useEffect(() => {
    api.get(`/api/conversations/${conv.id}/pins`).then((r) => setMsgs(r.messages)).catch(() => setMsgs([]));
  }, [conv.id]);
  if (!msgs) return <Loading />;
  if (!msgs.length) return <Empty icon="pin" title="No pinned messages" />;
  return (
    <div className="list">
      {msgs.map((m) => (
        <button key={m.id} className="list-item" onClick={() => onJump(m.id)}>
          <Icon name="pin" />
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="small bold">{m.sender?.displayName} · <span className="faint">{timeShort(m.createdAt)}</span></div>
            <div className="small muted" style={{ display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>{m.body || m.attachments.map((a) => a.filename).join(', ') || `[${m.kind}]`}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

function UserCard({ user, onReport, reload }) {
  const { handleError, toast, confirm } = useApp();
  const act = async (fn, msg) => {
    try {
      await fn();
      if (msg) toast(msg);
      reload();
    } catch (err) {
      handleError(err);
    }
  };
  if (!user) return null;
  return (
    <>
      <div className="profile-hero">
        <Avatar name={user.displayName} fileId={user.avatarFileId} size={84} online={user.online} />
        <h2>{user.displayName}</h2>
        <div className="muted">@{user.username}</div>
        {(user.statusEmoji || user.statusText) && <div className="small">{user.statusEmoji} {user.statusText}</div>}
        {user.online === false && user.lastSeenAt && <div className="tiny faint">Last seen {relative(user.lastSeenAt)}</div>}
      </div>
      <div className="action-row">
        <Link className="action-tile" to={`/u/${user.username}`}><Icon name="user" />Profile</Link>
        <button className="action-tile" onClick={() => act(() => (user.isContact ? api.del(`/api/users/${user.id}/contact`) : api.put(`/api/users/${user.id}/contact`)), user.isContact ? 'Removed from contacts' : 'Added to contacts')}>
          <Icon name={user.isContact ? 'check' : 'plus'} />{user.isContact ? 'Contact' : 'Add contact'}
        </button>
        <button className="action-tile" onClick={() => act(() => (user.muted ? api.del(`/api/users/${user.id}/mute`) : api.put(`/api/users/${user.id}/mute`)), user.muted ? 'Unmuted' : 'Muted')}>
          <Icon name={user.muted ? 'volume' : 'mute'} />{user.muted ? 'Unmute' : 'Mute'}
        </button>
        <button className="action-tile danger" onClick={async () => {
          if (!user.blocked && !(await confirm({ title: `Block ${user.displayName}?`, message: 'You will stop receiving messages from them.', confirmLabel: 'Block', danger: true }))) return;
          act(() => (user.blocked ? api.del(`/api/users/${user.id}/block`) : api.put(`/api/users/${user.id}/block`)), user.blocked ? 'Unblocked' : 'Blocked');
        }}><Icon name="ban" />{user.blocked ? 'Unblock' : 'Block'}</button>
        <button className="action-tile danger" onClick={() => onReport({ targetType: 'user', targetId: user.id, label: user.displayName })}><Icon name="flag" />Report</button>
      </div>
      {user.bio && <div className="p-4" style={{ paddingTop: 0 }}><div className="label">Bio</div><div style={{ whiteSpace: 'pre-wrap' }}><RichText text={user.bio} /></div></div>}
      {user.mutualGroups?.length > 0 && (
        <>
          <div className="section-title">Mutual groups</div>
          <div className="list">{user.mutualGroups.map((g) => <Link key={g.id} className="list-item" to={`/chats/${g.id}`}><Avatar name={g.name} size={36} />{g.name}</Link>)}</div>
        </>
      )}
    </>
  );
}

function AddMembers({ conv, onClose, onAdded }) {
  const { handleError } = useApp();
  const [q, setQ] = useState('');
  const [found, setFound] = useState([]);
  const [picked, setPicked] = useState([]);
  useEffect(() => {
    if (q.trim().length < 2) {
      api.get('/api/users/contacts').then((r) => setFound(r.contacts)).catch(() => {});
      return undefined;
    }
    const t = setTimeout(() => api.get(`/api/users/search?q=${encodeURIComponent(q)}`).then((r) => setFound(r.users)).catch(() => {}), 250);
    return () => clearTimeout(t);
  }, [q]);
  const add = async () => {
    try {
      await api.post(`/api/conversations/${conv.id}/members`, { userIds: picked.map((u) => u.id) });
      onAdded();
      onClose();
    } catch (err) {
      handleError(err);
    }
  };
  return (
    <Modal title="Add members" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!picked.length} onClick={add}>Add {picked.length || ''}</button></>}>
      <div className="search mb-3"><Icon name="search" className="icon-sm" /><input autoFocus placeholder="Search people" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="list">
        {found.map((u) => {
          const on = picked.some((p) => p.id === u.id);
          return (
            <button key={u.id} className={`list-item ${on ? 'active' : ''}`} onClick={() => setPicked(on ? picked.filter((p) => p.id !== u.id) : [...picked, u])}>
              <Avatar name={u.displayName} fileId={u.avatarFileId} size={36} />
              <div className="grow"><div className="bold">{u.displayName}</div><div className="small muted">@{u.username}</div></div>
              {on && <Icon name="check" />}
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

function GroupMembers({ conv, reload }) {
  const { me, handleError, prompt, confirm, toast } = useApp();
  const nav = useNavigate();
  const [members, setMembers] = useState(null);
  const [adding, setAdding] = useState(false);
  const [openMenu, menu] = useMenu();
  const load = useCallback(() => api.get(`/api/conversations/${conv.id}/members`).then((r) => setMembers(r.members)).catch(handleError), [conv.id, handleError]);
  useEffect(() => {
    load();
  }, [load]);
  const rank = { member: 0, moderator: 1, admin: 2, owner: 3 };
  const mine = rank[conv.myRole] ?? -1;
  const run = async (fn, msg) => {
    try {
      await fn();
      if (msg) toast(msg);
      load();
      reload();
    } catch (err) {
      handleError(err);
    }
  };
  const actions = (e, m) => openMenu(e, [
    { label: 'View profile', icon: 'user', onClick: () => nav(`/u/${m.user.username}`) },
    { label: 'Make moderator', icon: 'shield', hidden: mine < 2 || m.role === 'moderator' || rank[m.role] >= mine, onClick: () => run(() => api.patch(`/api/conversations/${conv.id}/members/${m.user.id}`, { role: 'moderator' })) },
    { label: 'Make admin', icon: 'star', hidden: conv.myRole !== 'owner' || m.role === 'admin', onClick: () => run(() => api.patch(`/api/conversations/${conv.id}/members/${m.user.id}`, { role: 'admin' })) },
    { label: 'Make regular member', icon: 'user', hidden: m.role === 'member' || rank[m.role] >= mine && conv.myRole !== 'owner' || m.role === 'owner', onClick: () => run(() => api.patch(`/api/conversations/${conv.id}/members/${m.user.id}`, { role: 'member' })) },
    { label: 'Transfer ownership', icon: 'crown', hidden: conv.myRole !== 'owner', onClick: async () => {
      if (await confirm({ title: 'Transfer ownership?', message: `${m.user.displayName} will become the owner. You'll become an admin.`, confirmLabel: 'Transfer', danger: true })) run(() => api.patch(`/api/conversations/${conv.id}/members/${m.user.id}`, { role: 'owner' }));
    } },
    'sep',
    { label: 'Time out', icon: 'clock', hidden: !conv.can.manageMembers || rank[m.role] >= mine, onClick: async () => {
      const minutes = await prompt({ title: `Time out ${m.user.displayName}`, label: 'Minutes (0 to clear)', defaultValue: '60', type: 'number' });
      if (minutes !== null) run(() => api.post(`/api/conversations/${conv.id}/members/${m.user.id}/timeout`, { minutes: Number(minutes) }), 'Updated');
    } },
    { label: 'Remove from group', icon: 'logout', danger: true, hidden: !conv.can.manageMembers || rank[m.role] >= mine, onClick: () => run(() => api.del(`/api/conversations/${conv.id}/members/${m.user.id}`), 'Removed') },
    { label: 'Ban', icon: 'ban', danger: true, hidden: !conv.can.ban || rank[m.role] >= mine, onClick: async () => {
      const reason = await prompt({ title: `Ban ${m.user.displayName}`, label: 'Reason (optional)', confirmLabel: 'Ban', danger: true });
      if (reason !== null) run(() => api.post(`/api/conversations/${conv.id}/bans`, { userId: m.user.id, reason }), 'Banned');
    } },
  ]);
  return (
    <>
      <div className="row between" style={{ padding: '12px 16px 4px' }}>
        <div className="section-title" style={{ padding: 0 }}>{members?.length ?? ''} Members</div>
        {conv.can.createInvites && <button className="btn btn-sm btn-ghost" onClick={() => setAdding(true)}><Icon name="plus" className="icon-sm" /> Add</button>}
      </div>
      {!members ? <Loading /> : (
        <div className="list">
          {members.map((m) => (
            <div key={m.user.id} className="list-item" style={{ cursor: 'default' }}>
              <Avatar name={m.user.displayName} fileId={m.user.avatarFileId} size={36} online={m.online} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="bold ellipsis">{m.user.displayName}{m.user.id === me.user.id ? ' (you)' : ''}</div>
                <div className="small muted">@{m.user.username}{m.timeoutUntil ? ' · timed out' : ''}</div>
              </div>
              {m.role !== 'member' && <span className={`tag ${m.role === 'owner' ? 'accent' : m.role === 'admin' ? 'danger' : 'ok'}`}>{m.role}</span>}
              {m.user.id !== me.user.id && <IconButton icon="more" label="Member actions" onClick={(e) => actions(e, m)} />}
            </div>
          ))}
        </div>
      )}
      {adding && <AddMembers conv={conv} onClose={() => setAdding(false)} onAdded={load} />}
      {menu}
    </>
  );
}

function Invites({ conv }) {
  const { handleError, toast } = useApp();
  const [invites, setInvites] = useState([]);
  const load = useCallback(() => api.get(`/api/conversations/${conv.id}/invites`).then((r) => setInvites(r.invites)).catch(() => {}), [conv.id]);
  useEffect(() => {
    load();
  }, [load]);
  const create = async () => {
    try {
      const r = await api.post(`/api/conversations/${conv.id}/invites`, { expiresInHours: 24 * 7 });
      await copyText(`${location.origin}/invite/${r.invite.code}`);
      toast('Invite link copied');
      load();
    } catch (err) {
      handleError(err);
    }
  };
  return (
    <div className="p-4">
      <div className="row between mb-3"><b>Invite links</b><button className="btn btn-sm" onClick={create}><Icon name="link" className="icon-sm" /> New link</button></div>
      {invites.map((i) => (
        <div key={i.code} className="row small" style={{ padding: '6px 0' }}>
          <code className="grow ellipsis">/invite/{i.code}</code>
          <span className="faint">{i.uses}{i.maxUses ? `/${i.maxUses}` : ''} uses{i.expiresAt ? ` · expires ${relative(i.expiresAt)}` : ''}</span>
          <IconButton icon="copy" label="Copy" size={16} onClick={() => copyText(`${location.origin}/invite/${i.code}`).then(() => toast('Copied'))} />
          <IconButton icon="trash" label="Revoke" size={16} onClick={() => api.del(`/api/invites/${i.code}`).then(load).catch(handleError)} />
        </div>
      ))}
    </div>
  );
}

function GroupSettings({ conv, reload, onClose }) {
  const { handleError, toast } = useApp();
  const [name, setName] = useState(conv.name);
  const [description, setDescription] = useState(conv.description);
  const [pick, setPick] = useState(false);
  const [requests, setRequests] = useState([]);
  const [bans, setBans] = useState([]);
  const save = async (patch, msg = 'Saved') => {
    try {
      await api.patch(`/api/conversations/${conv.id}`, patch);
      toast(msg);
      reload();
    } catch (err) {
      handleError(err);
    }
  };
  useEffect(() => {
    if (conv.can.manageMembers) api.get(`/api/conversations/${conv.id}/requests`).then((r) => setRequests(r.requests)).catch(() => {});
    if (conv.can.ban) api.get(`/api/conversations/${conv.id}/bans`).then((r) => setBans(r.bans)).catch(() => {});
  }, [conv.id, conv.can.manageMembers, conv.can.ban]);
  const s = conv.settings || {};
  return (
    <Modal title="Group settings" onClose={onClose} wide>
      {conv.can.manageChannel && (
        <>
          <div className="row gap-3 mb-3">
            <Avatar name={conv.name} fileId={conv.avatarFileId} size={64} />
            <button className="btn btn-sm" onClick={() => setPick(true)}>Change avatar</button>
          </div>
          <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} /></Field>
          <Field label="Description"><textarea className="input" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1000} /></Field>
          <button className="btn btn-primary btn-sm mb-3" onClick={() => save({ name, description })}>Save details</button>
          <hr />
          <h3 className="mb-3">Member permissions</h3>
          {[
            ['membersCanSend', 'Members can send messages'],
            ['membersCanSendMedia', 'Members can send media and files'],
            ['membersCanInvite', 'Members can add people and create invites'],
            ['membersCanPin', 'Members can pin messages'],
            ['membersCanMentionAll', 'Members can mention @everyone'],
          ].map(([k, label]) => (
            <div key={k} className="row between" style={{ padding: '8px 0' }}>
              <span>{label}</span>
              <Toggle checked={s[k]} label={label} onChange={(v) => save({ settings: { [k]: v } })} />
            </div>
          ))}
          <hr />
          <h3 className="mb-3">Discovery</h3>
          <div className="row between" style={{ padding: '8px 0' }}>
            <span>Public group (can be previewed)</span>
            <Toggle checked={conv.visibility === 'public'} label="Public" onChange={(v) => save({ visibility: v ? 'public' : 'private', discoverable: v ? conv.discoverable : false })} />
          </div>
          {conv.visibility === 'public' && (
            <>
              <div className="row between" style={{ padding: '8px 0' }}>
                <span>Show in Explore</span>
                <Toggle checked={conv.discoverable} label="Show in Explore" onChange={(v) => save({ discoverable: v })} />
              </div>
              <div className="row gap-3 wrap">
                <Field label="Joining">
                  <select className="input" value={conv.joinMode} onChange={(e) => save({ joinMode: e.target.value })}>
                    <option value="open">Anyone can join</option><option value="approval">Approval required</option><option value="invite">Invite only</option>
                  </select>
                </Field>
                <Field label="Topic">
                  <select className="input" value={conv.topic || ''} onChange={(e) => save({ topic: e.target.value })}>
                    <option value="">None</option>
                    {Object.entries(TOPICS).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
                  </select>
                </Field>
              </div>
            </>
          )}
          <hr />
        </>
      )}
      {conv.can.moderate && (
        <>
          <h3 className="mb-3">Moderation</h3>
          <Field label="Slow mode">
            <select className="input" value={conv.slowModeSeconds} onChange={(e) => save({ slowModeSeconds: Number(e.target.value) })}>
              {[0, 5, 10, 30, 60, 300, 900, 3600].map((v) => <option key={v} value={v}>{v === 0 ? 'Off' : v < 60 ? `${v} seconds` : `${v / 60} minutes`}</option>)}
            </select>
          </Field>
          <div className="row between" style={{ padding: '8px 0' }}>
            <span>Lock conversation (only moderators can post)</span>
            <Toggle checked={conv.locked} label="Lock" onChange={(v) => save({ locked: v }, v ? 'Locked' : 'Unlocked')} />
          </div>
        </>
      )}
      {requests.length > 0 && (
        <>
          <hr />
          <h3 className="mb-3">Join requests</h3>
          {requests.map((r) => (
            <div key={r.user.id} className="row" style={{ padding: '6px 0' }}>
              <Avatar name={r.user.displayName} size={32} />
              <div className="grow"><b>{r.user.displayName}</b><div className="tiny muted">{r.message}</div></div>
              <button className="btn btn-sm btn-primary" onClick={() => api.post(`/api/conversations/${conv.id}/requests/${r.user.id}`, { approve: true }).then(() => setRequests(requests.filter((x) => x !== r)))}>Approve</button>
              <button className="btn btn-sm" onClick={() => api.post(`/api/conversations/${conv.id}/requests/${r.user.id}`, { approve: false }).then(() => setRequests(requests.filter((x) => x !== r)))}>Decline</button>
            </div>
          ))}
        </>
      )}
      {bans.length > 0 && (
        <>
          <hr />
          <h3 className="mb-3">Banned</h3>
          {bans.map((b) => (
            <div key={b.user.id} className="row" style={{ padding: '6px 0' }}>
              <div className="grow"><b>{b.user.displayName}</b> <span className="small muted">{b.reason}</span></div>
              <button className="btn btn-sm" onClick={() => api.del(`/api/conversations/${conv.id}/bans/${b.user.id}`).then(() => setBans(bans.filter((x) => x !== b)))}>Unban</button>
            </div>
          ))}
        </>
      )}
      {pick && <MyFilesPicker accept="image" multiple={false} title="Choose group avatar" onClose={() => setPick(false)} onPick={([f]) => { setPick(false); save({ avatarFileId: f.id }); }} />}
    </Modal>
  );
}

function Overview({ conv, reload, onReport }) {
  const nav = useNavigate();
  const [settings, setSettings] = useState(false);
  const { handleError, toast } = useApp();
  if (conv.type === 'dm') return <UserCard user={conv.otherUser} onReport={onReport} reload={reload} />;
  if (conv.type === 'channel') {
    return (
      <div className="p-4 col gap-3">
        <h2>#{conv.name}</h2>
        {conv.description && <p className="muted">{conv.description}</p>}
        <div className="row wrap">
          <span className="tag">{conv.channelType}</span>
          {conv.isPrivate && <span className="tag warn">private</span>}
          {conv.locked && <span className="tag danger">locked</span>}
          {conv.slowModeSeconds > 0 && <span className="tag">slow mode {conv.slowModeSeconds}s</span>}
        </div>
        {conv.can.moderate && (
          <div className="card">
            <b>Moderation</b>
            <Field label="Slow mode">
              <select className="input" value={conv.slowModeSeconds} onChange={(e) => api.patch(`/api/conversations/${conv.id}`, { slowModeSeconds: Number(e.target.value) }).then(reload).catch(handleError)}>
                {[0, 5, 10, 30, 60, 300, 900, 3600].map((v) => <option key={v} value={v}>{v === 0 ? 'Off' : v < 60 ? `${v} seconds` : `${v / 60} minutes`}</option>)}
              </select>
            </Field>
            <div className="row between">
              <span>Lock channel</span>
              <Toggle checked={conv.locked} label="Lock channel" onChange={(v) => api.patch(`/api/conversations/${conv.id}`, { locked: v }).then(() => { toast(v ? 'Locked' : 'Unlocked'); reload(); }).catch(handleError)} />
            </div>
          </div>
        )}
        {conv.can.manageChannel && <button className="btn" onClick={() => nav(`/spaces/${conv.spaceId}/settings/channels`)}><Icon name="settings" className="icon-sm" /> Channel settings</button>}
      </div>
    );
  }
  return (
    <>
      <div className="profile-hero">
        <Avatar name={conv.name} fileId={conv.avatarFileId} size={84} />
        <h2>{conv.name}</h2>
        <div className="small muted">Group · {conv.memberCount} members{conv.visibility === 'public' ? ' · public' : ''}</div>
        {conv.description && <p className="muted small" style={{ whiteSpace: 'pre-wrap' }}>{conv.description}</p>}
        {conv.isMember && (conv.can.manageChannel || conv.can.moderate) && <button className="btn btn-sm" onClick={() => setSettings(true)}><Icon name="settings" className="icon-sm" /> Group settings</button>}
      </div>
      {conv.isMember && conv.can.createInvites && <Invites conv={conv} />}
      <GroupMembers conv={conv} reload={reload} />
      {settings && <GroupSettings conv={conv} reload={reload} onClose={() => setSettings(false)} />}
    </>
  );
}

export default function ConversationInfo({ conv, tab, setTab, onClose, onJump, reload, onReport }) {
  return (
    <aside className="details" aria-label="Conversation details">
      <header className="pane-header">
        <h2 className="grow">Details</h2>
        <IconButton icon="x" label="Close details" onClick={onClose} />
      </header>
      <div className="tabs" role="tablist">
        {TABS.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      <div className="pane-body">
        {tab === 'overview' && <Overview conv={conv} reload={reload} onReport={onReport} />}
        {tab === 'search' && <SearchTab conv={conv} onJump={onJump} />}
        {tab === 'media' && <GalleryTab conv={conv} kind="media" onJump={onJump} />}
        {tab === 'files' && <GalleryTab conv={conv} kind="files" onJump={onJump} />}
        {tab === 'links' && <GalleryTab conv={conv} kind="links" onJump={onJump} />}
        {tab === 'pinned' && <PinnedTab conv={conv} onJump={onJump} />}
      </div>
      <div className="tiny faint p-4">Created {dateOnly(conv.createdAt)}</div>
    </aside>
  );
}
