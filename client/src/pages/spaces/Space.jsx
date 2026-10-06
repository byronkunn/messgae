import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useApp, useRealtime } from '../../store.jsx';
import { Panes } from '../../components/Shell.jsx';
import Conversation, { channelIcon } from '../../components/Conversation.jsx';
import { Avatar, Empty, Icon, IconButton, Loading, useMenu } from '../../components/ui.jsx';
import { ReportDialog } from '../../components/FileDialogs.jsx';
import { copyText, TOPICS } from '../../utils.js';

export function useSpace(spaceId) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    try {
      setData(await api.get(`/api/spaces/${spaceId}`, { quiet: true }));
      setError(null);
    } catch (err) {
      setError(err);
    }
  }, [spaceId]);
  useEffect(() => {
    setData(null);
    load();
  }, [load]);
  return { data, error, reload: load };
}

export const has = (perms, flags, key) => !!(perms & flags?.[key]?.bit);

function ChannelList({ data, activeId, reload }) {
  const { space, categories, channels } = data;
  const { handleError, toast, confirm, refreshSpaces } = useApp();
  const nav = useNavigate();
  const [openMenu, menu] = useMenu();
  const [report, setReport] = useState(false);
  const f = data.permissionFlags;
  const canManage = has(space.perms, f, 'MANAGE_SPACE') || has(space.perms, f, 'MANAGE_CHANNELS') || has(space.perms, f, 'MANAGE_ROLES') || has(space.perms, f, 'MODERATE') || has(space.perms, f, 'MANAGE_MEMBERS');

  const invite = async () => {
    try {
      const r = await api.post(`/api/spaces/${space.id}/invites`, { expiresInHours: 24 * 7 });
      await copyText(`${location.origin}/invite/${r.invite.code}`);
      toast('Invite link copied');
    } catch (err) {
      handleError(err);
    }
  };
  const leave = async () => {
    if (!(await confirm({ title: `Leave ${space.name}?`, confirmLabel: 'Leave', danger: true }))) return;
    try {
      await api.post(`/api/spaces/${space.id}/leave`);
      refreshSpaces();
      nav('/chats');
    } catch (err) {
      handleError(err);
    }
  };
  const join = async () => {
    try {
      const r = await api.post(`/api/spaces/${space.id}/join`);
      toast(r.status === 'joined' ? `Welcome to ${space.name}!` : 'Request sent to the moderators');
      refreshSpaces();
      reload();
    } catch (err) {
      handleError(err);
    }
  };

  const groups = [
    ...categories.map((c) => ({ ...c, channels: channels.filter((ch) => ch.categoryId === c.id) })),
    { id: null, name: '', channels: channels.filter((ch) => !ch.categoryId || !categories.some((c) => c.id === ch.categoryId)) },
  ].filter((g) => g.channels.length);

  return (
    <>
      <div className="space-banner">{space.bannerFileId && <img src={`/api/files/${space.bannerFileId}/content`} alt="" />}</div>
      <header className="pane-header" style={{ position: 'relative' }}>
        <IconButton icon="back" label="Back to chats" onClick={() => nav('/chats')} className="back-btn" />
        <Avatar name={space.name} fileId={space.iconFileId} size={32} square />
        <h1 className="ellipsis" style={{ fontSize: 17 }}>{space.name}</h1>
        {space.isMember && has(space.perms, f, 'CREATE_INVITES') && <IconButton icon="users" label="Invite people" onClick={invite} />}
        <IconButton icon="more" label="Space menu" onClick={(e) => openMenu(e, [
          { label: 'Invite people', icon: 'link', onClick: invite, hidden: !space.isMember || !has(space.perms, f, 'CREATE_INVITES') },
          { label: 'Space settings', icon: 'settings', onClick: () => nav(`/spaces/${space.id}/settings`), hidden: !canManage },
          { label: 'Copy Space ID', icon: 'hash', onClick: () => copyText(space.id).then(() => toast('Copied')) },
          { label: 'Report Space', icon: 'flag', onClick: () => setReport(true), hidden: space.isOwner },
          'sep',
          { label: 'Leave Space', icon: 'logout', danger: true, onClick: leave, hidden: !space.isMember || space.isOwner },
        ])} />
      </header>
      <div className="pane-body">
        {!space.isMember && (
          <div className="p-4">
            <div className="notice info">
              <div className="bold">{space.memberCount} members</div>
              <div className="small">{space.description || 'Public Space'}</div>
              <button className="btn btn-primary btn-sm mt-3" disabled={space.requested || space.joinMode === 'invite'} onClick={join}>
                {space.requested ? 'Request pending' : space.joinMode === 'approval' ? 'Request to join' : space.joinMode === 'invite' ? 'Invite only' : 'Join Space'}
              </button>
            </div>
          </div>
        )}
        {space.timeoutUntil && <div className="notice warn" style={{ margin: 12 }}>You're timed out until {new Date(space.timeoutUntil).toLocaleTimeString()}.</div>}
        {groups.map((g) => (
          <div className="category" key={g.id || 'none'}>
            {g.name && <div className="category-name">{g.name}</div>}
            {g.channels.map((c) => (
              <Link key={c.id} to={`/spaces/${space.id}/c/${c.id}`} className={`channel-link ${activeId === c.id ? 'on' : ''} ${c.unread ? 'unread' : ''}`}>
                <Icon name={channelIcon(c)} className="icon-sm" />
                <span className="grow ellipsis">{c.name}</span>
                {c.unread > 0 && <span className="badge">{c.unread}</span>}
              </Link>
            ))}
          </div>
        ))}
      </div>
      {menu}
      {report && <ReportDialog targetType="space" targetId={space.id} label={space.name} onClose={() => setReport(false)} />}
    </>
  );
}

function SpaceHome({ data }) {
  const { space, channels } = data;
  const nav = useNavigate();
  const first = channels.find((c) => c.channelType === 'text') || channels[0];
  return (
    <div className="pane-body">
      <div className="space-banner" style={{ height: 140 }}>{space.bannerFileId && <img src={`/api/files/${space.bannerFileId}/content`} alt="" />}</div>
      <div className="content-narrow p-4 col gap-3">
        <div className="row gap-3">
          <Avatar name={space.name} fileId={space.iconFileId} size={72} square />
          <div>
            <h1>{space.name}</h1>
            <div className="muted small">{space.memberCount} members · {space.visibility === 'public' ? 'Public' : 'Private'}{space.topic ? ` · ${TOPICS[space.topic]?.emoji} ${TOPICS[space.topic]?.label}` : ''}</div>
          </div>
        </div>
        {space.description && <p style={{ whiteSpace: 'pre-wrap' }}>{space.description}</p>}
        {first && <button className="btn btn-primary" style={{ alignSelf: 'flex-start' }} onClick={() => nav(`/spaces/${space.id}/c/${first.id}`)}>Open #{first.name}</button>}
      </div>
    </div>
  );
}

export default function SpacePage() {
  const { spaceId, channelId, threadId } = useParams();
  const nav = useNavigate();
  const { data, error, reload } = useSpace(spaceId);
  useRealtime((e) => {
    if (e.type === 'message:new' && data?.channels?.some((c) => c.id === e.conversationId) && e.conversationId !== channelId) reload();
  }, [data, channelId]);
  useEffect(() => {
    if (channelId) {
      const t = setTimeout(reload, 1200);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [channelId, reload]);

  if (error) return <Panes detail single main={<Empty icon="lock" title="Space not available">{error.message}</Empty>} />;
  if (!data) return <Panes detail={!!channelId} list={<Loading />} main={<Loading />} />;
  const main = channelId ? (
    <Conversation
      key={`${channelId}-${threadId || ''}`}
      id={channelId}
      threadId={threadId}
      onBack={() => nav(`/spaces/${spaceId}`)}
      onOpenThread={(tid) => nav(`/spaces/${spaceId}/c/${channelId}/t/${tid}`)}
      onCloseThread={() => nav(`/spaces/${spaceId}/c/${channelId}`)}
    />
  ) : <SpaceHome data={data} />;
  return <Panes detail={!!channelId} list={<ChannelList data={data} activeId={channelId} reload={reload} />} main={main} />;
}
