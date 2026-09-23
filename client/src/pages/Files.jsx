import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, fileUrl } from '../api.js';
import { useApp } from '../store.jsx';
import { Panes } from '../components/Shell.jsx';
import { Avatar, Empty, Icon, IconButton, Loading, Modal, useMenu } from '../components/ui.jsx';
import { FilePasswordDialog, FileThumb, MediaViewer, ShareLinkDialog, uploadMany } from '../components/FileDialogs.jsx';
import { copyText, dateTime, formatBytes, relative, timeShort } from '../utils.js';

const CATS = [
  ['recent', 'Recent', 'clock'], ['images', 'Images', 'image'], ['videos', 'Videos', 'video'], ['audio', 'Audio', 'music'],
  ['documents', 'Documents', 'file'], ['archives', 'Archives', 'archive'], ['shared', 'Shared', 'share'], ['trash', 'Trash', 'trash'],
];

function SendToChat({ file, onClose }) {
  const { conversations, handleError, toast } = useApp();
  const [q, setQ] = useState('');
  const list = (conversations || []).filter((c) => c.name.toLowerCase().includes(q.toLowerCase()));
  const send = async (c) => {
    try {
      await api.post(`/api/conversations/${c.id}/messages`, { fileIds: [file.id] });
      toast(`Sent to ${c.name}`);
      onClose();
    } catch (err) {
      handleError(err);
    }
  };
  return (
    <Modal title={`Send “${file.filename}”`} onClose={onClose}>
      <p className="small muted">The stored file is referenced, not copied — sending doesn't use more storage.</p>
      <div className="search mb-3"><Icon name="search" className="icon-sm" /><input autoFocus placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} /></div>
      <div className="list">
        {list.map((c) => (
          <button key={c.id} className="list-item" onClick={() => send(c)}>
            <Avatar name={c.name} fileId={c.avatarFileId} size={36} />
            <span className="grow bold ellipsis">{c.name}</span>
            <Icon name="send" className="icon-sm" />
          </button>
        ))}
      </div>
    </Modal>
  );
}

