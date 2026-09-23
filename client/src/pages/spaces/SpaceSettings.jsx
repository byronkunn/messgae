import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../../api.js';
import { useApp } from '../../store.jsx';
import { Panes } from '../../components/Shell.jsx';
import { Avatar, Empty, Field, Icon, IconButton, Loading, Modal, PaneHeader, Segmented, Toggle, useMenu } from '../../components/ui.jsx';
import { MyFilesPicker } from '../../components/FileDialogs.jsx';
import { copyText, dateTime, relative, TOPICS, formatNumber } from '../../utils.js';
import { useSpace, has } from './Space.jsx';
import { channelIcon } from '../../components/Conversation.jsx';
import { Chart } from '../admin/Charts.jsx';

const SECTIONS = [
  ['overview', 'Overview', 'settings', 'MANAGE_SPACE'],
  ['channels', 'Channels & categories', 'hash', 'MANAGE_CHANNELS'],
  ['roles', 'Roles & permissions', 'shield', 'MANAGE_ROLES'],
  ['members', 'Members', 'users', 'MANAGE_MEMBERS'],
  ['invites', 'Invites', 'link', 'CREATE_INVITES'],
  ['moderation', 'Moderation', 'flag', 'MODERATE'],
  ['audit', 'Audit log', 'audit', 'MANAGE_SPACE'],
  ['analytics', 'Analytics', 'chart', 'MANAGE_SPACE'],
];

function Overview({ data, reload }) {
  const { space } = data;
  const { handleError, toast, confirm, prompt, refreshSpaces } = useApp();
  const nav = useNavigate();
  const [form, setForm] = useState({ name: space.name, description: space.description, language: space.language });
  const [pick, setPick] = useState(null);
  const save = async (patch) => {
    try {
      await api.patch(`/api/spaces/${space.id}`, patch);
      toast('Saved');
      reload();
      refreshSpaces();
    } catch (err) {
      handleError(err);
    }
  };
  const del = async () => {
    const name = await prompt({ title: 'Delete Space', message: `This permanently removes ${space.name} and all its channels for everyone.`, label: `Type "${space.name}" to confirm`, confirmLabel: 'Delete Space', danger: true });
    if (name === null) return;
    try {
      await api.del(`/api/spaces/${space.id}`, { confirmName: name });
      refreshSpaces();
      nav('/chats');
    } catch (err) {
      handleError(err);
    }
  };
  const transfer = async () => {
    const username = await prompt({ title: 'Transfer ownership', label: 'Username of the new owner', message: 'You will keep administrator access.' });
    if (!username) return;
    try {
      const u = await api.get(`/api/users/by-username/${encodeURIComponent(username.replace(/^@/, ''))}`);
      if (!(await confirm({ title: `Make ${u.user.displayName} the owner?`, confirmLabel: 'Transfer', danger: true }))) return;
      await api.post(`/api/spaces/${space.id}/transfer`, { userId: u.user.id });
      toast('Ownership transferred');
      reload();
    } catch (err) {
      handleError(err);
    }
  };
  return (
    <div className="p-4 content-narrow">
      <div className="row gap-3 mb-3 wrap">
        <Avatar name={space.name} fileId={space.iconFileId} size={72} square />
        <button className="btn btn-sm" onClick={() => setPick('iconFileId')}>Change icon</button>
        <button className="btn btn-sm" onClick={() => setPick('bannerFileId')}>Change banner</button>
      </div>
      <Field label="Name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={80} /></Field>
      <Field label="Description"><textarea className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={1000} /></Field>
      <Field label="Language"><input className="input" value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })} maxLength={8} /></Field>
      <button className="btn btn-primary mb-3" onClick={() => save(form)}>Save changes</button>
      <hr />
      <h3 className="mb-3">Visibility & discovery</h3>
      <Field label="Visibility" hint="Private Spaces never appear in Explore and can only be joined by invite.">
        <Segmented value={space.visibility} onChange={(v) => save({ visibility: v })} options={[['public', 'Public'], ['private', 'Private']]} />
      </Field>
      {space.visibility === 'public' && (
        <>
          <div className="row between mb-3"><span>Show in Explore</span><Toggle checked={space.discoverable} label="Show in Explore" onChange={(v) => save({ discoverable: v })} /></div>
          <div className="row gap-3 wrap">
            <Field label="Joining">
              <select className="input" value={space.joinMode} onChange={(e) => save({ joinMode: e.target.value })}>
                <option value="open">Anyone can join</option><option value="approval">Approval required</option><option value="invite">Invite only</option>
              </select>
            </Field>
            <Field label="Topic">
              <select className="input" value={space.topic || ''} onChange={(e) => save({ topic: e.target.value })}>
                <option value="">None</option>{Object.entries(TOPICS).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}
              </select>
            </Field>
          </div>
        </>
      )}
      <hr />
      <h3 className="mb-3">Plan</h3>
      <p className="small muted">{space.plan === 'pro' ? 'Space Pro' : 'Free'} · up to {formatNumber(space.planLimits.channels)} channels, {formatNumber(space.planLimits.roles)} roles, {space.planLimits.auditDays}-day audit history.</p>
      {space.isOwner && (
        <>
          <hr />
          <h3 className="mb-3 danger-text">Danger zone</h3>
          <div className="row wrap">
            <button className="btn" onClick={transfer}><Icon name="crown" className="icon-sm" /> Transfer ownership</button>
            <button className="btn btn-danger" onClick={del}><Icon name="trash" className="icon-sm" /> Delete Space</button>
          </div>
        </>
      )}
      {pick && <MyFilesPicker accept="image" multiple={false} title="Choose an image" onClose={() => setPick(null)} onPick={([f]) => { save({ [pick]: f.id }); setPick(null); }} />}
    </div>
  );
}

