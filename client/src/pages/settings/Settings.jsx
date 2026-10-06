import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import QRCode from 'qrcode';
import { api } from '../../api.js';
import { useApp } from '../../store.jsx';
import { Panes } from '../../components/Shell.jsx';
import { Avatar, Empty, Field, Icon, Loading, Modal, PaneHeader, Segmented, Toggle } from '../../components/ui.jsx';
import { MyFilesPicker } from '../../components/FileDialogs.jsx';
import { RecoveryKit } from '../Auth.jsx';
import { formatBytes, relative, dateTime } from '../../utils.js';

const PAGES = [
  ['profile', 'Edit profile', 'user'],
  ['privacy', 'Privacy', 'eye'],
  ['security', 'Security & devices', 'shield'],
  ['blocked', 'Blocked users', 'ban'],
  ['plan', 'Plan & storage', 'star'],
  ['appearance', 'Appearance', 'sun'],
  ['about', 'Privacy model', 'info'],
];

function EditProfile() {
  const { me, handleError, toast, setMe } = useApp();
  const u = me.user;
  const [form, setForm] = useState({ displayName: u.displayName, username: u.username, bio: u.bio, statusText: u.statusText, statusEmoji: u.statusEmoji, links: u.links || [] });
  const [pick, setPick] = useState(null);
  const save = async (patch = form) => {
    try {
      const r = await api.patch('/api/me/profile', patch);
      setMe((m) => ({ ...m, user: r.user }));
      toast('Profile saved');
    } catch (err) {
      handleError(err);
    }
  };
  return (
    <div className="p-4 content-narrow">
      <div className="row gap-3 mb-3 wrap">
        <Avatar name={u.displayName} fileId={u.avatarFileId} size={72} />
        <div className="col">
          <button className="btn btn-sm" onClick={() => setPick('avatarFileId')}>Change avatar</button>
          <button className="btn btn-sm" onClick={() => setPick('bannerFileId')}>Change banner</button>
        </div>
        {(u.avatarFileId || u.bannerFileId) && <button className="btn btn-sm btn-ghost" onClick={() => save({ avatarFileId: null, bannerFileId: null })}>Remove images</button>}
      </div>
      <p className="hint">Animated (GIF) avatars and banners are included with Plus.</p>
      <Field label="Display name"><input className="input" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} maxLength={48} /></Field>
      <Field label="Username"><input className="input" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value.replace(/[^a-zA-Z0-9_]/g, '') })} maxLength={32} /></Field>
      <div className="row gap-3">
        <Field label="Status emoji"><input className="input" value={form.statusEmoji} onChange={(e) => setForm({ ...form, statusEmoji: e.target.value })} maxLength={16} style={{ width: 80 }} /></Field>
        <div className="grow"><Field label="Status"><input className="input" value={form.statusText} onChange={(e) => setForm({ ...form, statusText: e.target.value })} maxLength={80} placeholder="What's up?" /></Field></div>
      </div>
      <Field label="Bio"><textarea className="input" value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} maxLength={500} /></Field>
      <div className="label mb-3">Links</div>
      {form.links.map((l, i) => (
        <div key={i} className="input-group mb-3">
          <input className="input" style={{ maxWidth: 140 }} placeholder="Label" value={l.label} onChange={(e) => setForm({ ...form, links: form.links.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
          <input className="input" placeholder="https://" value={l.url} onChange={(e) => setForm({ ...form, links: form.links.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)) })} />
          <button className="btn" onClick={() => setForm({ ...form, links: form.links.filter((_, j) => j !== i) })} aria-label="Remove link"><Icon name="x" className="icon-sm" /></button>
        </div>
      ))}
      {form.links.length < 5 && <button className="btn btn-sm mb-3" onClick={() => setForm({ ...form, links: [...form.links, { label: '', url: '' }] })}><Icon name="plus" className="icon-sm" /> Add link</button>}
      <div><button className="btn btn-primary" onClick={() => save()}>Save profile</button></div>
      {pick && <MyFilesPicker accept="image" multiple={false} title="Choose an image" onClose={() => setPick(null)} onPick={([f]) => { save({ [pick]: f.id }); setPick(null); }} />}
    </div>
  );
}

