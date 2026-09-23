import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, onApiError } from './api.js';
import { realtime } from './realtime.js';
import { Modal, Field } from './components/ui.jsx';

const AppContext = createContext(null);
export const useApp = () => useContext(AppContext);

export function useRealtime(handler, deps = []) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => realtime.subscribe((e) => ref.current(e)), deps); // eslint-disable-line react-hooks/exhaustive-deps
}

function ConfirmDialog({ opts, resolve }) {
  return (
    <Modal
      title={opts.title}
      onClose={() => resolve(false)}
      footer={
        <>
          <button className="btn" onClick={() => resolve(false)}>Cancel</button>
          <button className={`btn ${opts.danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => resolve(true)}>
            {opts.confirmLabel || 'Confirm'}
          </button>
        </>
      }
    >
      {typeof opts.message === 'string' ? <p className="muted">{opts.message}</p> : opts.message}
    </Modal>
  );
}

function PromptDialog({ opts, resolve }) {
  const [value, setValue] = useState(opts.defaultValue || '');
  const tooShort = (opts.minLength || 0) > value.trim().length;
  const submit = (e) => {
    e?.preventDefault();
    if (!tooShort) resolve(value.trim());
  };
  return (
    <Modal
      title={opts.title}
      onClose={() => resolve(null)}
      footer={
        <>
          <button className="btn" onClick={() => resolve(null)}>Cancel</button>
          <button className={`btn ${opts.danger ? 'btn-danger' : 'btn-primary'}`} disabled={tooShort} onClick={submit}>
            {opts.confirmLabel || 'OK'}
          </button>
        </>
      }
    >
      <form onSubmit={submit}>
        {opts.message && <p className="muted">{opts.message}</p>}
        <Field label={opts.label} hint={opts.hint}>
          {opts.multiline ? (
            <textarea className="input" value={value} placeholder={opts.placeholder} onChange={(e) => setValue(e.target.value)} autoFocus />
          ) : (
            <input className="input" type={opts.type || 'text'} value={value} placeholder={opts.placeholder} onChange={(e) => setValue(e.target.value)} autoFocus autoComplete="off" />
          )}
        </Field>
      </form>
    </Modal>
  );
}

function ElevateDialog({ resolve }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e) => {
    e?.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/auth/elevate', { code }, { quiet: true });
      resolve(true);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Confirm it's you"
      onClose={() => resolve(false)}
      footer={
        <>
          <button className="btn" onClick={() => resolve(false)}>Cancel</button>
          <button className="btn btn-primary" disabled={code.length < 6 || busy} onClick={submit}>Verify</button>
        </>
      }
    >
      <form onSubmit={submit}>
        <p className="muted">This action needs a privileged session. Enter the 6-digit code from your authenticator app. It stays active for 10 minutes.</p>
        <Field label="Authenticator code">
          <input className="input mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
        </Field>
        {error && <div className="notice danger">{error}</div>}
      </form>
    </Modal>
  );
}

export function AppProvider({ children }) {
  const [me, setMe] = useState(undefined); // undefined = loading, null = signed out
  const [conversations, setConversations] = useState(null);
  const [spaces, setSpaces] = useState(null);
  const [toasts, setToasts] = useState([]);
  const [dialog, setDialog] = useState(null);
  const [connected, setConnected] = useState(true);
  const activeConv = useRef(null);

  const toast = useCallback((message, { error = false, duration = 3200 } = {}) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), duration);
  }, []);

  const refreshMe = useCallback(async () => {
    try {
      const data = await api.get('/api/me', { quiet: true });
      setMe(data);
      return data;
    } catch (err) {
      if (err.status === 401 || err.code?.startsWith('account_')) setMe(err.code?.startsWith('account_') ? { blocked: err } : null);
      else setMe(null);
      return null;
    }
  }, []);

  const refreshConversations = useCallback(async () => {
    try {
      const data = await api.get('/api/conversations', { quiet: true });
      setConversations(data.conversations);
    } catch {
      /* ignore */
    }
  }, []);

  const refreshSpaces = useCallback(async () => {
    try {
      const data = await api.get('/api/spaces', { quiet: true });
      setSpaces(data.spaces);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    refreshMe();
  }, [refreshMe]);

  const signedIn = !!me?.user;
  useEffect(() => {
    if (!signedIn) return undefined;
    refreshConversations();
    refreshSpaces();
    realtime.start();
    const offStatus = realtime.onStatus(({ connected: c }) => {
      setConnected(c);
      if (c) {
        refreshConversations();
        refreshSpaces();
      }
    });
    return () => {
      offStatus();
      realtime.stop();
    };
  }, [signedIn, refreshConversations, refreshSpaces]);

  // Keep lists fresh from live events.
  const spacesTimer = useRef(null);
  useRealtime((e) => {
    if (e.type === 'message:new') {
      const m = e.message;
      setConversations((list) => {
        if (!list) return list;
        const idx = list.findIndex((c) => c.id === e.conversationId);
        if (idx === -1) {
          refreshConversations();
          return list;
        }
        const c = { ...list[idx] };
        c.lastMessage = { id: m.id, text: m.body || (m.kind === 'system' ? 'Update' : `[${m.kind}]`), senderId: m.sender?.id, senderName: m.sender?.displayName, createdAt: m.createdAt };
        c.lastMessageAt = m.createdAt;
        if (m.sender?.id !== me?.user?.id && activeConv.current !== c.id && m.kind !== 'system') c.unread = (c.unread || 0) + 1;
        return [c, ...list.slice(0, idx), ...list.slice(idx + 1)];
      });
      if (!conversations?.some((c) => c.id === e.conversationId)) {
        clearTimeout(spacesTimer.current);
        spacesTimer.current = setTimeout(refreshSpaces, 800);
      }
    } else if (e.type === 'read:self') {
      setConversations((list) => list?.map((c) => (c.id === e.conversationId ? { ...c, unread: 0 } : c)));
    } else if (e.type === 'notification') {
      setMe((m) => (m ? { ...m, unread: { ...m.unread, notifications: (m.unread?.notifications || 0) + 1 } } : m));
      const n = e.notification;
      if (n.type === 'group_added' || n.type === 'join_approved') {
        refreshConversations();
        refreshSpaces();
      }
    } else if (e.type === 'conversation:removed' || e.type === 'conversation:update') {
      refreshConversations();
    } else if (e.type === 'session:revoked') {
      setMe(null);
    }
  }, [me?.user?.id, conversations]);

  useEffect(
    () =>
      onApiError((err) => {
        if (err.status === 401 && err.code === 'unauthenticated') setMe(null);
        else if (err.code?.startsWith?.('account_suspended') || err.code === 'account_banned') setMe({ blocked: err });
      }),
    [],
  );

  const openDialog = useCallback((Component, opts) => new Promise((resolve) => {
    setDialog({ Component, opts, resolve: (v) => { setDialog(null); resolve(v); } });
  }), []);

  const confirm = useCallback((opts) => openDialog(ConfirmDialog, opts), [openDialog]);
  const prompt = useCallback((opts) => openDialog(PromptDialog, opts), [openDialog]);
  const elevate = useCallback(() => openDialog(ElevateDialog, {}), [openDialog]);

  /** Runs an API call; if the server asks for a privileged session, prompts for 2FA then retries once. */
  const privileged = useCallback(async (fn) => {
    try {
      return await fn();
    } catch (err) {
      if (err.code === 'reauth_required') {
        if (await elevate()) {
          refreshMe();
          return fn();
        }
        throw Object.assign(new Error('Cancelled'), { cancelled: true });
      }
      throw err;
    }
  }, [elevate, refreshMe]);

  const handleError = useCallback((err) => {
    if (err?.cancelled) return;
    toast(err?.message || 'Something went wrong.', { error: true });
  }, [toast]);

  const signOut = useCallback(async () => {
    try {
      await api.post('/api/auth/logout');
    } finally {
      realtime.stop();
      setConversations(null);
      setSpaces(null);
      setMe(null);
    }
  }, []);

  const setActiveConversation = useCallback((id) => {
    activeConv.current = id;
  }, []);

  const value = useMemo(() => ({
    me, setMe, refreshMe, conversations, setConversations, refreshConversations, spaces, refreshSpaces,
    toast, confirm, prompt, elevate, privileged, handleError, signOut, connected, setActiveConversation,
  }), [me, refreshMe, conversations, refreshConversations, spaces, refreshSpaces, toast, confirm, prompt, elevate, privileged, handleError, signOut, connected, setActiveConversation]);

  return (
    <AppContext.Provider value={value}>
      {children}
      {dialog && <dialog.Component opts={dialog.opts} resolve={dialog.resolve} />}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.error ? 'error' : ''}`}>{t.message}</div>
        ))}
      </div>
    </AppContext.Provider>
  );
}