function SharedLinks() {
  const { handleError, toast, confirm } = useApp();
  const [links, setLinks] = useState(null);
  const load = useCallback(() => api.get('/api/links?status=all').then((r) => setLinks(r.links)).catch(handleError), [handleError]);
  useEffect(() => {
    load();
  }, [load]);
  if (!links) return <Loading />;
  if (!links.length) return <Empty icon="share" title="No share links">Create a link from any file's menu. Links can be limited to people, protected with a password, expire, and be revoked anytime.</Empty>;
  const statusTag = { active: 'ok', expired: 'warn', revoked: 'danger', limit_reached: 'warn', unavailable: 'danger' };
  return (
    <div className="panel" style={{ margin: 16 }}>
      <table className="table responsive">
        <thead><tr><th>File</th><th>Link</th><th>Created</th><th>Expires</th><th className="num">Downloads</th><th>Status</th><th /></tr></thead>
        <tbody>
          {links.map((l) => (
            <tr key={l.id}>
              <td className="primary" data-label="File"><span className="ellipsis" style={{ display: 'block', maxWidth: 260 }}>{l.file.filename}</span><span className="tiny muted">{l.audience === 'anyone' ? 'Anyone with link' : l.audience === 'contacts' ? 'Contacts only' : 'Selected people'}{l.passwordProtected ? ' · 🔒' : ''}{!l.allowDownload ? ' · preview only' : ''}</span></td>
              <td data-label="Link"><button className="link-btn small" onClick={() => copyText(l.url).then(() => toast('Link copied'))}>Copy link</button></td>
              <td data-label="Created">{timeShort(l.createdAt)}</td>
              <td data-label="Expires">{l.expiresAt ? relative(l.expiresAt) : 'Never'}</td>
              <td className="num" data-label="Downloads">{l.downloads}{l.maxDownloads ? ` / ${l.maxDownloads}` : ''}</td>
              <td data-label="Status"><span className={`tag ${statusTag[l.status]}`}>{l.status.replace('_', ' ')}</span></td>
              <td data-label="">{l.status === 'active' && <button className="btn btn-sm btn-danger" onClick={async () => { if (await confirm({ title: 'Revoke link?', message: 'People with the link will no longer be able to open it.', confirmLabel: 'Revoke', danger: true })) api.del(`/api/links/${l.id}`).then(load).catch(handleError); }}>Revoke</button>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function FilesPage() {
  const { category = 'recent' } = useParams();
  const nav = useNavigate();
  const { handleError, toast, confirm, prompt, refreshMe } = useApp();
  const [data, setData] = useState(null);
  const [q, setQ] = useState('');
  const [uploads, setUploads] = useState([]);
  const [dialog, setDialog] = useState(null);
  const [viewer, setViewer] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [openMenu, menu] = useMenu();
  const inputRef = useRef(null);

  const load = useCallback(async () => {
    if (category === 'shared') return;
    try {
      setData(await api.get(`/api/files?category=${category}${q ? `&q=${encodeURIComponent(q)}` : ''}`));
    } catch (err) {
      handleError(err);
    }
  }, [category, q, handleError]);
  useEffect(() => {
    setData(null);
    const t = setTimeout(load, q ? 250 : 0);
    return () => clearTimeout(t);
  }, [load, q]);

  const upload = async (files) => {
    if (!files?.length) return;
    const items = await uploadMany(files, setUploads);
    const failed = items.filter((i) => i.error);
    if (failed.length) toast(`${failed[0].name}: ${failed[0].error}`, { error: true, duration: 5000 });
    else toast(`Uploaded ${items.length} file${items.length > 1 ? 's' : ''}`);
    setTimeout(() => setUploads([]), 1200);
    load();
    refreshMe();
  };

  const run = async (fn, msg) => {
    try {
      await fn();
      if (msg) toast(msg);
      load();
      refreshMe();
    } catch (err) {
      handleError(err);
    }
  };

  const fileMenu = (e, f) => {
    e.stopPropagation();
    const trash = !!f.trashedAt;
    openMenu(e, trash ? [
      { label: 'Restore', icon: 'restore', onClick: () => run(() => api.post(`/api/files/${f.id}/restore`), 'Restored') },
      { label: 'Delete forever', icon: 'trash', danger: true, onClick: async () => { if (await confirm({ title: 'Delete forever?', message: 'This cannot be undone. Copies already sent in chats stay available there.', confirmLabel: 'Delete', danger: true })) run(() => api.del(`/api/files/${f.id}?permanent=1`), 'Deleted'); } },
    ] : [
      { label: 'Send to chat', icon: 'send', onClick: () => setDialog({ send: f }) },
      { label: 'Create share link', icon: 'link', onClick: () => setDialog({ link: f }) },
      { label: 'Download', icon: 'download', onClick: () => { location.href = fileUrl(f.id, { download: true }); } },
      { label: f.passwordProtected ? 'Change password' : 'Set password', icon: 'lock', onClick: () => setDialog({ password: f }) },
      { label: 'Rename', icon: 'edit', onClick: async () => { const name = await prompt({ title: 'Rename file', label: 'File name', defaultValue: f.filename }); if (name) run(() => api.patch(`/api/files/${f.id}`, { filename: name }), 'Renamed'); } },
      { label: 'Details', icon: 'info', onClick: () => setDialog({ details: f }) },
      'sep',
      { label: 'Move to trash', icon: 'trash', danger: true, onClick: () => run(() => api.del(`/api/files/${f.id}`), 'Moved to trash') },
    ]);
  };

  const media = (data?.files || []).filter((f) => ['image', 'video'].includes(f.category) && !f.passwordProtected && !f.trashedAt);
  const usage = data?.usage;
  const plan = data?.plan;

  const main = (
    <div className="col" style={{ height: '100%', gap: 0, position: 'relative' }}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
      onDrop={(e) => { e.preventDefault(); setDragging(false); upload(e.dataTransfer.files); }}>
      <header className="pane-header">
        <h1>Files</h1>
        {category === 'trash' && data?.files?.length > 0 && <button className="btn btn-sm btn-ghost" onClick={async () => { if (await confirm({ title: 'Empty trash?', confirmLabel: 'Empty trash', danger: true })) run(() => api.post('/api/files/trash/empty'), 'Trash emptied'); }}>Empty trash</button>}
        <button className="btn btn-primary btn-sm" onClick={() => inputRef.current?.click()}><Icon name="upload" className="icon-sm" /> Upload</button>
      </header>
      <div className="pane-body">
        {usage && plan && (
          <div style={{ padding: '12px 16px 0' }}>
            <div className="row between small"><span className="muted">{formatBytes(usage.storageBytes)} of {formatBytes(plan.storageBytes)} used</span><span className="faint">{plan.label} · uploads up to {formatBytes(plan.uploadBytes)}</span></div>
            <div className="usage-bar mt-2"><div style={{ width: `${Math.min(100, (usage.storageBytes / plan.storageBytes) * 100)}%` }} /></div>
          </div>
        )}
        <div className="chips" style={{ paddingTop: 12 }}>
          {CATS.map(([k, l, ic]) => <button key={k} className={`chip ${category === k ? 'on' : ''}`} onClick={() => nav(k === 'recent' ? '/files' : `/files/${k}`)}><Icon name={ic} className="icon-sm" style={{ width: 15, height: 15 }} />{l}</button>)}
        </div>
        {category !== 'shared' && (
          <div style={{ padding: '4px 16px' }}>
            <div className="search"><Icon name="search" className="icon-sm" /><input placeholder="Search files" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search files" /></div>
          </div>
        )}
        {uploads.length > 0 && (
          <div className="p-4 col" style={{ gap: 6 }}>
            {uploads.map((u) => (
              <div key={u.key} className="row small">
                <Icon name="upload" className="icon-sm" /><span className="grow ellipsis">{u.name}</span>
                {u.error ? <span className="danger-text">{u.error}</span> : <div className="progress" style={{ width: 120 }}><div style={{ width: `${Math.round(u.progress * 100)}%` }} /></div>}
              </div>
            ))}
          </div>
        )}
        {category === 'shared' ? <SharedLinks /> : !data ? <Loading /> : !data.files.length ? (
          <Empty icon={category === 'trash' ? 'trash' : 'folder'} title={category === 'trash' ? 'Trash is empty' : 'No files yet'}>
            {category === 'trash' ? `Deleted files stay here for ${plan?.trashRetentionDays || 30} days.` : 'Upload once, then send the same file to any chat without re-uploading.'}
          </Empty>
        ) : (
          <div className="file-grid">
            {data.files.map((f) => (
              <div key={f.id} className="file-tile" role="button" tabIndex={0}
                onClick={() => (media.includes(f) ? setViewer(media.indexOf(f)) : setDialog({ details: f }))}
                onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.click()}>
                <div className="thumb"><FileThumb f={f} /></div>
                <div className="info row" style={{ gap: 4 }}>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="small bold ellipsis" title={f.filename}>{f.passwordProtected ? '🔒 ' : ''}{f.filename}</div>
                    <div className="tiny muted">{formatBytes(f.size)} · {f.trashedAt ? `deleted ${relative(f.trashedAt)}` : timeShort(f.createdAt)}</div>
                  </div>
                  <IconButton icon="more" label="File actions" onClick={(e) => fileMenu(e, f)} size={18} />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {dragging && <div className="dropzone">Drop to upload</div>}
      <input ref={inputRef} type="file" multiple hidden onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
      {menu}
      {viewer !== null && <MediaViewer files={media} index={viewer} onClose={() => setViewer(null)} />}
      {dialog?.send && <SendToChat file={dialog.send} onClose={() => setDialog(null)} />}
      {dialog?.link && <ShareLinkDialog file={dialog.link} onClose={() => setDialog(null)} onCreated={() => load()} />}
      {dialog?.password && <FilePasswordDialog file={dialog.password} onClose={() => setDialog(null)} onSaved={load} />}
      {dialog?.details && (
        <Modal title={dialog.details.filename} onClose={() => setDialog(null)} footer={<a className="btn btn-primary" href={fileUrl(dialog.details.id, { download: true })}>Download</a>}>
          <dl className="kv">
            <dt>Type</dt><dd>{dialog.details.mime}</dd>
            <dt>Size</dt><dd>{formatBytes(dialog.details.size)}</dd>
            <dt>Uploaded</dt><dd>{dateTime(dialog.details.createdAt)}</dd>
            <dt>Downloads</dt><dd>{dialog.details.downloads}</dd>
            <dt>Times shared</dt><dd>{dialog.details.shares}</dd>
            <dt>Active links</dt><dd>{dialog.details.activeLinks}</dd>
            <dt>Password</dt><dd>{dialog.details.passwordProtected ? 'Protected' : 'None'}</dd>
            {dialog.details.moderationStatus !== 'ok' && <><dt>Status</dt><dd className="danger-text">{dialog.details.moderationStatus}</dd></>}
          </dl>
        </Modal>
      )}
    </div>
  );
  return <Panes single main={main} />;
}
