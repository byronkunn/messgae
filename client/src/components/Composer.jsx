import { useEffect, useRef, useState } from 'react';
import { api, uploadFile } from '../api.js';
import { useApp } from '../store.jsx';
import { realtime } from '../realtime.js';
import { Icon, IconButton, Modal, Field, Tabs, useMenu } from './ui.jsx';
import { MyFilesPicker, ShareLinkDialog, uploadMany } from './FileDialogs.jsx';
import { EMOJIS, STICKERS, formatBytes } from '../utils.js';

function PollDialog({ onClose, onSubmit }) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const valid = question.trim() && options.filter((o) => o.trim()).length >= 2;
  return (
    <Modal title="Create poll" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={!valid} onClick={() => onSubmit({ question, options: options.filter((o) => o.trim()) })}>Send poll</button></>}>
      <Field label="Question"><input className="input" value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={300} autoFocus /></Field>
      <div className="label mb-3">Options</div>
      {options.map((o, i) => (
        <div className="input-group mb-3" key={i}>
          <input className="input" value={o} maxLength={100} placeholder={`Option ${i + 1}`} onChange={(e) => setOptions(options.map((x, j) => (j === i ? e.target.value : x)))} />
          {options.length > 2 && <IconButton icon="x" label="Remove option" onClick={() => setOptions(options.filter((_, j) => j !== i))} />}
        </div>
      ))}
      {options.length < 10 && <button className="btn btn-sm" onClick={() => setOptions([...options, ''])}><Icon name="plus" className="icon-sm" /> Add option</button>}
    </Modal>
  );
}

function EmojiPicker({ onEmoji, onSticker, onGif, onClose }) {
  const [tab, setTab] = useState('emoji');
  return (
    <Modal title="Emoji, stickers & GIFs" onClose={onClose}>
      <Tabs value={tab} onChange={setTab} tabs={[['emoji', 'Emoji'], ['stickers', 'Stickers'], ['gif', 'GIF']]} />
      <div className="mt-3">
        {tab === 'emoji' && (
          <div className="emoji-grid">{EMOJIS.map((e) => <button key={e} onClick={() => onEmoji(e)} aria-label={e}>{e}</button>)}</div>
        )}
        {tab === 'stickers' && (
          <div className="sticker-grid">{Object.entries(STICKERS).map(([id, e]) => <button key={id} onClick={() => onSticker(id)} aria-label={`Sticker ${id}`}>{e}</button>)}</div>
        )}
        {tab === 'gif' && (
          <div className="col gap-3">
            <p className="muted small">Send an animated GIF from your device or from My Files. We don't use a third-party GIF search, so nothing about your chats is shared with GIF providers.</p>
            <button className="btn" onClick={() => onGif('upload')}><Icon name="upload" className="icon-sm" /> Upload a GIF</button>
            <button className="btn" onClick={() => onGif('files')}><Icon name="folder" className="icon-sm" /> Choose from My Files</button>
          </div>
        )}
      </div>
    </Modal>
  );
}

function useRecorder() {
  const [state, setState] = useState({ recording: false, seconds: 0 });
  const rec = useRef(null);
  const chunks = useRef([]);
  const timer = useRef(null);
  const start = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((t) => window.MediaRecorder?.isTypeSupported?.(t));
    const r = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunks.current = [];
    r.ondataavailable = (e) => e.data.size && chunks.current.push(e.data);
    r.start(250);
    rec.current = r;
    const started = Date.now();
    setState({ recording: true, seconds: 0 });
    timer.current = setInterval(() => setState({ recording: true, seconds: Math.floor((Date.now() - started) / 1000) }), 250);
  };
  const stop = () => new Promise((resolve) => {
    const r = rec.current;
    clearInterval(timer.current);
    if (!r) return resolve(null);
    r.onstop = () => {
      r.stream.getTracks().forEach((t) => t.stop());
      const type = r.mimeType || 'audio/webm';
      const ext = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'weba';
      resolve(new File(chunks.current, `voice-message-${Date.now()}.${ext}`, { type }));
      rec.current = null;
      setState({ recording: false, seconds: 0 });
    };
    r.stop();
  });
  const cancel = async () => {
    await stop();
  };
  useEffect(() => () => clearInterval(timer.current), []);
  return { ...state, start, stop, cancel };
}

