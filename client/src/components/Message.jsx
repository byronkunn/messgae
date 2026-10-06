import { memo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, fileUrl } from '../api.js';
import { useApp } from '../store.jsx';
import { Avatar, Icon, IconButton, useMenu } from './ui.jsx';
import { clock, formatBytes, extOf, STICKERS, QUICK_REACTIONS, copyText } from '../utils.js';
import { UnlockDialog, MediaViewer } from './FileDialogs.jsx';

const URL_SPLIT = /(\bhttps?:\/\/[^\s<>"'`]+[^\s<>"'`.,;:!?)\]]|(?:^|(?<=\s))@[a-zA-Z0-9_]{3,32}\b)/g;

/** Renders message text safely (React escapes everything); links and @mentions become elements. */
export function RichText({ text }) {
  if (!text) return null;
  const parts = text.split(URL_SPLIT);
  return parts.map((p, i) => {
    if (!p) return null;
    if (/^https?:\/\//.test(p)) {
      return <a key={i} href={p} target="_blank" rel="noopener noreferrer nofollow ugc">{p}</a>;
    }
    if (/^@[a-zA-Z0-9_]{3,32}$/.test(p)) {
      const name = p.slice(1);
      if (name === 'everyone' || name === 'here') return <span key={i} className="mention">{p}</span>;
      return <Link key={i} className="mention" to={`/u/${name}`} style={{ color: 'inherit' }}>{p}</Link>;
    }
    return <span key={i}>{p}</span>;
  });
}

function LinkCard({ url }) {
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    /* ignore */
  }
  return (
    <a className="link-card" href={url} target="_blank" rel="noopener noreferrer nofollow ugc" title="Link previews are built on your device; we don't fetch the page.">
      <div className="bold ellipsis">{host}</div>
      <div className="tiny ellipsis" style={{ opacity: 0.8 }}>{url}</div>
    </a>
  );
}

export function FileCard({ file, compact }) {
  const { toast, handleError } = useApp();
  const [unlock, setUnlock] = useState(false);
  const unavailable = !file.available;
  const download = async (ticket) => {
    const a = document.createElement('a');
    a.href = fileUrl(file.id, { download: true, ticket });
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  const save = async (ticket) => {
    try {
      const r = await api.post(`/api/files/${file.id}/save`, { ticket });
      toast(r.alreadyOwned ? 'Already in My Files' : 'Saved to My Files');
    } catch (err) {
      handleError(err);
    }
  };
  return (
    <div className="file-card">
      <div className="file-icon">{file.passwordProtected ? <Icon name="lock" className="icon-sm" /> : extOf(file.filename)}</div>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="bold ellipsis" title={file.filename}>{file.filename}</div>
        <div className="tiny muted">{formatBytes(file.size)} · {extOf(file.filename)} {file.category === 'archive' ? 'Archive' : file.category === 'document' ? 'Document' : 'File'}{file.passwordProtected ? ' · Password' : ''}</div>
        {unavailable ? (
          <div className="tiny danger-text">Unavailable</div>
        ) : !compact && (
          <div className="actions">
            <button className="link-btn" onClick={() => (file.passwordProtected ? setUnlock('download') : download())}>Download</button>
            <button className="link-btn" onClick={() => (file.passwordProtected ? setUnlock('save') : save())}>Save to My Files</button>
          </div>
        )}
      </div>
      {unlock && (
        <UnlockDialog
          file={file}
          onClose={() => setUnlock(false)}
          onUnlocked={(ticket) => {
            setUnlock(false);
            if (unlock === 'save') save(ticket);
            else download(ticket);
          }}
        />
      )}
    </div>
  );
}

function Attachments({ attachments, kind }) {
  const [viewer, setViewer] = useState(null);
  const media = attachments.filter((f) => (f.category === 'image' || f.category === 'video') && f.available && !f.passwordProtected);
  const others = attachments.filter((f) => !media.includes(f));
  return (
    <>
      {media.length > 0 && (
        <div className={`attachment-grid ${media.length === 1 ? 'single' : ''}`}>
          {media.map((f, i) => (
            <button key={f.id} className="media-thumb" style={{ border: 0, padding: 0 }} onClick={() => setViewer(i)} aria-label={`Open ${f.filename}`}>
              {f.category === 'image' ? <img src={fileUrl(f.id)} alt={f.filename} loading="lazy" /> : <video src={fileUrl(f.id)} preload="metadata" muted playsInline />}
              {f.category === 'video' && <span className="center" style={{ position: 'absolute', inset: 0, color: '#fff' }}><Icon name="play" size={36} /></span>}
            </button>
          ))}
        </div>
      )}
      {others.map((f) =>
        f.category === 'audio' && f.available && !f.passwordProtected ? (
          <div key={f.id} className="col" style={{ gap: 4 }}>
            {kind !== 'voice' && <div className="small bold ellipsis">{f.filename}</div>}
            <audio controls preload="none" src={fileUrl(f.id)} style={{ maxWidth: 280, height: 40 }} />
          </div>
        ) : (
          <FileCard key={f.id} file={f} />
        ),
      )}
      {viewer !== null && <MediaViewer files={media} index={viewer} onClose={() => setViewer(null)} />}
    </>
  );
}

function Poll({ message }) {
  const { handleError } = useApp();
  const [myVote, setMyVote] = useState(message.poll.myVote ?? null);
  const poll = message.poll;
  const vote = async (i) => {
    try {
      const next = myVote === i ? null : i;
      await api.post(`/api/messages/${message.id}/vote`, { option: next });
      setMyVote(next);
    } catch (err) {
      handleError(err);
    }
  };
  return (
    <div className="poll">
      <div className="bold">📊 {poll.question}</div>
      {poll.options.map((o, i) => {
        const pct = poll.total ? Math.round((poll.votes[i] / poll.total) * 100) : 0;
        return (
          <button key={i} className={`poll-option ${myVote === i ? 'voted' : ''}`} onClick={() => vote(i)} style={{ width: '100%' }}>
            <span className="bar" style={{ width: `${pct}%` }} />
            <span>{myVote === i ? '✓ ' : ''}{o}</span>
            <span className="small muted">{pct}%</span>
          </button>
        );
      })}
      <div className="tiny" style={{ opacity: 0.75, marginTop: 6 }}>{poll.total} vote{poll.total === 1 ? '' : 's'}</div>
    </div>
  );
}

function systemText(s) {
  const who = (u) => u?.displayName || 'Someone';
  switch (s?.event) {
    case 'group_created': return `${who(s.actor)} created the group “${s.name}”`;
    case 'members_added': return `${who(s.actor)} added ${s.users.map(who).join(', ')}`;
    case 'member_joined': return `${who(s.user)} joined${s.via === 'invite' ? ' via invite link' : ''}`;
    case 'member_left': return `${who(s.user)} left`;
    case 'member_removed': return `${who(s.actor)} removed ${who(s.user)}`;
    case 'member_banned': return `${who(s.actor)} banned ${who(s.user)}`;
    case 'role_changed': return `${who(s.actor)} made ${who(s.user)} ${s.role === 'member' ? 'a member' : `an ${s.role}`.replace('an moderator', 'a moderator')}`;
    default: return 'Conversation updated';
  }
}

function Message({ m, me, prev, showSender, can, onReply, onEdit, onReport, onJump, receipt, highlight }) {
  const { handleError, toast, confirm } = useApp();
  const [openMenu, menu] = useMenu();
  const longPress = useRef(null);
  if (m.kind === 'system') return <div className="system-msg">{systemText(m.system)}</div>;
  const mine = m.sender?.id === me;
  const grouped = prev && prev.kind !== 'system' && prev.sender?.id === m.sender?.id && m.createdAt - prev.createdAt < 5 * 60_000;
  const deleted = !!m.deletedAt;
  const mediaOnly = !deleted && !m.body && m.attachments.length > 0 && m.attachments.every((f) => ['image', 'video'].includes(f.category) && f.available && !f.passwordProtected) && !m.replyTo;

  const react = async (emoji) => {
    const mineR = m.reactions.find((r) => r.emoji === emoji)?.userIds.includes(me);
    try {
      if (mineR) await api.del(`/api/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`);
      else await api.put(`/api/messages/${m.id}/reactions/${encodeURIComponent(emoji)}`);
    } catch (err) {
      handleError(err);
    }
  };
  const del = async () => {
    if (!(await confirm({ title: 'Delete message?', message: mine ? 'This removes the message for everyone.' : 'Remove this message as a moderator?', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.del(`/api/messages/${m.id}`);
    } catch (err) {
      handleError(err);
    }
  };
  const pin = async () => {
    try {
      await api.post(`/api/messages/${m.id}/pin`, { pinned: !m.pinnedAt });
      toast(m.pinnedAt ? 'Unpinned' : 'Pinned');
    } catch (err) {
      handleError(err);
    }
  };

  const menuItems = [
    {
      hidden: deleted || !can.react,
      custom: (close) => (
        <div className="row" style={{ justifyContent: 'space-between', padding: '4px 4px 6px' }}>
          {QUICK_REACTIONS.map((e) => (
            <button key={e} className="icon-btn" style={{ fontSize: 20, width: 36, height: 36 }} onClick={() => { close(); react(e); }} aria-label={`React ${e}`}>{e}</button>
          ))}
        </div>
      ),
    },
    { label: 'Reply', icon: 'reply', onClick: () => onReply(m), hidden: deleted || !can.send && !can.replyThreads },
    { label: 'Copy text', icon: 'copy', onClick: () => copyText(m.body).then(() => toast('Copied')), hidden: deleted || !m.body },
    { label: 'Edit', icon: 'edit', onClick: () => onEdit(m), hidden: deleted || !mine || !['text', 'media', 'file', 'voice'].includes(m.kind) },
    { label: m.pinnedAt ? 'Unpin' : 'Pin', icon: 'pin', onClick: pin, hidden: deleted || !can.pin },
    { label: 'Copy message ID', icon: 'hash', onClick: () => copyText(m.id).then(() => toast('Message ID copied')) },
    'sep',
    { label: 'Report', icon: 'flag', onClick: () => onReport(m), hidden: mine || deleted },
    { label: 'Delete', icon: 'trash', danger: true, onClick: del, hidden: deleted || (!mine && !can.deleteAny) },
  ];
  const openActions = (e) => openMenu(e, menuItems);

  return (
    <div
      className={`msg ${mine ? 'me' : ''} ${grouped ? 'grouped' : ''} ${highlight ? 'highlight' : ''}`}
      id={`m-${m.id}`}
      onContextMenu={(e) => {
        e.preventDefault();
        openActions(e);
      }}
      onTouchStart={(e) => {
        const target = e.currentTarget;
        longPress.current = setTimeout(() => openMenu({ currentTarget: target.querySelector('.bubble') || target }, menuItems), 450);
      }}
      onTouchEnd={() => clearTimeout(longPress.current)}
      onTouchMove={() => clearTimeout(longPress.current)}
      style={{ marginTop: grouped ? 0 : 8 }}
    >
      {!mine && (
        <div className="avatar-slot">
          {!grouped && m.sender && (
            <Link to={`/u/${m.sender.username}`} aria-label={m.sender.displayName}>
              <Avatar name={m.sender.displayName} fileId={m.sender.avatarFileId} size={32} />
            </Link>
          )}
        </div>
      )}
      <div className="bubble-wrap">
        <div className={`bubble ${deleted ? 'deleted' : ''} ${mediaOnly ? 'media-only' : ''}`}>
          {!mine && !grouped && showSender && !deleted && !mediaOnly && <div className="sender">{m.sender?.displayName}</div>}
          {m.replyTo && !deleted && (
            <div className="reply-quote" onClick={() => onJump(m.replyTo.id)} role="button" tabIndex={0}>
              <b>{m.replyTo.sender?.displayName || 'Message'}</b>
              <div className="ellipsis">{m.replyTo.snippet}</div>
            </div>
          )}
          {deleted ? (
            <span>{m.removedByModerator ? 'Message removed by a moderator' : 'Message deleted'}</span>
          ) : (
            <>
              {m.kind === 'sticker' ? <div className="sticker" role="img" aria-label={`Sticker ${m.sticker}`}>{STICKERS[m.sticker] || '❓'}</div> : null}
              {m.kind === 'poll' && m.poll ? <Poll message={m} /> : null}
              {m.attachments.length > 0 && <Attachments attachments={m.attachments} kind={m.kind} />}
              {m.body && <div style={{ marginTop: m.attachments.length ? 6 : 0 }}><RichText text={m.body} /></div>}
              {m.links?.slice(0, 1).map((u) => <LinkCard key={u} url={u} />)}
            </>
          )}
          {!mediaOnly && (
            <span className="meta-line">
              {m.pinnedAt && <Icon name="pin" size={11} />}
              {m.editedAt && !deleted && 'edited'}
              {clock(m.createdAt)}
              {mine && receipt !== undefined && <Icon name={receipt ? 'checks' : 'check'} size={13} title={receipt ? 'Seen' : 'Sent'} />}
            </span>
          )}
        </div>
        {m.reactions.length > 0 && (
          <div className="reactions">
            {m.reactions.map((r) => (
              <button key={r.emoji} className={`reaction ${r.userIds.includes(me) ? 'mine' : ''}`} onClick={() => can.react && react(r.emoji)} title={`${r.count}`}>
                {r.emoji} <span className="small">{r.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {!deleted && (
        <div className="msg-actions">
          {can.react && QUICK_REACTIONS.slice(0, 3).map((e) => (
            <button key={e} className="icon-btn" style={{ fontSize: 16 }} onClick={() => react(e)} aria-label={`React ${e}`}>{e}</button>
          ))}
          {(can.send || can.replyThreads) && <IconButton icon="reply" label="Reply" onClick={() => onReply(m)} size={18} />}
          <IconButton icon="moreH" label="More actions" onClick={openActions} size={18} />
        </div>
      )}
      {menu}
    </div>
  );
}

export default memo(Message);
