import { useEffect, useState } from 'react';
import { api, fileUrl, uploadFile } from '../api.js';
import { useApp } from '../store.jsx';
import { Field, Icon, IconButton, Modal, Segmented, Spinner, Empty } from './ui.jsx';
import { copyText, extOf, formatBytes, REPORT_REASONS } from '../utils.js';

export function UnlockDialog({ file, onClose, onUnlocked }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const submit = async (e) => {
    e?.preventDefault();
    try {
      const r = await api.post(`/api/files/${file.id}/unlock`, { password }, { quiet: true });
      onUnlocked(r.ticket);
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <Modal title="Password protected" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={submit}>Unlock</button></>}>
      <form onSubmit={submit}>
        <p className="muted">Enter the password for <b>{file.filename}</b>.</p>
        <Field label="Password"><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus /></Field>
        {error && <div className="notice danger">{error}</div>}
      </form>
    </Modal>
  );
}

export function MediaViewer({ files, index, onClose }) {
  const [i, setI] = useState(index);
  const f = files[i];
  useEffect(() => {
    const key = (e) => {
      if (e.key === 'ArrowRight') setI((x) => Math.min(files.length - 1, x + 1));
      if (e.key === 'ArrowLeft') setI((x) => Math.max(0, x - 1));
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [files.length]);
  return (
    <Modal title={f.filename} onClose={onClose} wide footer={
      <>
        <span className="grow small muted">{formatBytes(f.size)}{files.length > 1 ? ` · ${i + 1} of ${files.length}` : ''}</span>
        {files.length > 1 && <IconButton icon="back" label="Previous" disabled={i === 0} onClick={() => setI(i - 1)} />}
        {files.length > 1 && <IconButton icon="chevron" label="Next" disabled={i === files.length - 1} onClick={() => setI(i + 1)} />}
        <a className="btn" href={fileUrl(f.id, { download: true })}><Icon name="download" className="icon-sm" /> Download</a>
      </>
    }>
      <div className="center" style={{ background: '#000', borderRadius: 12, minHeight: 240 }}>
        {f.category === 'image' ? <img src={fileUrl(f.id)} alt={f.filename} style={{ maxHeight: '70vh', objectFit: 'contain' }} /> : <video src={fileUrl(f.id)} controls autoPlay playsInline style={{ maxHeight: '70vh' }} />}
      </div>
    </Modal>
  );
}

const PICKER_CATS = [['recent', 'Recent'], ['images', 'Images'], ['videos', 'Videos'], ['audio', 'Audio'], ['documents', 'Documents'], ['archives', 'Archives']];

export function FileThumb({ f }) {
  if (f.category === 'image' && f.available && !f.passwordProtected) return <img src={fileUrl(f.id)} alt="" loading="lazy" />;
  const icon = { video: 'video', audio: 'music', archive: 'archive', document: 'file' }[f.category];
  return icon && f.category !== 'document' && f.category !== 'archive' ? <Icon name={icon} size={32} /> : <span className="ext">{extOf(f.filename)}</span>;
}

/** My Files → File → Send: pick existing stored files (no re-upload). */
export function MyFilesPicker({ onClose, onPick, multiple = true, title = 'My Files', accept }) {
  const [cat, setCat] = useState(accept === 'image' ? 'images' : 'recent');
  const [q, setQ] = useState('');
  const [files, setFiles] = useState(null);
  const [sel, setSel] = useState([]);
  useEffect(() => {
    setFiles(null);
    const t = setTimeout(() => {
      api.get(`/api/files?category=${cat}${q ? `&q=${encodeURIComponent(q)}` : ''}`).then((r) => setFiles(r.files)).catch(() => setFiles([]));
    }, 200);
    return () => clearTimeout(t);
  }, [cat, q]);
  const toggle = (f) => {
    if (!multiple) return setSel([f]);
    setSel((s) => (s.some((x) => x.id === f.id) ? s.filter((x) => x.id !== f.id) : [...s, f].slice(0, 10)));
  };
  return (
    <Modal title={title} onClose={onClose} wide footer={
      <>
        <span className="grow small muted">{sel.length ? `${sel.length} selected` : 'Select files to send'}</span>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={!sel.length} onClick={() => onPick(sel)}>{multiple ? 'Send' : 'Choose'}</button>
      </>
    }>
      <div className="search mb-3"><Icon name="search" className="icon-sm" /><input placeholder="Search your files" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      {accept !== 'image' && <div className="chips" style={{ padding: '0 0 8px' }}>{PICKER_CATS.map(([k, l]) => <button key={k} className={`chip ${cat === k ? 'on' : ''}`} onClick={() => setCat(k)}>{l}</button>)}</div>}
      {!files ? <Spinner /> : !files.length ? <Empty icon="folder" title="No files here">Upload files from the Files tab or the attachment menu.</Empty> : (
        <div className="file-grid" style={{ padding: 0 }}>
          {files.filter((f) => f.available).map((f) => (
            <button key={f.id} className={`file-tile ${sel.some((x) => x.id === f.id) ? 'selected' : ''}`} onClick={() => toggle(f)}>
              <div className="thumb"><FileThumb f={f} /></div>
              <div className="info"><div className="small bold ellipsis">{f.filename}</div><div className="tiny muted">{formatBytes(f.size)}</div></div>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

/** Create a shareable link for a stored file. */
export function ShareLinkDialog({ file, onClose, onCreated }) {
  const { handleError, toast } = useApp();
  const [audience, setAudience] = useState('anyone');
  const [users, setUsers] = useState('');
  const [password, setPassword] = useState('');
  const [expires, setExpires] = useState('168');
  const [maxDownloads, setMaxDownloads] = useState('');
  const [allowDownload, setAllowDownload] = useState(true);
  const [link, setLink] = useState(null);
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/api/files/${file.id}/links`, {
        audience,
        selectedUsers: audience === 'selected' ? users.split(/[\s,]+/).filter(Boolean) : undefined,
        password: password || undefined,
        expiresInHours: expires ? Number(expires) : undefined,
        maxDownloads: maxDownloads ? Number(maxDownloads) : undefined,
        allowDownload,
      });
      setLink(r.link);
      onCreated?.(r.link);
    } catch (err) {
      handleError(err);
    } finally {
      setBusy(false);
    }
  };
  if (link) {
    return (
      <Modal title="Link created" onClose={onClose} footer={<button className="btn btn-primary" onClick={onClose}>Done</button>}>
        <p className="muted">Anyone who meets the conditions can open this link. Manage it in Files → Shared.</p>
        <div className="input-group">
          <input className="input mono" readOnly value={link.url} onFocus={(e) => e.target.select()} />
          <button className="btn" onClick={() => copyText(link.url).then(() => toast('Link copied'))}><Icon name="copy" className="icon-sm" /></button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={`Share “${file.filename}”`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy} onClick={create}>Create link</button></>}>
      <Field label="Who can open it">
        <Segmented value={audience} onChange={setAudience} options={[['anyone', 'Anyone with link'], ['contacts', 'Contacts'], ['selected', 'Selected people']]} />
      </Field>
      {audience === 'selected' && (
        <Field label="Usernames" hint="Separate with commas. They'll need to sign in.">
          <input className="input" value={users} onChange={(e) => setUsers(e.target.value)} placeholder="alice, bob" />
        </Field>
      )}
      <Field label="Password (optional)" hint="Stored encrypted. Authorized staff can reveal it during investigations; every reveal is logged.">
        <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
      </Field>
      <div className="row gap-3 wrap">
        <Field label="Expires">
          <select className="input" value={expires} onChange={(e) => setExpires(e.target.value)}>
            <option value="1">In 1 hour</option><option value="24">In 1 day</option><option value="168">In 7 days</option><option value="720">In 30 days</option><option value="">Never</option>
          </select>
        </Field>
        <Field label="Max downloads">
          <input className="input" type="number" min="1" value={maxDownloads} onChange={(e) => setMaxDownloads(e.target.value)} placeholder="Unlimited" />
        </Field>
      </div>
      <label className="check"><input type="checkbox" checked={allowDownload} onChange={(e) => setAllowDownload(e.target.checked)} /><span>Allow downloading (otherwise preview only for images, video and audio)</span></label>
    </Modal>
  );
}

export function FilePasswordDialog({ file, onClose, onSaved }) {
  const { handleError, toast } = useApp();
  const [password, setPassword] = useState('');
  const save = async (remove) => {
    try {
      if (remove) await api.del(`/api/files/${file.id}/password`);
      else await api.put(`/api/files/${file.id}/password`, { password });
      toast(remove ? 'Password removed' : 'Password set');
      onSaved?.();
      onClose();
    } catch (err) {
      handleError(err);
    }
  };
  return (
    <Modal title="File password" onClose={onClose} footer={
      <>
        {file.passwordProtected && <button className="btn btn-danger" onClick={() => save(true)}>Remove password</button>}
        <span className="grow" />
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={password.length < 4} onClick={() => save(false)}>Save</button>
      </>
    }>
      <p className="muted small">People you send this file to will need the password to open it. The password is stored encrypted with a separate key so authorized staff can reveal it for investigations — each reveal is audited.</p>
      <Field label="New password"><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus /></Field>
    </Modal>
  );
}

export function ReportDialog({ targetType, targetId, label, spaceId, onClose }) {
  const { toast, handleError } = useApp();
  const [reason, setReason] = useState('spam');
  const [details, setDetails] = useState('');
  const submit = async () => {
    try {
      await api.post('/api/reports', { targetType, targetId, reason, details, spaceId });
      toast('Thanks — our moderators will review it.');
      onClose();
    } catch (err) {
      handleError(err);
    }
  };
  return (
    <Modal title={`Report ${label || targetType}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-danger" onClick={submit}>Send report</button></>}>
      <p className="small muted">A copy of what you're reporting (and a few surrounding messages you can see) is attached as evidence for moderators.</p>
      <Field label="Reason">
        <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
          {REPORT_REASONS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select>
      </Field>
      <Field label="Details (optional)"><textarea className="input" value={details} onChange={(e) => setDetails(e.target.value)} maxLength={2000} /></Field>
    </Modal>
  );
}

/** Uploads a list of File objects, reporting per-file progress. */
export async function uploadMany(fileList, onUpdate) {
  const items = [...fileList].map((f, i) => ({ key: `${Date.now()}-${i}`, name: f.name, size: f.size, progress: 0, file: null, error: null, raw: f }));
  onUpdate([...items]);
  await Promise.all(items.map(async (it) => {
    try {
      it.file = await uploadFile(it.raw, { onProgress: (p) => { it.progress = p; onUpdate([...items]); } });
    } catch (err) {
      it.error = err.message;
    }
    it.progress = 1;
    onUpdate([...items]);
  }));
  return items;
}