/** Tri-state permission editor: Allow / Inherit / Deny per flag (channel overrides). */
function OverrideEditor({ flags, value, onChange }) {
  return (
    <div className="col" style={{ gap: 6 }}>
      {Object.entries(flags).filter(([k]) => k !== 'ADMINISTRATOR').map(([k, f]) => {
        const state = value.allow & f.bit ? 'allow' : value.deny & f.bit ? 'deny' : 'inherit';
        return (
          <div key={k} className="row between wrap" style={{ gap: 6 }}>
            <span className="small">{f.label}</span>
            <Segmented value={state} options={[['deny', '✕'], ['inherit', '/'], ['allow', '✓']]} onChange={(s) => {
              const allow = (value.allow & ~f.bit) | (s === 'allow' ? f.bit : 0);
              const deny = (value.deny & ~f.bit) | (s === 'deny' ? f.bit : 0);
              onChange({ allow, deny });
            }} />
          </div>
        );
      })}
    </div>
  );
}

function ChannelPermissions({ data, channel, onClose }) {
  const { handleError, toast } = useApp();
  const [overrides, setOverrides] = useState(null);
  const [target, setTarget] = useState(null);
  const [value, setValue] = useState({ allow: 0, deny: 0 });
  const load = useCallback(() => api.get(`/api/spaces/${data.space.id}/channels/${channel.id}/permissions`).then((r) => setOverrides(r.overrides)).catch(handleError), [data.space.id, channel.id, handleError]);
  useEffect(() => {
    load();
  }, [load]);
  const select = (roleId) => {
    setTarget(roleId);
    const o = overrides?.find((x) => x.targetType === 'role' && x.targetId === roleId);
    setValue({ allow: o?.allow || 0, deny: o?.deny || 0 });
  };
  const save = async () => {
    try {
      await api.put(`/api/spaces/${data.space.id}/channels/${channel.id}/permissions`, { targetType: 'role', targetId: target, ...value });
      toast('Permissions updated');
      load();
    } catch (err) {
      handleError(err);
    }
  };
  return (
    <Modal title={`#${channel.name} permissions`} onClose={onClose} wide footer={target && <button className="btn btn-primary" onClick={save}>Save overrides</button>}>
      <p className="small muted">Channel overrides are applied on top of Space role permissions: @everyone first, then roles, then individual members.</p>
      <div className="chips" style={{ padding: '0 0 12px' }}>
        {data.roles.map((r) => (
          <button key={r.id} className={`chip ${target === r.id ? 'on' : ''}`} onClick={() => select(r.id)}>
            {r.name}{overrides?.some((o) => o.targetId === r.id) ? ' •' : ''}
          </button>
        ))}
      </div>
      {target ? <OverrideEditor flags={data.permissionFlags} value={value} onChange={setValue} /> : <div className="muted small">Choose a role to edit its overrides for this channel.</div>}
    </Modal>
  );
}

