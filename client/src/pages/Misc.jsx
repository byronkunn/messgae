import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Avatar, Icon, Loading, Field } from '../components/ui.jsx';
import { formatBytes, dateTime, relative } from '../utils.js';

/** Approve a new device from a signed-in device (opened via QR code or code entry). */
export function ApproveDevice() {
  const { hash } = useLocation();
  const nav = useNavigate();
  const { handleError, toast } = useApp();
  const code = hash.replace('#', '');
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!code) return setError('No device code provided.');
    api.get(`/api/auth/link/${code}`, { quiet: true }).then(setInfo).catch((e) => setError(e.message));
  }, [code]);
  const approve = async () => {
    try {
      await api.post(`/api/auth/link/${code}/approve`);
      toast('Device linked');
      nav('/settings/security');
    } catch (err) {
      handleError(err);
    }
  };
  return (
    <div className="auth">
      <div className="auth-card card">
        <h1 className="mb-3">Link a new device?</h1>
        {error ? <div className="notice danger">{error}</div> : !info ? <Loading /> : (
          <>
            <div className="notice warn mb-3">Only approve if <b>you</b> are signing in on this device right now. It will get full access to your account.</div>
            <dl className="kv mb-3">
              <dt>Device</dt><dd>{info.deviceName}</dd>
              <dt>Type</dt><dd>{info.deviceType}</dd>
              <dt>IP address</dt><dd>{info.ip}</dd>
              <dt>Requested</dt><dd>{dateTime(info.createdAt)}</dd>
            </dl>
            <div className="row">
              <Link className="btn grow" to="/chats">Cancel</Link>
              <button className="btn btn-primary grow" onClick={approve}>Approve</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function InvitePage() {
  const { code } = useParams();
  const nav = useNavigate();
  const { handleError, refreshConversations, refreshSpaces } = useApp();
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get(`/api/invites/${code}`, { quiet: true }).then(setInfo).catch((e) => setError(e.message));
  }, [code]);
  const join = async () => {
    try {
      const r = await api.post(`/api/invites/${code}/join`);
      refreshConversations();
      refreshSpaces();
      nav(r.type === 'space' ? `/spaces/${r.id}` : `/chats/${r.id}`);
    } catch (err) {
      handleError(err);
    }
  };
  const target = info?.space || info?.group;
  return (
    <div className="auth">
      <div className="auth-card card" style={{ textAlign: 'center' }}>
        {error ? <><h1 className="mb-3">Invite not found</h1><p className="muted">{error}</p><Link className="btn" to="/chats">Go to chats</Link></> : !info ? <Loading /> : (
          <div className="col gap-3" style={{ alignItems: 'center' }}>
            <div className="small muted">{info.inviter?.displayName} invited you to join</div>
            <Avatar name={target.name} fileId={target.iconFileId || target.avatarFileId} size={80} square={info.type === 'space'} />
            <h1>{target.name}</h1>
            <div className="muted small">{info.type === 'space' ? 'Space' : 'Group'} · {target.memberCount} members</div>
            {target.description && <p className="small">{target.description}</p>}
            {info.invalid ? <div className="notice danger">This invite has {info.invalid === 'used_up' ? 'reached its limit' : info.invalid}.</div>
              : info.isMember ? <button className="btn btn-primary btn-block" onClick={() => nav(info.type === 'space' ? `/spaces/${target.id}` : `/chats/${target.id}`)}>Open</button>
              : <button className="btn btn-primary btn-block" onClick={join}>Accept invite</button>}
            <Link to="/chats" className="small">Not now</Link>
          </div>
        )}
      </div>
    </div>
  );
}

/** Public share-link page. Works signed out for "anyone" links. */
export function PublicLinkPage() {
  const { token } = useParams();
  const { me } = useApp();
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [ticket, setTicket] = useState(null);
  const [pwError, setPwError] = useState('');
  useEffect(() => {
    api.get(`/api/public/links/${token}`, { quiet: true }).then(async (m) => {
      setMeta(m);
      if (m.file && !m.passwordProtected) {
        const r = await api.post(`/api/public/links/${token}/unlock`, {}, { quiet: true });
        setTicket(r.ticket);
      }
    }).catch((e) => setError(e.message));
  }, [token]);
  const unlock = async (e) => {
    e.preventDefault();
    try {
      const r = await api.post(`/api/public/links/${token}/unlock`, { password }, { quiet: true });
      setTicket(r.ticket);
      setPwError('');
    } catch (err) {
      setPwError(err.message);
    }
  };
  const content = (download) => `/api/public/links/${token}/content?ticket=${encodeURIComponent(ticket)}${download ? '&download=1' : ''}`;
  return (
    <div className="auth">
      <div className="auth-card card">
        <div className="row mb-3"><img src="/favicon.svg" alt="" width={28} height={28} /><b>messgae</b><span className="grow" />{!me?.user && <Link to="/welcome" className="small">Create account</Link>}</div>
        {error ? <><h2 className="mb-3">Link unavailable</h2><p className="muted">{error}</p></> : !meta ? <Loading /> : meta.requiresLogin ? (
          <><h2 className="mb-3">Sign in required</h2><p className="muted">This file was shared with specific people. Sign in to check your access.</p><Link className="btn btn-primary" to="/signin" state={{ from: `/s/${token}` }}>Sign in</Link></>
        ) : (
          <div className="col gap-3">
            <div className="row gap-3">
              <span className="file-icon center" style={{ width: 52, height: 52, borderRadius: 12, background: 'var(--accent-soft)', color: 'var(--accent)', flex: 'none' }}><Icon name={meta.passwordProtected && !ticket ? 'lock' : 'file'} /></span>
              <div className="grow" style={{ minWidth: 0 }}>
                <h2 className="ellipsis">{meta.file.filename}</h2>
                <div className="small muted">{formatBytes(meta.file.size)} · shared by {meta.owner?.displayName}</div>
              </div>
            </div>
            <div className="tiny faint">{meta.expiresAt ? `Expires ${relative(meta.expiresAt)}` : 'No expiry'}{meta.downloadsRemaining !== null ? ` · ${meta.downloadsRemaining} downloads left` : ''}</div>
            {meta.passwordProtected && !ticket ? (
              <form onSubmit={unlock}>
                <Field label="Password"><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus /></Field>
                {pwError && <div className="notice danger mb-3">{pwError}</div>}
                <button className="btn btn-primary btn-block">Unlock</button>
              </form>
            ) : ticket && (
              <>
                {meta.file.category === 'image' && <img src={content(false)} alt={meta.file.filename} style={{ borderRadius: 12, maxHeight: 360, objectFit: 'contain' }} />}
                {meta.file.category === 'video' && <video src={content(false)} controls style={{ borderRadius: 12 }} />}
                {meta.file.category === 'audio' && <audio src={content(false)} controls style={{ width: '100%' }} />}
                {meta.allowDownload ? <a className="btn btn-primary btn-block" href={content(true)}><Icon name="download" className="icon-sm" /> Download</a> : <div className="notice">The owner disabled downloads for this link.</div>}
              </>
            )}
            <p className="tiny faint">Only download files from people you trust.</p>
          </div>
        )}
      </div>
    </div>
  );
}