export default function Composer({ conversation, threadId, replyTo, onCancelReply, editing, onCancelEdit, disabledReason }) {
  const { handleError, toast } = useApp();
  const [text, setText] = useState('');
  const [pending, setPending] = useState([]);
  const [dialog, setDialog] = useState(null);
  const [cooldown, setCooldown] = useState(0);
  const [openMenu, menu] = useMenu();
  const photoRef = useRef(null);
  const fileRef = useRef(null);
  const gifRef = useRef(null);
  const taRef = useRef(null);
  const lastTyping = useRef(0);
  const recorder = useRecorder();
  const can = conversation.can;
  const convId = conversation.id;

  useEffect(() => {
    if (editing) {
      setText(editing.body || '');
      taRef.current?.focus();
    }
  }, [editing]);
  useEffect(() => {
    if (replyTo) taRef.current?.focus();
  }, [replyTo]);
  useEffect(() => {
    if (cooldown <= 0) return undefined;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(160, ta.scrollHeight)}px`;
  }, [text]);

  const post = async (payload) => {
    try {
      await api.post(`/api/conversations/${convId}/messages`, { ...payload, threadId, replyToId: replyTo?.id }, { quiet: true });
      onCancelReply?.();
      return true;
    } catch (err) {
      if (err.code === 'slow_mode') setCooldown(err.data.retryAfter || 5);
      handleError(err);
      return false;
    }
  };

  const send = async () => {
    const body = text.trim();
    if (editing) {
      try {
        await api.patch(`/api/messages/${editing.id}`, { body });
        onCancelEdit();
        setText('');
      } catch (err) {
        handleError(err);
      }
      return;
    }
    const ready = pending.filter((p) => p.file);
    if (pending.some((p) => !p.file && !p.error)) return toast('Wait for uploads to finish.');
    if (!body && !ready.length) return;
    const ok = await post({ body, fileIds: ready.map((p) => p.file.id) });
    if (ok) {
      setText('');
      setPending([]);
    }
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape') {
      if (editing) {
        onCancelEdit();
        setText('');
      } else onCancelReply?.();
    }
  };

  const onChange = (e) => {
    setText(e.target.value);
    if (Date.now() - lastTyping.current > 3000) {
      lastTyping.current = Date.now();
      realtime.send({ type: 'typing', conversationId: convId, threadId });
    }
  };

  const addUploads = async (files) => {
    if (!files?.length) return;
    const start = pending.length;
    await uploadMany(files, (items) => setPending((p) => [...p.slice(0, start), ...items]));
  };

  const onPaste = (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length && (can.sendMedia || can.uploadFiles)) {
      e.preventDefault();
      addUploads(files);
    }
  };

  const sendVoice = async () => {
    const file = await recorder.stop();
    if (!file || file.size < 500) return toast('Recording was too short.');
    try {
      const up = await uploadFile(file);
      await post({ fileIds: [up.id], voice: true });
    } catch (err) {
      handleError(err);
    }
  };

  const startVoice = async () => {
    try {
      await recorder.start();
    } catch {
      toast('Microphone access is needed for voice messages.', { error: true });
    }
  };

  const attachMenu = (e) => openMenu(e, [
    { label: 'Photo or video', icon: 'image', onClick: () => photoRef.current?.click(), hidden: !can.sendMedia },
    { label: 'Upload file', icon: 'upload', onClick: () => fileRef.current?.click(), hidden: !can.uploadFiles },
    { label: 'My Files', icon: 'folder', onClick: () => setDialog('files'), hidden: !can.uploadFiles && !can.sendMedia },
    { label: 'Create share link', icon: 'link', onClick: () => setDialog('link-pick'), hidden: !can.createLinks },
    { label: 'Voice message', icon: 'mic', onClick: startVoice, hidden: !can.sendMedia },
    { label: 'Poll', icon: 'poll', onClick: () => setDialog('poll') },
  ]);

  if (disabledReason) return <div className="readonly-bar">{disabledReason}</div>;

  return (
    <div className="composer">
      {(replyTo || editing) && (
        <div className="composer-context">
          <Icon name={editing ? 'edit' : 'reply'} className="icon-sm" />
          <div className="grow ellipsis">
            <b>{editing ? 'Editing message' : `Replying to ${replyTo.sender?.displayName || ''}`}</b>
            <div className="ellipsis muted">{(editing || replyTo).body || `[${(editing || replyTo).kind}]`}</div>
          </div>
          <IconButton icon="x" label="Cancel" onClick={() => { if (editing) { onCancelEdit(); setText(''); } else onCancelReply(); }} />
        </div>
      )}
      {pending.length > 0 && (
        <div className="pending-files">
          {pending.map((p) => (
            <div key={p.key} className="pending-file">
              <Icon name="file" className="icon-sm" />
              <span className="ellipsis" title={p.name}>{p.name}</span>
              {p.error ? <span className="danger-text tiny" title={p.error}>Failed</span> : p.file ? <span className="tiny muted">{formatBytes(p.size)}</span> : <div className="progress"><div style={{ width: `${Math.round(p.progress * 100)}%` }} /></div>}
              <IconButton icon="x" label="Remove" size={16} onClick={() => setPending((x) => x.filter((y) => y.key !== p.key))} />
            </div>
          ))}
        </div>
      )}
      <div className="composer-row">
        {recorder.recording ? (
          <>
            <IconButton icon="trash" label="Cancel recording" onClick={recorder.cancel} />
            <div className="recording"><span className="rec-dot" /> Recording {Math.floor(recorder.seconds / 60)}:{String(recorder.seconds % 60).padStart(2, '0')}</div>
            <IconButton icon="send" label="Send voice message" className="send" onClick={sendVoice} />
          </>
        ) : (
          <>
            {!editing && <IconButton icon="clip" label="Attach" onClick={attachMenu} />}
            <textarea
              ref={taRef}
              rows={1}
              value={text}
              onChange={onChange}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              placeholder={cooldown > 0 ? `Slow mode — wait ${cooldown}s` : threadId ? 'Reply to topic' : 'Message'}
              aria-label="Message"
              maxLength={4000}
            />
            {!editing && <IconButton icon="smile" label="Emoji, stickers and GIFs" onClick={() => setDialog('emoji')} />}
            {text.trim() || pending.length || editing ? (
              <IconButton icon={editing ? 'check' : 'send'} label={editing ? 'Save' : 'Send'} className="send" onClick={send} disabled={cooldown > 0} />
            ) : can.sendMedia ? (
              <IconButton icon="mic" label="Record voice message" onClick={startVoice} />
            ) : null}
          </>
        )}
      </div>
      <input ref={photoRef} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => { addUploads(e.target.files); e.target.value = ''; }} />
      <input ref={fileRef} type="file" multiple hidden onChange={(e) => { addUploads(e.target.files); e.target.value = ''; }} />
      <input ref={gifRef} type="file" accept="image/gif" hidden onChange={(e) => { addUploads(e.target.files); e.target.value = ''; }} />
      {menu}
      {dialog === 'files' && (
        <MyFilesPicker
          onClose={() => setDialog(null)}
          onPick={async (files) => {
            setDialog(null);
            await post({ body: text.trim(), fileIds: files.map((f) => f.id) });
            setText('');
          }}
        />
      )}
      {dialog === 'gif-files' && (
        <MyFilesPicker accept="image" multiple={false} title="Choose a GIF" onClose={() => setDialog(null)} onPick={async ([f]) => { setDialog(null); await post({ fileIds: [f.id] }); }} />
      )}
      {dialog === 'link-pick' && (
        <MyFilesPicker multiple={false} title="Choose a file to share" onClose={() => setDialog(null)} onPick={([f]) => setDialog({ link: f })} />
      )}
      {dialog?.link && (
        <ShareLinkDialog file={dialog.link} onClose={() => setDialog(null)} onCreated={(l) => setText((t) => `${t ? `${t} ` : ''}${l.url}`)} />
      )}
      {dialog === 'poll' && <PollDialog onClose={() => setDialog(null)} onSubmit={async (poll) => { setDialog(null); await post({ poll }); }} />}
      {dialog === 'emoji' && (
        <EmojiPicker
          onClose={() => setDialog(null)}
          onEmoji={(e) => { setText((t) => t + e); setDialog(null); taRef.current?.focus(); }}
          onSticker={async (id) => { setDialog(null); await post({ sticker: id }); }}
          onGif={(how) => { setDialog(how === 'files' ? 'gif-files' : null); if (how === 'upload') gifRef.current?.click(); }}
        />
      )}
    </div>
  );
}