function Channels({ data, reload }) {
  const { handleError, toast, prompt, confirm } = useApp();
  const { space, categories, channels, roles } = data;
  const [editing, setEditing] = useState(null);
  const [creating, setCreating] = useState(false);
  const [perms, setPerms] = useState(null);
  const [openMenu, menu] = useMenu();
  const call = async (fn, msg) => {
    try {
      await fn();
      if (msg) toast(msg);
      reload();
    } catch (err) {
      handleError(err);
    }
  };
  const addCategory = async () => {
    const name = await prompt({ title: 'New category', label: 'Name', placeholder: 'e.g. CARS' });
    if (name) call(() => api.post(`/api/spaces/${space.id}/categories`, { name }), 'Category created');
  };
  const catMenu = (e, c) => openMenu(e, [
    { label: 'Rename', icon: 'edit', onClick: async () => { const name = await prompt({ title: 'Rename category', label: 'Name', defaultValue: c.name }); if (name) call(() => api.patch(`/api/spaces/${space.id}/categories/${c.id}`, { name })); } },
    { label: 'Move up', icon: 'upload', onClick: () => call(() => api.patch(`/api/spaces/${space.id}/categories/${c.id}`, { position: Math.max(0, c.position - 1) })) },
    { label: 'Delete category', icon: 'trash', danger: true, onClick: async () => { if (await confirm({ title: `Delete ${c.name}?`, message: 'Channels inside it are kept and become uncategorized.', danger: true, confirmLabel: 'Delete' })) call(() => api.del(`/api/spaces/${space.id}/categories/${c.id}`)); } },
  ]);
  const groups = [...categories.map((c) => ({ ...c, channels: channels.filter((ch) => ch.categoryId === c.id) })), { id: null, name: 'Uncategorized', channels: channels.filter((ch) => !ch.categoryId) }];
  return (
    <div className="p-4 content-narrow">
      <div className="row wrap mb-3">
        <button className="btn btn-primary btn-sm" onClick={() => setCreating(true)}><Icon name="plus" className="icon-sm" /> New channel</button>
        <button className="btn btn-sm" onClick={addCategory}><Icon name="plus" className="icon-sm" /> New category</button>
      </div>
      {groups.filter((g) => g.id || g.channels.length).map((g) => (
        <div key={g.id || 'none'} className="card mb-3" style={{ padding: 0 }}>
          <div className="row between" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
            <b className="small">{g.name}</b>
            {g.id && <IconButton icon="more" label="Category actions" onClick={(e) => catMenu(e, g)} />}
          </div>
          {g.channels.map((c) => (
            <div key={c.id} className="list-item" style={{ cursor: 'default', minHeight: 48 }}>
              <Icon name={channelIcon(c)} className="icon-sm" />
              <div className="grow"><b>{c.name}</b> <span className="tiny faint">{c.channelType}{c.isPrivate ? ' · private' : ''}</span></div>
              <IconButton icon="shield" label="Permissions" onClick={() => setPerms(c)} />
              <IconButton icon="edit" label="Edit channel" onClick={() => setEditing(c)} />
              <IconButton icon="trash" label="Delete channel" onClick={async () => { if (await confirm({ title: `Delete #${c.name}?`, message: 'Messages in this channel will no longer be accessible.', danger: true, confirmLabel: 'Delete' })) call(() => api.del(`/api/spaces/${space.id}/channels/${c.id}`), 'Channel deleted'); }} />
            </div>
          ))}
          {!g.channels.length && <div className="small muted p-4">No channels</div>}
        </div>
      ))}
      {(creating || editing) && <ChannelForm data={data} channel={editing} onClose={() => { setCreating(false); setEditing(null); }} onSaved={reload} roles={roles} />}
      {perms && <ChannelPermissions data={data} channel={perms} onClose={() => setPerms(null)} />}
      {menu}
    </div>
  );
}

