import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import QRCode from 'qrcode';
import { api } from '../api.js';
import { useApp } from '../store.jsx';
import { Icon, Field, Spinner } from '../components/ui.jsx';
import { copyText, downloadBlob, dateTime } from '../utils.js';

const Logo = () => <img className="auth-logo" src="/favicon.svg" alt="" />;

export function Welcome() {
  return (
    <div className="auth">
      <div className="auth-card">
        <Logo />
        <h1 style={{ textAlign: 'center', fontSize: 28 }}>messgae</h1>
        <p className="muted" style={{ textAlign: 'center' }}>Fast, simple messaging with groups, Spaces and file sharing.</p>
        <div className="feature-list">
          <div className="feature"><Icon name="key" /><div><b>No email, phone or password</b><div className="small muted">Create a private account in seconds and keep a Recovery Kit.</div></div></div>
          <div className="feature"><Icon name="users" /><div><b>DMs, groups and Spaces</b><div className="small muted">From one-to-one chats to organised communities with channels.</div></div></div>
          <div className="feature"><Icon name="folder" /><div><b>Share files once, reuse anywhere</b><div className="small muted">Store files, send them in any chat and create controlled share links.</div></div></div>
        </div>
        <div className="col">
          <Link className="btn btn-primary btn-block" to="/create">Create a private account</Link>
          <Link className="btn btn-block" to="/signin">I already have an account</Link>
          <Link className="btn btn-ghost btn-block" to="/link"><Icon name="qr" className="icon-sm" /> Link this device from my phone</Link>
        </div>
      </div>
    </div>
  );
}