function Privacy() {
  const { me, handleError, refreshMe } = useApp();
  const [p, setP] = useState(me.user.privacy);
  const set = async (key, value) => {
    const prev = p;
    setP({ ...p, [key]: value });
    try {
      await api.patch('/api/me/privacy', { [key]: value });
      refreshMe();
    } catch (err) {
      setP(prev);
      handleError(err);
    }
  };
  const aud = [['everyone', 'Everyone'], ['contacts', 'Contacts'], ['nobody', 'Nobody']];
  const Row = ({ k, label, options, hint }) => (
    <div className="card">
      <div className="bold mb-3">{label}</div>
      <Segmented value={p[k]} onChange={(v) => set(k, v)} options={options} />
      {hint && <div className="hint mt-2">{hint}</div>}
    </div>
  );
  const Switch = ({ k, label, hint }) => (
    <div className="card row between">
      <div><div className="bold">{label}</div>{hint && <div className="hint">{hint}</div>}</div>
      <Toggle checked={p[k]} label={label} onChange={(v) => set(k, v)} />
    </div>
  );
  return (
    <div className="p-4 content-narrow">
      <Row k="onlineStatus" label="Who can see my online status?" options={aud} />
      <Row k="lastSeen" label="Who can see when I was last seen?" options={aud} />
      <Row k="whoCanMessage" label="Who can message me?" options={[['everyone', 'Everyone'], ['contacts', 'Contacts'], ['mutual_groups', 'Mutual groups'], ['nobody', 'Nobody']]} hint="Existing conversations are not affected." />
      <Row k="whoCanAddToGroups" label="Who can add me to groups?" options={aud} hint="Others can still send you an invite link." />
      <Row k="joinedSpaces" label="Who can see which Spaces I've joined?" options={aud} />
      <Row k="mutualGroups" label="Who can see our mutual groups?" options={aud} />
      <Row k="profileLinks" label="Who can see my profile links?" options={aud} />
      <Switch k="readReceipts" label="Read receipts" hint="If turned off, you won't see other people's read receipts either." />
      <Switch k="typingIndicators" label="Typing indicators" />
      <Switch k="discoverable" label="Appear in people search" hint="When off, people need your exact username to find you." />
    </div>
  );
}