function ChannelForm({ data, channel, onClose, onSaved, roles }) {
  const { handleError, toast } = useApp();
  const [form, setForm] = useState({
    name: channel?.name || '', description: channel?.description || '', type: channel?.channelType || 'text',
    categoryId: channel?.categoryId || data.categories[0]?.id || '', isPrivate: channel?.isPrivate || false, allowedRoleIds: [],
  });
  const save = async () => {
    try {
      if (channel) {
        await api.patch(`/api/spaces/${data.space.id}/channels/${channel.id}`, { name: form.name, description: form.description, categoryId: form.categoryId || null, isPrivate: form.isPrivate });
      } else {
        await api.post(`/api/spaces/${data.space.id}/channels`, { ...form, categoryId: form.categoryId || null });
      }
      toast(channel ? 'Channel updated' : 'Channel created');
      onSaved();
      onClose();
    } catch (err) {
      handleError(err);
    }
  };
  return (
    <Modal title={channel ? `Edit #${channel.name}` : 'New channel'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!form.name.trim()} onClick={save}>{channel ? 'Save' : 'Create'}</button></>}>
      {!channel && (
        <Field label="Type">
          <div className="col" style={{ gap: 6 }}>
            {[['text', 'Text', 'Normal conversation', 'hash'], ['announcement', 'Announcement', 'Only moderators and admins post', 'megaphone'], ['media', 'Media', 'Optimised for images, videos and files', 'gallery'], ['forum', 'Forum', 'Conversations organised into topics', 'forum']].map(([v, l, d, ic]) => (
              <label key={v} className={`list-item ${form.type === v ? 'active' : ''}`} style={{ borderRadius: 10, border: '1px solid var(--border)', minHeight: 48 }}>
                <input type="radio" name="type" checked={form.type === v} onChange={() => setForm({ ...form, type: v })} hidden />
                <Icon name={ic} />
                <div><b>{l}</b><div className="tiny muted">{d}</div></div>
              </label>
            ))}
          </div>
        </Field>
      )}
      <Field label="Name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="new-channel" maxLength={60} autoFocus /></Field>
      <Field label="Description"><input className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={500} /></Field>
      <Field label="Category">
        <select className="input" value={form.categoryId} onChange={(e) => setForm({ ...form, categoryId: e.target.value })}>
          <option value="">None</option>
          {data.categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      <div className="row between mb-3"><span><b>Private channel</b><div className="tiny muted">Only selected roles can see it.</div></span><Toggle checked={form.isPrivate} label="Private" onChange={(v) => setForm({ ...form, isPrivate: v })} /></div>
      {form.isPrivate && !channel && (
        <Field label="Roles with access">
          <div className="chips" style={{ padding: 0, flexWrap: 'wrap' }}>
            {roles.filter((r) => r.systemKey !== 'everyone').map((r) => {
              const on = form.allowedRoleIds.includes(r.id);
              return <button key={r.id} className={`chip ${on ? 'on' : ''}`} onClick={() => setForm({ ...form, allowedRoleIds: on ? form.allowedRoleIds.filter((x) => x !== r.id) : [...form.allowedRoleIds, r.id] })}>{r.name}</button>;
            })}
          </div>
        </Field>
      )}
    </Modal>
  );
}

