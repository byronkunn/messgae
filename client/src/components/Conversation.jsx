import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApp, useRealtime } from '../store.jsx';
import { Avatar, Empty, Icon, IconButton, Loading, Modal, Field, PaneHeader, useMenu } from './ui.jsx';
import Message from './Message.jsx';
import Composer from './Composer.jsx';
import ConversationInfo from './ConversationInfo.jsx';
import { ReportDialog, uploadMany } from './FileDialogs.jsx';
import { dayLabel, relative, timeShort } from '../utils.js';

function channelIcon(c) {
  if (c.isPrivate) return 'lock';
  return { announcement: 'megaphone', forum: 'forum', media: 'gallery' }[c.channelType] || 'hash';
}

function ForumView({ conv, onOpen }) {
  const { handleError } = useApp();
  const [threads, setThreads] = useState(null);
  const [creating, setCreating] = useState(false);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const load = useCallback(() => api.get(`/api/conversations/${conv.id}/threads`).then((r) => setThreads(r.threads)).catch(handleError), [conv.id, handleError]);
  useEffect(() => {
    load();
  }, [load]);
  useRealtime((e) => {
    if (e.conversationId === conv.id && (e.type === 'thread:new' || e.type === 'thread:update' || e.type === 'message:new')) load();
  }, [conv.id]);
  const create = async () => {
    try {
      const r = await api.post(`/api/conversations/${conv.id}/threads`, { title, body });
      setCreating(false);
      setTitle('');
      setBody('');
      onOpen(r.thread.id);
    } catch (err) {
      handleError(err);
    }
  };
  return (
    <div className="pane-body">
      <div className="row between p-4">
        <div>
          <h2>Topics</h2>
          <div className="small muted">{conv.description || 'Each topic is its own conversation.'}</div>
        </div>
        {conv.can.createThreads && <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}><Icon name="plus" className="icon-sm" /> New topic</button>}
      </div>
      {!threads ? <Loading /> : !threads.length ? <Empty icon="forum" title="No topics yet">Start the first discussion.</Empty> : threads.map((t) => (
        <button key={t.id} className="thread-row" style={{ width: '100%', border: 0, background: 'none', textAlign: 'left', borderBottom: '1px solid var(--border)' }} onClick={() => onOpen(t.id)}>
          <div className="row">
            {t.pinned && <Icon name="pin" className="icon-sm" />}
            {t.locked && <Icon name="lock" className="icon-sm" />}
            <b className="grow ellipsis">{t.title}</b>
            <span className="tiny faint">{timeShort(t.lastMessageAt || t.createdAt)}</span>
          </div>
          <div className="small muted">by {t.creator.displayName} · {t.messageCount} message{t.messageCount === 1 ? '' : 's'}</div>
        </button>
      ))}
      {creating && (
        <Modal title="New topic" onClose={() => setCreating(false)} footer={<><button className="btn" onClick={() => setCreating(false)}>Cancel</button><button className="btn btn-primary" disabled={!title.trim() || !body.trim()} onClick={create}>Post topic</button></>}>
          <Field label="Title"><input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={140} autoFocus /></Field>
          <Field label="Message"><textarea className="input" value={body} onChange={(e) => setBody(e.target.value)} maxLength={4000} /></Field>
        </Modal>
      )}
    </div>
  );
}

/**
 * A full conversation view: DMs, groups and Space channels (including forum topics).
 */