function Security() {
  const { me, handleError, toast, confirm, refreshMe, prompt } = useApp();
  const [sessions, setSessions] = useState(null);
  const [linkCode, setLinkCode] = useState('');
  const [newKey, setNewKey] = useState(null);
  const [totp, setTotp] = useState(null);
  const [totpCode, setTotpCode] = useState('');
  const load = useCallback(() => api.get('/api/me/sessions').then((r) => setSessions(r.sessions)).catch(handleError), [handleError]);
  useEffect(() => {
    load();
  }, [load]);

  const revoke = async (s) => {
    if (!(await confirm({ title: `Sign out ${s.deviceName}?`, confirmLabel: 'Sign out', danger: true }))) return;
    api.del(`/api/me/sessions/${s.id}`).then(() => { toast('Device signed out'); load(); }).catch(handleError);
  };
  const regenerate = async () => {
    const trusted = sessions?.find((s) => s.current)?.createdAt < Date.now() - 7 * 86400000;
    let body = {};
    if (!trusted) {
      const key = await prompt({ title: 'Confirm with your current Recovery Key', message: me.user.totpEnabled ? 'Or enter a 2FA code instead.' : 'Required on devices signed in for less than 7 days.', label: me.user.totpEnabled ? 'Recovery Key or 2FA code' : 'Current Recovery Key', minLength: 6 });
      if (!key) return;
      body = /^\d{6}$/.test(key) ? { totpCode: key } : { currentRecoveryKey: key };
    } else if (!(await confirm({ title: 'Generate a new Recovery Key?', message: 'Your current Recovery Key and Recovery Kit will stop working immediately.', confirmLabel: 'Generate', danger: true }))) return;
    try {
      const r = await api.post('/api/me/recovery/regenerate', body);
      setNewKey(r);
      refreshMe();
    } catch (err) {
      handleError(err);
    }
  };
  const setup2fa = async () => {
    try {
      const r = await api.post('/api/me/2fa/setup');
      setTotp({ ...r, qr: await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 320 }) });
    } catch (err) {
      handleError(err);
    }
  };
  const enable2fa = async () => {
    try {
      await api.post('/api/me/2fa/enable', { code: totpCode });
      toast('Two-factor authentication enabled');
      setTotp(null);
      setTotpCode('');
      refreshMe();
    } catch (err) {
      handleError(err);
    }
  };
  const disable2fa = async () => {
    const code = await prompt({ title: 'Disable two-factor authentication', label: 'Authenticator code', minLength: 6 });
    if (!code) return;
    api.post('/api/me/2fa/disable', { code }).then(() => { toast('2FA disabled'); refreshMe(); }).catch(handleError);
  };

  return (
    <div className="p-4 content-narrow">
      <h3 className="mb-3">Devices</h3>
      {!sessions ? <Loading /> : (
        <div className="card" style={{ padding: 0 }}>
          {sessions.map((s) => (
            <div key={s.id} className="list-item" style={{ cursor: 'default' }}>
              <Icon name={s.deviceType === 'mobile' ? 'device' : 'laptop'} />
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="bold">{s.deviceName} {s.current && <span className="tag ok">This device</span>}</div>
                <div className="tiny muted">Active {relative(s.lastActiveAt)} · signed in {dateTime(s.createdAt)}{s.ip ? ` · ${s.ip}` : ''}</div>
              </div>
              {!s.current && <button className="btn btn-sm" onClick={() => revoke(s)}>Sign out</button>}
            </div>
          ))}
        </div>
      )}
      {sessions?.length > 1 && (
        <button className="btn btn-sm mt-3" onClick={async () => { if (await confirm({ title: 'Sign out all other devices?', confirmLabel: 'Sign out others', danger: true })) api.post('/api/me/sessions/revoke-others').then(() => { toast('Other devices signed out'); load(); }).catch(handleError); }}>Sign out all other devices</button>
      )}
      <div className="card mt-4">
        <b>Link a device</b>
        <p className="small muted">On the new device choose “Link this device”, then scan its QR code with this phone's camera or enter the code shown.</p>
        <div className="input-group">
          <input className="input mono" placeholder="ABCD-EFGH" value={linkCode} onChange={(e) => setLinkCode(e.target.value.toUpperCase())} />
          <Link className="btn btn-primary" to={`/link-device#${linkCode.replace(/[^0-9A-Z]/g, '')}`} onClick={(e) => !linkCode && e.preventDefault()}>Continue</Link>
        </div>
      </div>

      <h3 className="mb-3 mt-4">Recovery Key</h3>
      <div className="card">
        <p className="small muted">Last generated {relative(me.user.recoveryRotatedAt)}. Generating a new key invalidates the previous one and your old Recovery Kit.</p>
        <button className="btn" onClick={regenerate}><Icon name="key" className="icon-sm" /> Generate new Recovery Key</button>
      </div>

      <h3 className="mb-3 mt-4">Two-factor authentication</h3>
      <div className="card">
        {me.user.totpEnabled ? (
          <>
            <p className="small"><span className="tag ok">Enabled</span> Authenticator app codes protect sensitive actions.</p>
            <button className="btn btn-sm" onClick={disable2fa}>Disable 2FA</button>
          </>
        ) : (
          <>
            <p className="small muted">Add an authenticator app (TOTP). Required for staff accounts and used to confirm sensitive changes like regenerating your Recovery Key.</p>
            <button className="btn btn-sm btn-primary" onClick={setup2fa}>Set up 2FA</button>
          </>
        )}
      </div>

      {newKey && (
        <Modal title="Your new Recovery Kit" onClose={() => setNewKey(null)}>
          <RecoveryKit accountId={newKey.accountId} recoveryKey={newKey.recoveryKey} onDone={() => setNewKey(null)} doneLabel="Done" />
        </Modal>
      )}
      {totp && (
        <Modal title="Set up two-factor authentication" onClose={() => setTotp(null)} footer={<button className="btn btn-primary" disabled={totpCode.length !== 6} onClick={enable2fa}>Verify & enable</button>}>
          <p className="small muted">Scan with an authenticator app, or enter the secret manually.</p>
          <div className="center mb-3"><span className="qr"><img src={totp.qr} alt="2FA QR code" /></span></div>
          <div className="recovery-key mb-3" style={{ fontSize: 14 }}>{totp.secret}</div>
          <Field label="6-digit code"><input className="input mono" inputMode="numeric" maxLength={6} value={totpCode} onChange={(e) => setTotpCode(e.target.value.replace(/\D/g, ''))} autoFocus /></Field>
        </Modal>
      )}
    </div>
  );
}