function Roles({ data, reload }) {
  const { handleError, toast, confirm } = useApp();
  const { space, permissionFlags: flags } = data;
  const [roles, setRoles] = useState(null);
  const [edit, setEdit] = useState(null);
  const load = useCallback(() => api.get(`/api/spaces/${space.id}/roles`).then((r) => setRoles(r.roles)).catch(handleError), [space.id, handleError]);
  useEffect(() => {
    load();
  }, [load]);
  const save = async () => {
    try {
      if (edit.id) await api.patch(`/api/spaces/${space.id}/roles/${edit.id}`, { name: edit.name, color: edit.color, permissions: edit.permissions });
      else await api.post(`/api/spaces/${space.id}/roles`, { name: edit.name, color: edit.color, permissions: edit.permissions });
      toast('Role saved');
      setEdit(null);
      load();
      reload();
    } catch (err) {
      handleError(err);
    }
  };
  if (!roles) return <Loading />;
  return (
    <div className="p-4 content-narrow">
      <p className="small muted">Roles are listed from highest to lowest. Members can only manage roles below their own highest role. Space roles never grant site-wide staff permissions.</p>
      <button className="btn btn-primary btn-sm mb-3" onClick={() => setEdit({ name: 'New role', color: '#7b61ff', permissions: flags.VIEW_CHANNEL.bit | flags.SEND_MESSAGES.bit })}><Icon name="plus" className="icon-sm" /> New role</button>
      <div className="card" style={{ padding: 0 }}>
        {roles.map((r) => (
          <div key={r.id} className="list-item" style={{ cursor: 'default' }}>
            <span style={{ width: 12, height: 12, borderRadius: 6, background: r.color || 'var(--text-3)' }} />
            <div className="grow"><b>{r.name}</b><div className="tiny muted">{r.memberCount} members{r.systemKey ? ' · default role' : ''}</div></div>
            <IconButton icon="edit" label="Edit role" onClick={() => setEdit({ ...r })} />
            {r.systemKey !== 'everyone' && <IconButton icon="trash" label="Delete role" onClick={async () => { if (await confirm({ title: `Delete ${r.name}?`, danger: true, confirmLabel: 'Delete' })) api.del(`/api/spaces/${space.id}/roles/${r.id}`).then(() => { load(); reload(); }).catch(handleError); }} />}
          </div>
        ))}
      </div>
      {edit && (
        <Modal title={edit.id ? `Edit ${edit.name}` : 'New role'} onClose={() => setEdit(null)} wide footer={<><button className="btn" onClick={() => setEdit(null)}>Cancel</button><button className="btn btn-primary" onClick={save}>Save</button></>}>
          <div className="row gap-3 wrap">
            <Field label="Name"><input className="input" value={edit.name} disabled={edit.systemKey === 'everyone'} onChange={(e) => setEdit({ ...edit, name: e.target.value })} maxLength={40} /></Field>
            <Field label="Color"><input className="input" type="color" value={edit.color || '#7b61ff'} onChange={(e) => setEdit({ ...edit, color: e.target.value })} style={{ width: 64, padding: 4 }} /></Field>
          </div>
          <div className="label mb-3">Permissions</div>
          <div className="col" style={{ gap: 4 }}>
            {Object.entries(flags).map(([k, f]) => (
              <label key={k} className="row between" style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
                <span className="small">{f.label}</span>
                <Toggle checked={!!(edit.permissions & f.bit)} label={f.label} disabled={k === 'ADMINISTRATOR' && edit.systemKey === 'everyone'} onChange={(v) => setEdit({ ...edit, permissions: v ? edit.permissions | f.bit : edit.permissions & ~f.bit })} />
              </label>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
}

function Members({ data, reload }) {
  const { handleError, toast, prompt } = useApp();
  const { space, roles, permissionFlags: flags } = data;
  const [q, setQ] = useState('');
  const [members, setMembers] = useState(null);
  const [assign, setAssign] = useState(null);
  const [openMenu, menu] = useMenu();
  const load = useCallback(() => api.get(`/api/spaces/${space.id}/members?q=${encodeURIComponent(q)}`).then(setMembers).catch(handleError), [space.id, q, handleError]);
  useEffect(() => {
    const t = setTimeout(load, 200);
    return () => clearTimeout(t);
  }, [load]);
  const run = async (fn, msg) => {
    try {
      await fn();
      toast(msg);
      load();
      reload();
    } catch (err) {
      handleError(err);
    }
  };
  const actions = (e, m) => openMenu(e, [
    { label: 'Assign roles', icon: 'shield', hidden: !has(space.perms, flags, 'MANAGE_ROLES'), onClick: () => setAssign({ member: m, roleIds: m.roleIds }) },
    { label: 'Time out', icon: 'clock', hidden: !has(space.perms, flags, 'MANAGE_MEMBERS'), onClick: async () => {
      const minutes = await prompt({ title: `Time out ${m.user.displayName}`, label: 'Minutes (0 to clear)', defaultValue: '60', type: 'number' });
      if (minutes !== null) run(() => api.post(`/api/spaces/${space.id}/members/${m.user.id}/timeout`, { minutes: Number(minutes) }), 'Timeout updated');
    } },
    { label: 'Kick', icon: 'logout', danger: true, hidden: !has(space.perms, flags, 'MANAGE_MEMBERS'), onClick: () => run(() => api.del(`/api/spaces/${space.id}/members/${m.user.id}`), 'Member removed') },
    { label: 'Ban', icon: 'ban', danger: true, hidden: !has(space.perms, flags, 'BAN_MEMBERS'), onClick: async () => {
      const reason = await prompt({ title: `Ban ${m.user.displayName}`, label: 'Reason', confirmLabel: 'Ban', danger: true });
      if (reason !== null) run(() => api.post(`/api/spaces/${space.id}/bans`, { userId: m.user.id, reason }), 'Member banned');
    } },
  ]);
  return (
    <div className="p-4 content-narrow">
      <div className="search mb-3"><Icon name="search" className="icon-sm" /><input placeholder="Search members" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {!members ? <Loading /> : (
        <div className="card" style={{ padding: 0 }}>
          <div className="small muted" style={{ padding: '8px 12px' }}>{members.total} members</div>
          {members.members.map((m) => (
            <div key={m.user.id} className="list-item" style={{ cursor: 'default' }}>
              <Avatar name={m.user.displayName} fileId={m.user.avatarFileId} size={36} online={m.user.online} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="bold ellipsis">{m.user.displayName} {m.isOwner && <Icon name="crown" className="icon-sm" title="Owner" />}</div>
                <div className="row wrap" style={{ gap: 4 }}>
                  <span className="tiny muted">@{m.user.username}</span>
                  {m.roleIds.map((rid) => { const r = roles.find((x) => x.id === rid); return r && <span key={rid} className="tag" style={{ color: r.color }}>{r.name}</span>; })}
                  {m.timeoutUntil && <span className="tag warn">timed out</span>}
                </div>
              </div>
              {!m.isOwner && <IconButton icon="more" label="Member actions" onClick={(e) => actions(e, m)} />}
            </div>
          ))}
        </div>
      )}
      {assign && (
        <Modal title={`Roles for ${assign.member.user.displayName}`} onClose={() => setAssign(null)} footer={<button className="btn btn-primary" onClick={() => { run(() => api.put(`/api/spaces/${space.id}/members/${assign.member.user.id}/roles`, { roleIds: assign.roleIds }), 'Roles updated'); setAssign(null); }}>Save</button>}>
          {roles.filter((r) => r.systemKey !== 'everyone').map((r) => (
            <label key={r.id} className="check" style={{ padding: '8px 0' }}>
              <input type="checkbox" checked={assign.roleIds.includes(r.id)} onChange={(e) => setAssign({ ...assign, roleIds: e.target.checked ? [...assign.roleIds, r.id] : assign.roleIds.filter((x) => x !== r.id) })} />
              <span style={{ color: r.color }}>{r.name}</span>
            </label>
          ))}
        </Modal>
      )}
      {menu}
    </div>
  );
}

function Invites({ data }) {
  const { handleError, toast } = useApp();
  const { space } = data;
  const [invites, setInvites] = useState(null);
  const [form, setForm] = useState({ expiresInHours: '168', maxUses: '' });
  const load = useCallback(() => api.get(`/api/spaces/${space.id}/invites`).then((r) => setInvites(r.invites)).catch(handleError), [space.id, handleError]);
  useEffect(() => {
    load();
  }, [load]);
  const create = async () => {
    try {
      const r = await api.post(`/api/spaces/${space.id}/invites`, { expiresInHours: form.expiresInHours ? Number(form.expiresInHours) : undefined, maxUses: form.maxUses ? Number(form.maxUses) : undefined });
      await copyText(`${location.origin}/invite/${r.invite.code}`);
      toast('Invite created and copied');
      load();
    } catch (err) {
      handleError(err);
    }
  };
  return (
    <div className="p-4 content-narrow">
      <div className="card mb-3">
        <div className="row gap-3 wrap">
          <Field label="Expires"><select className="input" value={form.expiresInHours} onChange={(e) => setForm({ ...form, expiresInHours: e.target.value })}><option value="1">1 hour</option><option value="24">1 day</option><option value="168">7 days</option><option value="">Never</option></select></Field>
          <Field label="Max uses"><input className="input" type="number" min="1" value={form.maxUses} placeholder="Unlimited" onChange={(e) => setForm({ ...form, maxUses: e.target.value })} /></Field>
        </div>
        <button className="btn btn-primary btn-sm" onClick={create}>Create invite link</button>
      </div>
      {!invites ? <Loading /> : !invites.length ? <Empty icon="link" title="No active invites" /> : invites.map((i) => (
        <div key={i.code} className="card row wrap">
          <code className="grow">{location.origin}/invite/{i.code}</code>
          <span className="small muted">{i.uses}{i.maxUses ? `/${i.maxUses}` : ''} uses · {i.expiresAt ? `expires ${relative(i.expiresAt)}` : 'never expires'}</span>
          <IconButton icon="copy" label="Copy" onClick={() => copyText(`${location.origin}/invite/${i.code}`).then(() => toast('Copied'))} />
          <IconButton icon="trash" label="Revoke" onClick={() => api.del(`/api/invites/${i.code}`).then(load).catch(handleError)} />
        </div>
      ))}
    </div>
  );
}

function Moderation({ data }) {
  const { handleError, toast, prompt } = useApp();
  const { space, permissionFlags: flags } = data;
  const [status, setStatus] = useState('open');
  const [reports, setReports] = useState(null);
  const [requests, setRequests] = useState([]);
  const [bans, setBans] = useState([]);
  const [log, setLog] = useState([]);
  const load = useCallback(() => {
    api.get(`/api/spaces/${space.id}/reports?status=${status}`).then((r) => setReports(r.reports)).catch(handleError);
    if (has(space.perms, flags, 'MANAGE_MEMBERS')) api.get(`/api/spaces/${space.id}/requests`).then((r) => setRequests(r.requests)).catch(() => {});
    if (has(space.perms, flags, 'BAN_MEMBERS')) api.get(`/api/spaces/${space.id}/bans`).then((r) => setBans(r.bans)).catch(() => {});
    api.get(`/api/spaces/${space.id}/moderation`).then((r) => setLog(r.actions)).catch(() => {});
  }, [space.id, status, space.perms, flags, handleError]);
  useEffect(() => {
    load();
  }, [load]);
  const update = async (r, next) => {
    const resolution = await prompt({ title: `Mark as ${next}`, label: 'Note (optional)', multiline: true });
    if (resolution === null) return;
    try {
      await api.patch(`/api/spaces/${space.id}/reports/${r.id}`, { status: next, resolution });
      toast('Report updated');
      load();
    } catch (err) {
      handleError(err);
    }
  };
  const removeMessage = async (r) => {
    try {
      await api.del(`/api/messages/${r.targetId}`, { reason: `Report ${r.id}` });
      toast('Message removed');
    } catch (err) {
      handleError(err);
    }
  };
  return (
    <div className="p-4 content-narrow">
      {requests.length > 0 && (
        <div className="card mb-3">
          <h3 className="mb-3">Join requests</h3>
          {requests.map((r) => (
            <div key={r.user.id} className="row" style={{ padding: '6px 0' }}>
              <Avatar name={r.user.displayName} size={32} />
              <div className="grow"><b>{r.user.displayName}</b><div className="tiny muted">{r.message}</div></div>
              <button className="btn btn-sm btn-primary" onClick={() => api.post(`/api/spaces/${space.id}/requests/${r.user.id}`, { approve: true }).then(load)}>Approve</button>
              <button className="btn btn-sm" onClick={() => api.post(`/api/spaces/${space.id}/requests/${r.user.id}`, { approve: false }).then(load)}>Decline</button>
            </div>
          ))}
        </div>
      )}
      <div className="row between wrap mb-3">
        <h3>Reports</h3>
        <Segmented value={status} onChange={setStatus} options={[['open', 'Open'], ['reviewing', 'Reviewing'], ['escalated', 'Escalated'], ['resolved', 'Resolved'], ['all', 'All']]} />
      </div>
      {!reports ? <Loading /> : !reports.length ? <Empty icon="flag" title="No reports" /> : reports.map((r) => (
        <div key={r.id} className="card">
          <div className="row between wrap"><b>{r.reason.replace('_', ' ')}</b><span className="tiny faint">{relative(r.createdAt)} · by @{r.reporter}</span></div>
          {r.details && <p className="small mt-2">{r.details}</p>}
          {r.evidence.message && (
            <div className="evidence mt-2">
              <div className="tiny faint">Reported message from {r.evidence.message.sender?.displayName}</div>
              <div style={{ whiteSpace: 'pre-wrap' }}>{r.evidence.message.body || r.evidence.message.attachments?.map((a) => a.filename).join(', ')}</div>
            </div>
          )}
          {r.evidence.user && <div className="evidence mt-2">User @{r.evidence.user.username}: {r.evidence.user.bio}</div>}
          <div className="row wrap mt-3">
            <button className="btn btn-sm" onClick={() => update(r, 'resolved')}>Resolve</button>
            <button className="btn btn-sm" onClick={() => update(r, 'dismissed')}>Dismiss</button>
            <button className="btn btn-sm" onClick={() => update(r, 'escalated')} title="Send to platform moderators">Escalate to site</button>
            {r.targetType === 'message' && <button className="btn btn-sm btn-danger" onClick={() => removeMessage(r)}>Remove message</button>}
          </div>
        </div>
      ))}
      {bans.length > 0 && (
        <div className="card mt-4">
          <h3 className="mb-3">Bans</h3>
          {bans.map((b) => (
            <div key={b.user.id} className="row" style={{ padding: '6px 0' }}>
              <div className="grow"><b>{b.user.displayName}</b> <span className="small muted">{b.reason}</span></div>
              <button className="btn btn-sm" onClick={() => api.del(`/api/spaces/${space.id}/bans/${b.user.id}`).then(load)}>Unban</button>
            </div>
          ))}
        </div>
      )}
      <div className="card mt-4">
        <h3 className="mb-3">Moderation log</h3>
        {!log.length ? <div className="small muted">No actions yet.</div> : log.map((a) => (
          <div key={a.id} className="small" style={{ padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
            <b>@{a.actor}</b> {a.action.replace(/_/g, ' ')} <span className="faint">{a.targetType} {a.targetId.slice(-6)}</span> {a.reason && `— ${a.reason}`} <span className="faint">· {relative(a.createdAt)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Audit({ data }) {
  const [res, setRes] = useState(null);
  useEffect(() => {
    api.get(`/api/spaces/${data.space.id}/audit`).then(setRes).catch(() => setRes({ entries: [] }));
  }, [data.space.id]);
  if (!res) return <Loading />;
  return (
    <div className="p-4 content-narrow">
      <p className="small muted">Showing the last {res.retentionDays} days. Space Pro keeps a longer history.</p>
      {!res.entries.length ? <Empty icon="audit" title="No entries" /> : (
        <div className="card" style={{ padding: 0 }}>
          {res.entries.map((e) => (
            <div key={e.id} className="small" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
              <b>@{e.actor}</b> {e.action} {e.target && <code className="faint">{e.target}</code>} <span className="faint">· {dateTime(e.createdAt)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Analytics({ data }) {
  const [res, setRes] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    api.get(`/api/spaces/${data.space.id}/analytics`, { quiet: true }).then(setRes).catch(setErr);
  }, [data.space.id]);
  if (err) return <Empty icon="chart" title="Space analytics is a Space Pro feature">Space Pro adds analytics, more storage, extra roles and channels, advanced moderation, custom branding and longer audit history.</Empty>;
  if (!res) return <Loading />;
  return (
    <div className="p-4">
      <div className="kpis">
        <div className="kpi"><div className="kpi-label">New members (30d)</div><div className="kpi-value">{formatNumber(res.joins30d)}</div></div>
        <div className="kpi"><div className="kpi-label">Messages (30d)</div><div className="kpi-value">{formatNumber(res.daily.reduce((a, d) => a + d.messages, 0))}</div></div>
      </div>
      <div className="panel"><div className="panel-head"><h3>Daily messages</h3></div><div className="panel-body"><Chart series={res.daily.map((d) => ({ t: d.date, value: d.messages }))} /></div></div>
      <div className="panel"><div className="panel-head"><h3>Top channels</h3></div>
        <ol className="rank-list">{res.channels.map((c, i) => <li key={c.id}><span className="rank">{i + 1}</span><span className="grow">#{c.name}</span><b>{formatNumber(c.messages)}</b></li>)}</ol>
      </div>
    </div>
  );
}

export default function SpaceSettings() {
  const { spaceId, '*': rest } = useParams();
  const section = rest || '';
  const nav = useNavigate();
  const { data, error, reload } = useSpace(spaceId);
  if (error) return <Panes detail single main={<Empty icon="lock" title="Not available">{error.message}</Empty>} />;
  if (!data) return <Panes detail single main={<Loading />} />;
  const { space, permissionFlags: flags } = data;
  const allowed = SECTIONS.filter(([, , , flag]) => has(space.perms, flags, flag));
  const current = allowed.find(([k]) => k === section);
  const list = (
    <>
      <PaneHeader title="Space settings" subtitle={space.name} onBack={() => nav(`/spaces/${space.id}`)} back="always" />
      <div className="pane-body">
        <div className="list">
          {allowed.map(([k, label, icon]) => (
            <Link key={k} to={`/spaces/${space.id}/settings/${k}`} className={`list-item ${section === k ? 'active' : ''}`}>
              <Icon name={icon} /> <span className="grow">{label}</span> <Icon name="chevron" className="icon-sm faint" />
            </Link>
          ))}
        </div>
      </div>
    </>
  );
  const Section = { overview: Overview, channels: Channels, roles: Roles, members: Members, invites: Invites, moderation: Moderation, audit: Audit, analytics: Analytics }[current?.[0]];
  const main = current ? (
    <>
      <PaneHeader title={current[1]} onBack={() => nav(`/spaces/${space.id}/settings`)} />
      <div className="pane-body"><Section data={data} reload={reload} /></div>
    </>
  ) : <Empty icon="settings" title="Space settings">Choose a section.</Empty>;
  return <Panes detail={!!current} list={list} main={main} />;
}