export default function Conversation({ id, threadId, onBack, onOpenThread, onCloseThread, backAlways }) {
  const { me, handleError, setActiveConversation, confirm, refreshConversations, toast } = useApp();
  const nav = useNavigate();
  const [conv, setConv] = useState(null);
  const [error, setError] = useState(null);
  const [messages, setMessages] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [replyTo, setReplyTo] = useState(null);
  const [editing, setEditing] = useState(null);
  const [typing, setTyping] = useState({});
  const [info, setInfo] = useState(null); // null | tab name
  const [report, setReport] = useState(null);
  const [highlight, setHighlight] = useState(null);
  const [thread, setThread] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [openMenu, menu] = useMenu();
  const scroller = useRef(null);
  const stick = useRef(true);
  const prevHeight = useRef(null);
  const myId = me?.user?.id;

  const loadConv = useCallback(async () => {
    try {
      const r = await api.get(`/api/conversations/${id}`, { quiet: true });
      setConv(r.conversation);
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [id]);

  const loadMessages = useCallback(async (around) => {
    const q = new URLSearchParams({ limit: '50' });
    if (threadId) q.set('threadId', threadId);
    if (around) q.set('around', around);
    const r = await api.get(`/api/conversations/${id}/messages?${q}`, { quiet: true });
    setMessages(r.messages);
    setCursor(r.beforeCursor);
    return r.messages;
  }, [id, threadId]);

  useEffect(() => {
    setConv(null);
    setMessages([]);
    setReplyTo(null);
    setEditing(null);
    setTyping({});
    setInfo(null);
    stick.current = true;
    loadConv();
    setActiveConversation(id);
    return () => setActiveConversation(null);
  }, [id, loadConv, setActiveConversation]);

  const isForumRoot = conv?.channelType === 'forum' && !threadId;
  useEffect(() => {
    if (!conv || isForumRoot) return;
    stick.current = true;
    loadMessages().catch(handleError);
    if (threadId) {
      api.get(`/api/conversations/${id}/threads`).then((r) => setThread(r.threads.find((t) => t.id === threadId) || null)).catch(() => {});
    } else setThread(null);
  }, [conv?.id, isForumRoot, threadId, loadMessages, handleError, id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mark as read when new messages arrive while the conversation is visible.
  const lastAt = messages[messages.length - 1]?.createdAt;
  useEffect(() => {
    if (!conv?.isMember || !lastAt) return undefined;
    const t = setTimeout(() => {
      if (document.visibilityState === 'visible') api.post(`/api/conversations/${id}/read`, { at: lastAt }, { quiet: true }).catch(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [id, lastAt, conv?.isMember]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (prevHeight.current !== null) {
      el.scrollTop = el.scrollHeight - prevHeight.current;
      prevHeight.current = null;
    } else if (stick.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  useRealtime((e) => {
    if (e.conversationId !== id) return;
    const inThread = (m) => (m.threadId || null) === (threadId || null);
    if (e.type === 'message:new' && inThread(e.message)) {
      setMessages((list) => (list.some((m) => m.id === e.message.id) ? list : [...list, e.message]));
      setTyping((t) => {
        const n = { ...t };
        delete n[e.message.sender?.id];
        return n;
      });
      if (e.message.sender?.id === myId) stick.current = true;
    } else if (e.type === 'message:update' || e.type === 'message:delete') {
      setMessages((list) => list.map((m) => (m.id === e.message.id ? { ...e.message, poll: e.message.poll && { ...e.message.poll, myVote: m.poll?.myVote } } : m)));
    } else if (e.type === 'typing' && (e.threadId || null) === (threadId || null)) {
      setTyping((t) => ({ ...t, [e.user.id]: { name: e.user.displayName, until: Date.now() + 5000 } }));
    } else if (e.type === 'read') {
      setConv((c) => (c ? { ...c, otherLastReadAt: Math.max(c.otherLastReadAt || 0, e.at) } : c));
    } else if (e.type === 'conversation:update') {
      loadConv();
    } else if (e.type === 'conversation:removed') {
      toast('You no longer have access to this conversation.');
      onBack?.();
    }
  }, [id, threadId, myId]);

  useEffect(() => {
    const t = setInterval(() => setTyping((ty) => Object.fromEntries(Object.entries(ty).filter(([, v]) => v.until > Date.now()))), 1500);
    return () => clearInterval(t);
  }, []);

  const onScroll = async () => {
    const el = scroller.current;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (el.scrollTop < 120 && cursor && !loadingOlder) {
      setLoadingOlder(true);
      try {
        const q = new URLSearchParams({ limit: '50', before: cursor });
        if (threadId) q.set('threadId', threadId);
        const r = await api.get(`/api/conversations/${id}/messages?${q}`);
        prevHeight.current = el.scrollHeight - el.scrollTop;
        setMessages((list) => [...r.messages.filter((m) => !list.some((x) => x.id === m.id)), ...list]);
        setCursor(r.beforeCursor);
      } catch (err) {
        handleError(err);
      } finally {
        setLoadingOlder(false);
      }
    }
  };

  const jumpTo = useCallback(async (msgId) => {
    let el = document.getElementById(`m-${msgId}`);
    if (!el) {
      stick.current = false;
      try {
        await loadMessages(msgId);
      } catch (err) {
        return handleError(err);
      }
      await new Promise((r) => requestAnimationFrame(r));
      el = document.getElementById(`m-${msgId}`);
    }
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setHighlight(msgId);
    setTimeout(() => setHighlight(null), 2000);
    if (window.innerWidth < 1200) setInfo(null);
  }, [loadMessages, handleError]);

  const join = async () => {
    try {
      const r = await api.post(`/api/conversations/${id}/join`);
      toast(r.status === 'joined' ? 'Joined' : 'Request sent');
      loadConv();
      refreshConversations();
    } catch (err) {
      handleError(err);
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files?.length && (conv.can.uploadFiles || conv.can.sendMedia)) {
      uploadMany(e.dataTransfer.files, () => {}).then(async (items) => {
        const ids = items.filter((i) => i.file).map((i) => i.file.id);
        if (ids.length) await api.post(`/api/conversations/${id}/messages`, { fileIds: ids, threadId }).catch(handleError);
      });
    }
  };

  if (error) {
    return (
      <div className="conversation-main">
        <PaneHeader title="Conversation" onBack={onBack} back={backAlways ? 'always' : true} />
        <Empty icon="lock" title={error.status === 404 ? 'Conversation not found' : 'Unable to open'}>{error.message}</Empty>
      </div>
    );
  }
  if (!conv) return <Loading />;

  const isDm = conv.type === 'dm';
  const isChannel = conv.type === 'channel';
  const otherOnline = isDm && conv.otherUser?.online;
  const subtitle = isDm
    ? otherOnline ? 'online' : conv.otherUser?.lastSeenAt ? `last seen ${relative(conv.otherUser.lastSeenAt)}` : conv.otherUser?.statusText || `@${conv.otherUser?.username || ''}`
    : isChannel ? conv.description || (thread ? `Topic in #${conv.name}` : '') : `${conv.memberCount} members`;
  const typingNames = Object.values(typing).map((t) => t.name);

  let disabledReason = null;
  if (conv.preview) disabledReason = null;
  else if (conv.blocked) disabledReason = "You can't message this user.";
  else if (threadId && !conv.can.replyThreads) disabledReason = thread?.locked ? 'This topic is locked.' : "You can't reply here.";
  else if (threadId && thread?.locked && !conv.can.manageMessages) disabledReason = 'This topic is locked.';
  else if (!threadId && !conv.can.send) {
    disabledReason = conv.locked ? 'This conversation is locked by moderators.'
      : conv.channelType === 'announcement' ? 'Only moderators and admins can post announcements.' : "You don't have permission to send messages here.";
  }

  const convMenu = (e) => openMenu(e, [
    { label: 'Search', icon: 'search', onClick: () => setInfo('search') },
    { label: 'Media', icon: 'image', onClick: () => setInfo('media') },
    { label: 'Files', icon: 'file', onClick: () => setInfo('files') },
    { label: 'Links', icon: 'link', onClick: () => setInfo('links') },
    { label: `Pinned messages${conv.pinnedCount ? ` (${conv.pinnedCount})` : ''}`, icon: 'pin', onClick: () => setInfo('pinned') },
    'sep',
    {
      label: conv.muted ? 'Unmute' : 'Mute', icon: conv.muted ? 'volume' : 'mute', hidden: !conv.isMember,
      onClick: async () => {
        await api.patch(`/api/conversations/${id}/me`, { muted: !conv.muted }).catch(handleError);
        loadConv();
        refreshConversations();
      },
    },
    {
      label: conv.otherUser?.blocked ? 'Unblock user' : 'Block user', icon: 'ban', hidden: !isDm || !conv.otherUser,
      onClick: async () => {
        const blocked = conv.otherUser.blocked;
        if (!blocked && !(await confirm({ title: `Block ${conv.otherUser.displayName}?`, message: "They won't be able to message you, and you won't be able to message them.", confirmLabel: 'Block', danger: true }))) return;
        await (blocked ? api.del(`/api/users/${conv.otherUser.id}/block`) : api.put(`/api/users/${conv.otherUser.id}/block`)).catch(handleError);
        loadConv();
      },
    },
    { label: 'Report', icon: 'flag', onClick: () => setReport(isDm ? { targetType: 'user', targetId: conv.otherUser?.id, label: conv.otherUser?.displayName } : { targetType: 'conversation', targetId: id, label: conv.name }) },
    'sep',
    {
      label: 'Clear conversation', icon: 'refresh', hidden: !conv.isMember || isChannel,
      onClick: async () => {
        if (!(await confirm({ title: 'Clear conversation?', message: 'Messages are removed from your view only. Others still see them.', confirmLabel: 'Clear', danger: true }))) return;
        await api.post(`/api/conversations/${id}/clear`).catch(handleError);
        setMessages([]);
        refreshConversations();
      },
    },
    {
      label: isDm ? 'Delete conversation' : 'Leave group', icon: 'trash', danger: true, hidden: isChannel || !conv.isMember,
      onClick: async () => {
        if (!(await confirm({ title: isDm ? 'Delete conversation?' : 'Leave group?', message: isDm ? 'This removes the chat and its history from your list. The other person keeps their copy.' : 'You can rejoin later with an invite.', confirmLabel: isDm ? 'Delete' : 'Leave', danger: true }))) return;
        await (isDm ? api.del(`/api/conversations/${id}`) : api.del(`/api/conversations/${id}/members/${myId}`)).catch(handleError);
        refreshConversations();
        nav('/chats');
      },
    },
    {
      label: 'Delete group for everyone', icon: 'trash', danger: true, hidden: conv.type !== 'group' || conv.myRole !== 'owner',
      onClick: async () => {
        if (!(await confirm({ title: 'Delete group?', message: 'This removes the group for all members.', confirmLabel: 'Delete group', danger: true }))) return;
        await api.del(`/api/conversations/${id}`).catch(handleError);
        refreshConversations();
        nav('/chats');
      },
    },
  ]);

  const title = (
    <button className="conv-title" onClick={() => setInfo(info ? null : 'overview')} aria-label="Conversation details">
      {isChannel ? (
        <Icon name={thread ? 'forum' : channelIcon(conv)} />
      ) : (
        <Avatar name={conv.name} fileId={conv.avatarFileId} size={38} online={otherOnline} />
      )}
      <span className="grow" style={{ minWidth: 0 }}>
        <span className="bold ellipsis" style={{ display: 'block' }}>{thread ? thread.title : conv.name}</span>
        {subtitle && <span className="small muted ellipsis" style={{ display: 'block' }}>{subtitle}</span>}
      </span>
    </button>
  );

  const receiptFor = (m) => (isDm && conv.otherLastReadAt !== undefined ? (conv.otherLastReadAt || 0) >= m.createdAt : undefined);

  return (
    <div className="conversation">
      <div className="conversation-main" onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop} style={{ position: 'relative' }}>
        <header className="pane-header with-back">
          <IconButton icon="back" label="Back" onClick={threadId ? onCloseThread : onBack} className={`back-btn ${threadId || backAlways ? 'always' : ''}`} />
          {title}
          <IconButton icon="search" label="Search in conversation" onClick={() => setInfo('search')} />
          <IconButton icon="info" label="Details" onClick={() => setInfo(info ? null : 'overview')} active={!!info} />
          <IconButton icon="more" label="Conversation menu" onClick={convMenu} />
        </header>
        {conv.preview && (
          <div className="notice info row between" style={{ borderRadius: 0 }}>
            <span>You're previewing this {conv.type === 'group' ? 'group' : 'channel'}.</span>
            {conv.type === 'group' && <button className="btn btn-primary btn-sm" onClick={join}>{conv.joinMode === 'approval' ? 'Request to join' : 'Join'}</button>}
          </div>
        )}
        {conv.slowModeSeconds > 0 && !conv.can.moderate && <div className="tiny faint" style={{ textAlign: 'center', padding: 4 }}>Slow mode: one message every {conv.slowModeSeconds}s</div>}
        {isForumRoot ? (
          <ForumView conv={conv} onOpen={(tid) => onOpenThread?.(tid)} />
        ) : (
          <>
            <div className="messages" ref={scroller} onScroll={onScroll} role="log" aria-live="polite">
              {loadingOlder && <div className="center"><div className="spinner" /></div>}
              {!cursor && messages.length > 0 && !threadId && (
                <div className="system-msg">{isDm ? `This is the beginning of your conversation with ${conv.name}.` : `Welcome to ${isChannel ? '#' : ''}${conv.name}.`}</div>
              )}
              {!messages.length && (
                <Empty icon="chat" title={isDm ? `Say hi to ${conv.name}` : 'No messages yet'}>
                  {isDm ? 'Messages are encrypted in transit and at rest on our servers.' : 'Start the conversation.'}
                </Empty>
              )}
              {messages.map((m, i) => {
                const prev = messages[i - 1];
                const newDay = !prev || new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
                return (
                  <Fragment key={m.id}>
                    {newDay && <div className="day-sep">{dayLabel(m.createdAt)}</div>}
                    <Message
                      m={m}
                      prev={newDay ? null : prev}
                      me={myId}
                      showSender={!isDm}
                      can={conv.can}
                      receipt={m.sender?.id === myId ? receiptFor(m) : undefined}
                      highlight={highlight === m.id}
                      onReply={setReplyTo}
                      onEdit={setEditing}
                      onReport={(msg) => setReport({ targetType: 'message', targetId: msg.id, label: 'message' })}
                      onJump={jumpTo}
                    />
                  </Fragment>
                );
              })}
            </div>
            <div className="typing">{typingNames.length ? `${typingNames.slice(0, 2).join(', ')}${typingNames.length > 2 ? ' and others' : ''} ${typingNames.length > 1 ? 'are' : 'is'} typing…` : ''}</div>
            {!conv.preview && (
              <Composer
                conversation={conv}
                threadId={threadId}
                replyTo={replyTo}
                onCancelReply={() => setReplyTo(null)}
                editing={editing}
                onCancelEdit={() => setEditing(null)}
                disabledReason={disabledReason}
              />
            )}
          </>
        )}
        {dragging && (conv.can.uploadFiles || conv.can.sendMedia) && <div className="dropzone">Drop files to send</div>}
      </div>
      {info && (
        <>
          <div className="details-backdrop" onClick={() => setInfo(null)} />
          <ConversationInfo conv={conv} tab={info} setTab={setInfo} onClose={() => setInfo(null)} onJump={jumpTo} reload={loadConv} onReport={setReport} />
        </>
      )}
      {report && <ReportDialog {...report} spaceId={conv.spaceId} onClose={() => setReport(null)} />}
      {menu}
    </div>
  );
}

export { channelIcon };