export function RecoveryKit({ accountId, recoveryKey, onDone, doneLabel = "I've saved my Recovery Kit" }) {
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const payload = `messgae-recovery:v1:${accountId.replace(/\s/g, '')}:${recoveryKey}`;
  useEffect(() => {
    QRCode.toDataURL(payload, { margin: 1, width: 400, errorCorrectionLevel: 'M' }).then(setQr);
  }, [payload]);

  const downloadKit = () => {
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>messgae Recovery Kit</title>
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 16px;color:#111}code{font-size:18px;font-weight:700;letter-spacing:.04em}
.box{border:2px dashed #999;border-radius:12px;padding:16px;margin:16px 0}img{width:220px;height:220px}</style></head><body>
<h1>messgae Recovery Kit</h1><p>Created ${dateTime(Date.now())}. Keep this somewhere safe and private — anyone with it can sign in to your account.</p>
<div class="box"><p>Account ID</p><code>${accountId}</code><p>Recovery Key</p><code>${recoveryKey}</code></div>
<img src="${qr}" alt="Recovery QR code"><h2>How to recover</h2><ol><li>Open messgae and choose “I already have an account”.</li>
<li>Enter your Account ID and Recovery Key (or paste the QR contents).</li><li>Once signed in, review Settings → Security → Devices.</li></ol>
<p><b>If you lose all logged-in devices and this Recovery Kit, the account may not be recoverable.</b></p>
<p>Generating a new Recovery Key in Settings → Security invalidates this one.</p></body></html>`;
    downloadBlob(html, 'messgae-recovery-kit.html', 'text/html');
  };

  return (
    <div className="col gap-4">
      <div className="notice warn">
        <b>Save your Recovery Kit now.</b> If you lose all logged-in devices and your Recovery Kit, the account may not be recoverable. We can't reset it for you.
      </div>
      <div className="printable col gap-3">
        <div>
          <div className="label">Account ID</div>
          <div className="recovery-key" style={{ fontSize: 16 }}>{accountId}</div>
          <div className="hint mt-2">Your Account ID identifies you. It is not a secret on its own.</div>
        </div>
        <div>
          <div className="label">Recovery Key</div>
          <div className="recovery-key">{recoveryKey}</div>
          <div className="hint mt-2">This is the secret. It's shown only once and we only store a one-way verifier of it.</div>
        </div>
        <div className="center">{qr ? <span className="qr"><img src={qr} alt="Recovery QR code" /></span> : <Spinner />}</div>
      </div>
      <div className="row wrap">
        <button className="btn grow" onClick={async () => setCopied(await copyText(`${accountId}\n${recoveryKey}`))}>
          <Icon name={copied ? 'check' : 'copy'} className="icon-sm" /> {copied ? 'Copied' : 'Copy'}
        </button>
        <button className="btn grow" onClick={downloadKit}><Icon name="download" className="icon-sm" /> Download kit</button>
        <button className="btn grow" onClick={() => window.print()}><Icon name="file" className="icon-sm" /> Print</button>
      </div>
      {onDone && (
        <>
          <label className="check">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span>I stored my Recovery Kit somewhere safe. I understand it can't be recovered by support.</span>
          </label>
          <button className="btn btn-primary btn-block" disabled={!confirmed} onClick={onDone}>{doneLabel}</button>
        </>
      )}
    </div>
  );
}

export function CreateAccount() {
  const { refreshMe } = useApp();
  const nav = useNavigate();
  const loc = useLocation();
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [avail, setAvail] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);

  useEffect(() => {
    if (!username) return setAvail(null);
    const t = setTimeout(async () => {
      try {
        setAvail(await api.get(`/api/auth/username-available?u=${encodeURIComponent(username)}`, { quiet: true }));
      } catch {
        setAvail(null);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [username]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const data = await api.post('/api/auth/register', { displayName, username: username || undefined }, { quiet: true });
      setCreated(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <div className="auth">
        <div className="auth-card card">
          <h1 className="mb-3">Your Recovery Kit</h1>
          <RecoveryKit
            accountId={created.accountId}
            recoveryKey={created.recoveryKey}
            onDone={async () => {
              await refreshMe();
              nav(loc.state?.from || '/chats', { replace: true });
            }}
            doneLabel="Continue to messgae"
          />
        </div>
      </div>
    );
  }

  return (
    <div className="auth">
      <form className="auth-card card" onSubmit={submit}>
        <Link to="/welcome" className="small">← Back</Link>
        <h1 className="mt-3 mb-3">Create a private account</h1>
        <p className="muted small">No email, phone number or password. We'll generate an Account ID and a Recovery Key for you.</p>
        <Field label="Display name" htmlFor="dn">
          <input id="dn" className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={48} required autoFocus />
        </Field>
        <Field label="Username (optional)" htmlFor="un" hint={avail ? (avail.available ? '✓ Available' : avail.reason) : 'Letters, numbers and underscores. We\'ll pick one if you leave it empty.'}>
          <input id="un" className="input" value={username} onChange={(e) => setUsername(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))} maxLength={32} autoComplete="off" />
        </Field>
        {error && <div className="notice danger mb-3">{error}</div>}
        <button className="btn btn-primary btn-block" disabled={busy || !displayName.trim() || (avail && !avail.available)}>{busy ? 'Creating…' : 'Create account'}</button>
        <p className="tiny faint mt-3">
          Privacy model: messages and files are encrypted in transit and at rest on our servers, but they are not end-to-end encrypted.
          Authorized staff can access them for safety investigations; every such access is logged.
        </p>
      </form>
    </div>
  );
}

function parseRecovery(text) {
  const m = /messgae-recovery:v1:(\d{24}):([0-9A-Za-z-]+)/.exec(text || '');
  return m ? { accountId: m[1], recoveryKey: m[2] } : null;
}

export function SignIn() {
  const { refreshMe } = useApp();
  const nav = useNavigate();
  const loc = useLocation();
  const [accountId, setAccountId] = useState('');
  const [recoveryKey, setRecoveryKey] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef(null);

  const submit = async (e) => {
    e?.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/login', { accountId, recoveryKey }, { quiet: true });
      await refreshMe();
      nav(loc.state?.from || '/chats', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const onPaste = (e) => {
    const parsed = parseRecovery(e.clipboardData.getData('text'));
    if (parsed) {
      e.preventDefault();
      setAccountId(parsed.accountId.replace(/(\d{4})(?=\d)/g, '$1 '));
      setRecoveryKey(parsed.recoveryKey);
    }
  };

  const scanImage = async (file) => {
    if (!('BarcodeDetector' in window)) return setError('QR scanning is not supported in this browser. Type or paste your details instead.');
    try {
      const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      const codes = await detector.detect(await createImageBitmap(file));
      const parsed = parseRecovery(codes[0]?.rawValue);
      if (!parsed) throw new Error();
      setAccountId(parsed.accountId);
      setRecoveryKey(parsed.recoveryKey);
    } catch {
      setError("Couldn't read a Recovery QR code from that image.");
    }
  };

  return (
    <div className="auth">
      <form className="auth-card card" onSubmit={submit} onPaste={onPaste}>
        <Link to="/welcome" className="small">← Back</Link>
        <h1 className="mt-3 mb-3">Sign in</h1>
        <p className="muted small">Use the Account ID and Recovery Key from your Recovery Kit. You can also paste the QR contents.</p>
        <Field label="Account ID" htmlFor="aid">
          <input id="aid" className="input mono" inputMode="numeric" value={accountId} onChange={(e) => setAccountId(e.target.value)} placeholder="4829 1938 5721 6304 8291 4752" autoComplete="username" required />
        </Field>
        <Field label="Recovery Key" htmlFor="rk">
          <input id="rk" className="input mono" value={recoveryKey} onChange={(e) => setRecoveryKey(e.target.value.toUpperCase())} placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX" autoComplete="current-password" required />
        </Field>
        {error && <div className="notice danger mb-3">{error}</div>}
        <button className="btn btn-primary btn-block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <div className="row mt-3 wrap between">
          <button type="button" className="link-btn small" onClick={() => fileRef.current?.click()}>Scan Recovery QR image</button>
          <Link to="/link" className="small">Link from another device instead</Link>
        </div>
        <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => e.target.files[0] && scanImage(e.target.files[0])} />
      </form>
    </div>
  );
}

/** New device: shows a code/QR that an already signed-in device approves. */
export function NewDeviceLink() {
  const { refreshMe } = useApp();
  const nav = useNavigate();
  const [link, setLink] = useState(null);
  const [qr, setQr] = useState('');
  const [status, setStatus] = useState('pending');
  const [error, setError] = useState('');

  const start = async () => {
    setError('');
    setStatus('pending');
    try {
      const data = await api.post('/api/auth/link/start', {}, { quiet: true });
      setLink(data);
      setQr(await QRCode.toDataURL(data.approveUrl, { margin: 1, width: 360 }));
    } catch (err) {
      setError(err.message);
    }
  };
  useEffect(() => {
    start();
  }, []);

  useEffect(() => {
    if (!link || status !== 'pending') return undefined;
    const t = setInterval(async () => {
      try {
        const r = await api.post('/api/auth/link/poll', { pollToken: link.pollToken }, { quiet: true });
        if (r.status === 'approved') {
          setStatus('approved');
          await refreshMe();
          nav('/chats', { replace: true });
        } else if (r.status === 'expired') setStatus('expired');
      } catch {
        setStatus('expired');
      }
    }, 2000);
    return () => clearInterval(t);
  }, [link, status, refreshMe, nav]);

  return (
    <div className="auth">
      <div className="auth-card card" style={{ textAlign: 'center' }}>
        <Link to="/welcome" className="small" style={{ display: 'block', textAlign: 'left' }}>← Back</Link>
        <h1 className="mt-3 mb-3">Link this device</h1>
        <p className="muted small">On a device where you're already signed in, scan this QR code with the camera — or open <b>Settings → Security → Devices → Link a device</b> and enter the code.</p>
        {error && <div className="notice danger">{error}</div>}
        {status === 'expired' ? (
          <div className="col">
            <p>This code expired.</p>
            <button className="btn btn-primary" onClick={start}>Get a new code</button>
          </div>
        ) : link ? (
          <div className="col gap-3" style={{ alignItems: 'center' }}>
            <span className="qr"><img src={qr} alt="Device link QR code" /></span>
            <div className="recovery-key" style={{ fontSize: 24 }}>{link.code}</div>
            <div className="row small muted"><Spinner /> Waiting for approval…</div>
          </div>
        ) : (
          <Spinner />
        )}
      </div>
    </div>
  );
}

export function AccountBlocked({ error }) {
  const { signOut } = useApp();
  return (
    <div className="auth">
      <div className="auth-card card">
        <h1 className="mb-3">Account {error.code === 'account_banned' ? 'banned' : 'suspended'}</h1>
        <p className="muted">{error.data?.reason || 'This account was restricted for violating the platform rules.'}</p>
        {error.data?.until && <p>Until: <b>{dateTime(error.data.until)}</b></p>}
        <button className="btn" onClick={signOut}>Sign out</button>
      </div>
    </div>
  );
}
