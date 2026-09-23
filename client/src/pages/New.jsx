import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Panes } from '../components/Shell.jsx';
import { Avatar, Field, Icon, Modal, Segmented, Toggle } from '../components/ui.jsx';
import { TOPICS } from '../utils.js';

export function PeoplePicker({ multiple, onPick, picked = [] }) {
  const [q, setQ] = useState('');
  const [users, setUsers] = useState([]);
  useEffect(() => {
    const t = setTimeout(() => {
      const req = q.trim().length >= 2 ? api.get(`/api/users/search?q=${encodeURIComponent(q.trim())}`).then((r) => r.users) : api.get('/api/users/contacts').then((r) => r.contacts);
      req.then(setUsers).catch(() => setUsers([]));
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  return (
    <>
      <div className="search mb-3"><Icon name="search" className="icon-sm" /><input autoFocus placeholder="Search by name or @username" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {!q && <div className="section-title" style={{ padding: '0 0 6px' }}>Contacts</div>}
      <div className="list">
        {users.map((u) => {
          const on = picked.some((p) => p.id === u.id);
          return (
            <button key={u.id} className={`list-item ${on ? 'active' : ''}`} onClick={() => onPick(u)} style={{ padding: '8px 4px' }}>
              <Avatar name={u.displayName} fileId={u.avatarFileId} size={40} online={u.online} />
              <div className="grow" style={{ minWidth: 0 }}><div className="bold ellipsis">{u.displayName}</div><div className="small muted">@{u.username}</div></div>
              {multiple && on && <Icon name="check" />}
            </button>
          );
        })}
        {!users.length && <div className="small muted">{q.trim().length >= 2 ? 'No people found.' : 'Search for people by username.'}</div>}
      </div>
    </>
  );
}

function NewMessage({ onClose }) {
  const nav = useNavigate();
  const { handleError, refreshConversations } = useApp();
  const pick = async (u) => {
    try {
      const r = await api.post('/api/conversations/dm', { userId: u.id });
      refreshConversations();
      nav(`/chats/${r.conversation.id}`);
    } catch (err) {
      handleError(err);
    }
  };
  return <Modal title="New message" onClose={onClose}><PeoplePicker onPick={pick} /></Modal>;
}

function NewGroup({ onClose }) {
  const nav = useNavigate();
  const { handleError, refreshConversations } = useApp();
  const [step, setStep] = useState(1);
  const [members, setMembers] = useState([]);
  const [form, setForm] = useState({ name: '', description: '', visibility: 'private', discoverable: false, joinMode: 'invite', topic: '' });
  const create = async () => {
    try {
      const r = await api.post('/api/conversations/groups', { ...form, memberIds: members.map((m) => m.id) });
      refreshConversations();
      nav(`/chats/${r.conversation.id}`);
    } catch (err) {
      handleError(err);
    }
  };
  if (step === 1) {
    return (
      <Modal title="Add members" onClose={onClose} footer={<><span className="grow small muted">{members.length} selected</span><button className="btn btn-primary" onClick={() => setStep(2)}>Next</button></>}>
        <PeoplePicker multiple picked={members} onPick={(u) => setMembers(members.some((m) => m.id === u.id) ? members.filter((m) => m.id !== u.id) : [...members, u])} />
      </Modal>
    );
  }
  return (
    <Modal title="New group" onClose={onClose} footer={<><button className="btn" onClick={() => setStep(1)}>Back</button><button className="btn btn-primary" disabled={!form.name.trim()} onClick={create}>Create group</button></>}>
      <Field label="Group name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={80} autoFocus /></Field>
      <Field label="Description (optional)"><textarea className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={500} /></Field>
      <Field label="Visibility" hint="Public groups can be previewed and optionally listed in Explore.">
        <Segmented value={form.visibility} onChange={(v) => setForm({ ...form, visibility: v, discoverable: v === 'public' && form.discoverable })} options={[['private', 'Private'], ['public', 'Public']]} />
      </Field>
      {form.visibility === 'public' && (
        <>
          <div className="row between mb-3"><span>List in Explore</span><Toggle checked={form.discoverable} label="List in Explore" onChange={(v) => setForm({ ...form, discoverable: v })} /></div>
          <div className="row gap-3 wrap">
            <Field label="Joining"><select className="input" value={form.joinMode} onChange={(e) => setForm({ ...form, joinMode: e.target.value })}><option value="open">Anyone can join</option><option value="approval">Approval required</option><option value="invite">Invite only</option></select></Field>
            <Field label="Topic"><select className="input" value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })}><option value="">None</option>{Object.entries(TOPICS).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}</select></Field>
          </div>
        </>
      )}
    </Modal>
  );
}

function NewSpace({ onClose }) {
  const nav = useNavigate();
  const { handleError, refreshSpaces } = useApp();
  const [form, setForm] = useState({ name: '', description: '', visibility: 'private', discoverable: false, joinMode: 'invite', topic: '', language: 'en' });
  const create = async () => {
    try {
      const r = await api.post('/api/spaces', form);
      refreshSpaces();
      nav(`/spaces/${r.space.id}`);
    } catch (err) {
      handleError(err);
    }
  };
  return (
    <Modal title="Create a Space" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={form.name.trim().length < 2} onClick={create}>Create Space</button></>}>
      <p className="small muted">Spaces organise bigger communities into categories and channels. We'll set up #announcements, #rules, #general and #media to start.</p>
      <Field label="Space name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={80} autoFocus placeholder="JDM Garage" /></Field>
      <Field label="Description"><textarea className="input" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={1000} /></Field>
      <Field label="Visibility" hint="Private Spaces are invite-only and never appear in Explore.">
        <Segmented value={form.visibility} onChange={(v) => setForm({ ...form, visibility: v, discoverable: v === 'public' && form.discoverable })} options={[['private', 'Private'], ['public', 'Public']]} />
      </Field>
      {form.visibility === 'public' && (
        <>
          <div className="row between mb-3"><span>List in Explore</span><Toggle checked={form.discoverable} label="List in Explore" onChange={(v) => setForm({ ...form, discoverable: v })} /></div>
          <div className="row gap-3 wrap">
            <Field label="Joining"><select className="input" value={form.joinMode} onChange={(e) => setForm({ ...form, joinMode: e.target.value })}><option value="open">Anyone can join</option><option value="approval">Approval required</option><option value="invite">Invite only</option></select></Field>
            <Field label="Topic"><select className="input" value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })}><option value="">None</option>{Object.entries(TOPICS).map(([k, t]) => <option key={k} value={k}>{t.label}</option>)}</select></Field>
          </div>
        </>
      )}
    </Modal>
  );
}