function Blocked() {
  const { handleError } = useApp();
  const [users, setUsers] = useState(null);
  const load = useCallback(() => api.get('/api/users/blocked').then((r) => setUsers(r.users)).catch(handleError), [handleError]);
  useEffect(() => {
    load();
  }, [load]);
  if (!users) return <Loading />;
  if (!users.length) return <Empty icon="ban" title="No blocked users" />;
  return (
    <div className="list">
      {users.map((u) => (
        <div key={u.id} className="list-item" style={{ cursor: 'default' }}>
          <Avatar name={u.displayName} fileId={u.avatarFileId} size={36} />
          <div className="grow"><b>{u.displayName}</b><div className="small muted">@{u.username}</div></div>
          <button className="btn btn-sm" onClick={() => api.del(`/api/users/${u.id}/block`).then(load).catch(handleError)}>Unblock</button>
        </div>
      ))}
    </div>
  );
}

function Plan() {
  const { me } = useApp();
  const usage = me.usage;
  const plan = me.plan;
  return (
    <div className="p-4 content-narrow">
      <div className="card mb-3">
        <div className="row between"><b>Current plan: {plan.label}</b><span className="tag accent">{plan.priceMonthly ? `$${plan.priceMonthly}/mo` : 'Free'}</span></div>
        <div className="mt-3 small muted">{formatBytes(usage.storageBytes)} of {formatBytes(plan.storageBytes)} storage used</div>
        <div className="usage-bar mt-2"><div style={{ width: `${Math.min(100, (usage.storageBytes / plan.storageBytes) * 100)}%` }} /></div>
        <div className="small muted mt-2">{usage.activeLinks} of {plan.activeLinks} active share links</div>
      </div>
      <div className="card">
        <h3>Plus</h3>
        <p className="small muted">Core messaging is always free. Plus adds more room for files and customisation.</p>
        <ul className="small">
          <li>200 GB storage and uploads up to 4 GB</li>
          <li>Longer trash retention (90 days) and 500 active share links</li>
          <li>Groups up to 5,000 members</li>
          <li>Animated avatar and banner, higher-quality media</li>
          <li>More file-transfer bandwidth</li>
        </ul>
        <button className="btn btn-primary" disabled title="Payments are not enabled yet">Upgrade — coming soon</button>
        <p className="tiny faint mt-2">We don't sell ads based on your behaviour. Paid plans keep the service running.</p>
      </div>
    </div>
  );
}

function Appearance() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem('theme') || 'system';
    } catch {
      return 'system';
    }
  });
  const apply = (t) => {
    setTheme(t);
    try {
      localStorage.setItem('theme', t);
    } catch {
      /* ignore */
    }
    if (t === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', t);
  };
  return (
    <div className="p-4 content-narrow">
      <Field label="Theme"><Segmented value={theme} onChange={apply} options={[['system', 'System'], ['light', 'Light'], ['dark', 'Dark']]} /></Field>
    </div>
  );
}

function About() {
  return (
    <div className="p-4 content-narrow col gap-3">
      <div className="notice info">
        <b>How your data is protected</b>
      </div>
      <p>Connections use HTTPS/TLS. Messages and files are stored on our servers and <b>encrypted at rest</b>; files are encrypted with per-file keys derived from a key kept outside the database.</p>
      <p><b>Messaging is not end-to-end encrypted.</b> Our servers can read message contents so we can provide search, moderation and safety features. Authorized staff with a special “Evidence Access” permission can view conversations and files — and reveal stored file passwords — during investigations. Each access requires a stated reason, a fresh two-factor check, and is recorded in a tamper-evident audit log.</p>
      <p>Private accounts don't need an email or phone number. We store a one-way verifier of your Recovery Key, never the key itself.</p>
      <p>We don't build advertising profiles from your conversations.</p>
    </div>
  );
}

export default function SettingsPage() {
  const { page } = useParams();
  const nav = useNavigate();
  const current = PAGES.find(([k]) => k === page);
  const list = (
    <>
      <PaneHeader title="Settings" onBack={() => nav('/profile')} back="always" />
      <div className="pane-body">
        <div className="list">
          {PAGES.map(([k, l, ic]) => (
            <Link key={k} to={`/settings/${k}`} className={`list-item ${page === k ? 'active' : ''}`}><Icon name={ic} /><span className="grow">{l}</span><Icon name="chevron" className="icon-sm faint" /></Link>
          ))}
        </div>
      </div>
    </>
  );
  const Page = { profile: EditProfile, privacy: Privacy, security: Security, blocked: Blocked, plan: Plan, appearance: Appearance, about: About }[page];
  const main = current ? (
    <>
      <PaneHeader title={current[1]} onBack={() => nav('/settings')} />
      <div className="pane-body"><Page /></div>
    </>
  ) : <Empty icon="settings" title="Settings">Choose a section.</Empty>;
  return <Panes detail={!!current} list={list} main={main} />;
}
