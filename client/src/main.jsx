import { StrictMode, lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation } from 'react-router-dom';
import './styles.css';
import { AppProvider, useApp } from './store.jsx';
import { Loading } from './components/ui.jsx';
import Shell from './components/Shell.jsx';
import { Welcome, CreateAccount, SignIn, NewDeviceLink, AccountBlocked } from './pages/Auth.jsx';
import ChatsPage from './pages/Chats.jsx';
import SpacePage from './pages/spaces/Space.jsx';
import SpaceSettings from './pages/spaces/SpaceSettings.jsx';
import ExplorePage from './pages/Explore.jsx';
import FilesPage from './pages/Files.jsx';
import NewPage from './pages/New.jsx';
import ProfilePage, { UserProfilePage } from './pages/Profile.jsx';
import SettingsPage from './pages/settings/Settings.jsx';
import NotificationsPage from './pages/Notifications.jsx';
import { ApproveDevice, InvitePage, PublicLinkPage } from './pages/Misc.jsx';

const AdminApp = lazy(() => import('./pages/admin/Admin.jsx'));

try {
  const theme = localStorage.getItem('theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme);
} catch {
  /* storage unavailable */
}

function RequireAuth() {
  const { me } = useApp();
  const loc = useLocation();
  if (me === undefined) return <Loading />;
  if (me?.blocked) return <AccountBlocked error={me.blocked} />;
  if (!me) return <Navigate to="/welcome" replace state={{ from: loc.pathname + loc.search + loc.hash }} />;
  return <Outlet />;
}

function PublicOnly() {
  const { me } = useApp();
  if (me === undefined) return <Loading />;
  if (me?.user) return <Navigate to="/chats" replace />;
  return <Outlet />;
}

function App() {
  return (
    <Routes>
      <Route element={<PublicOnly />}>
        <Route path="/welcome" element={<Welcome />} />
        <Route path="/create" element={<CreateAccount />} />
        <Route path="/signin" element={<SignIn />} />
        <Route path="/link" element={<NewDeviceLink />} />
      </Route>
      <Route path="/s/:token" element={<PublicLinkPage />} />
      <Route element={<RequireAuth />}>
        <Route path="/link-device" element={<ApproveDevice />} />
        <Route path="/invite/:code" element={<InvitePage />} />
        <Route path="/admin/*" element={<Suspense fallback={<Loading />}><AdminApp /></Suspense>} />
        <Route element={<Shell />}>
          <Route index element={<Navigate to="/chats" replace />} />
          <Route path="/chats" element={<ChatsPage />} />
          <Route path="/chats/:id" element={<ChatsPage />} />
          <Route path="/spaces/:spaceId" element={<SpacePage />} />
          <Route path="/spaces/:spaceId/settings/*" element={<SpaceSettings />} />
          <Route path="/spaces/:spaceId/c/:channelId" element={<SpacePage />} />
          <Route path="/spaces/:spaceId/c/:channelId/t/:threadId" element={<SpacePage />} />
          <Route path="/explore" element={<ExplorePage />} />
          <Route path="/files" element={<FilesPage />} />
          <Route path="/files/:category" element={<FilesPage />} />
          <Route path="/new" element={<NewPage />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/u/:username" element={<UserProfilePage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="/settings/:page" element={<SettingsPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AppProvider>
        <App />
      </AppProvider>
    </BrowserRouter>
  </StrictMode>,
);