function JoinInvite({ onClose }) {
  const nav = useNavigate();
  const [code, setCode] = useState('');
  const go = () => {
    const c = code.trim().split('/').filter(Boolean).pop();
    if (c) nav(`/invite/${c}`);
  };
  return (
    <Modal title="Join with an invite" onClose={onClose} footer={<button className="btn btn-primary" disabled={!code.trim()} onClick={go}>Continue</button>}>
      <Field label="Invite link or code"><input className="input" value={code} onChange={(e) => setCode(e.target.value)} placeholder="https://…/invite/ABCDEFGHJK" autoFocus onKeyDown={(e) => e.key === 'Enter' && go()} /></Field>
    </Modal>
  );
}

function AddContact({ onClose }) {
  const nav = useNavigate();
  return <Modal title="Find people" onClose={onClose}><PeoplePicker onPick={(u) => nav(`/u/${u.username}`)} /></Modal>;
}

export default function NewPage() {
  const [dialog, setDialog] = useState(null);
  const options = [
    ['message', 'New message', 'Start a private conversation', 'chat'],
    ['group', 'New group', 'A simple group chat for friends, family or teams', 'users'],
    ['space', 'Create a Space', 'An organised community with channels and roles', 'grid'],
    ['invite', 'Join with invite', 'Use an invite link or code', 'link'],
    ['contact', 'Find people', 'Search by username and add contacts', 'search'],
  ];
  const main = (
    <>
      <header className="pane-header"><h1>Create or join</h1></header>
      <div className="pane-body">
        <div className="content-narrow p-4 col gap-3">
          {options.map(([k, title, desc, icon]) => (
            <button key={k} className="card row gap-3" style={{ textAlign: 'left', cursor: 'pointer', margin: 0 }} onClick={() => setDialog(k)}>
              <span className="center" style={{ width: 44, height: 44, borderRadius: 12, background: 'var(--accent-soft)', color: 'var(--accent)', flex: 'none' }}><Icon name={icon} /></span>
              <div className="grow"><b>{title}</b><div className="small muted">{desc}</div></div>
              <Icon name="chevron" className="icon-sm faint" />
            </button>
          ))}
        </div>
      </div>
      {dialog === 'message' && <NewMessage onClose={() => setDialog(null)} />}
      {dialog === 'group' && <NewGroup onClose={() => setDialog(null)} />}
      {dialog === 'space' && <NewSpace onClose={() => setDialog(null)} />}
      {dialog === 'invite' && <JoinInvite onClose={() => setDialog(null)} />}
      {dialog === 'contact' && <AddContact onClose={() => setDialog(null)} />}
    </>
  );
  return <Panes single main={main} />;
}
