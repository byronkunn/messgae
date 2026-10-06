# messgae

A mobile-first messaging platform: private DMs, group chats, Discord-style Spaces with channels, profiles, Explore, lightweight file storage with share links, moderation and a full site-administration console.

The product is **messaging first**. Storage exists to make sending files easy, profiles provide identity, Explore helps people find public communities, and Spaces organise bigger conversations.

- **Server:** Node.js 22 (Express, `node:sqlite`, `ws`). No native build dependencies.
- **Client:** React 19 + Vite, plain CSS design system (mobile → tablet → desktop).
- **Storage:** SQLite (WAL) + a content-addressed, AES-256-GCM encrypted blob store on disk.

## Quick start

```bash
npm install
npm run seed          # optional: demo users, DMs, a group, a public Space; prints sign-in details
npm run dev           # API on :3000, web app on http://localhost:5173
```

Open http://localhost:5173 and **create a private account** (no email, phone or password), or sign in with one of the seeded accounts using its Account ID and Recovery Key.

To make someone staff:

```bash
npm run make-admin -- <username> super_admin --evidence
```

Staff must enable two-factor authentication (Settings → Security) before the Admin console unlocks.

| Command | What it does |
| --- | --- |
| `npm run dev` | API server with `--watch` plus the Vite dev server |
| `npm test` | Integration tests (Node test runner, real HTTP server, temp database) |
| `npm run lint` | ESLint over server and client |
| `npm run build` | Production client build into `dist/` |
| `npm start` | Production server (serves `dist/` and the API on one port) |
| `npm run seed` | Demo data for a fresh `DATA_DIR` |
| `npm run make-admin -- <user> [role] [--evidence]` | Grant a site role from the command line |
| `npm run bench -- [users] [messages]` | Synthetic-data timing of hot API paths (defaults 20k users / 300k messages) |

## What's included

**Accounts & security**
- Private accounts: random 24-digit **Account ID** (identifier) + separate 160-bit **Recovery Key** (secret). Only a scrypt verifier of the key is stored.
- Recovery Kit: copy, QR code, downloadable HTML kit, print view; clear warning about unrecoverable accounts. Regenerating a key invalidates the old one (requires the current key, a 2FA code, or a device signed in for 7+ days).
- Multiple device sessions, **Settings → Security → Devices** (name, type, last activity, created, current device, remote sign-out, sign out all others).
- **QR device linking**: the new device shows a QR/code; an already signed-in device approves it.
- Optional TOTP two-factor; required for staff.

**Messaging**
- DMs, groups and Space channels share one conversation model.
- Text, replies, reactions, edit, delete, @mentions / @everyone, emoji, stickers, GIFs (uploaded), images, video, audio, **voice messages**, documents, archives, polls, link cards (built on-device — we never fetch the linked page), pinned messages, per-conversation search, typing indicators, read receipts (reciprocal), unread counts, live updates over WebSocket.
- Conversation menu: search, media, files, links, pinned, mute, block, report, clear (your view only), delete / leave.

**Groups** — name, avatar, description, owner/admin/moderator/member roles, invite links (expiry, max uses), member permissions, slow mode, lock, remove, timeout, ban, join requests, public/discoverable groups.

**Spaces** — categories and channels (**text, announcement, media, forum, private**), bit-flag role permissions with per-channel overrides (@everyone → roles → member), Space roles Member/Moderator/Admin/Owner plus custom roles with hierarchy, invites, join modes, bans, timeouts, Space report queue, moderation log, Space audit log, ownership transfer, Space Pro analytics. **Space roles never grant site permissions.**

**Explore** — For You / Trending / Spaces / Groups / Channels / Topics / New, search, filters (type, topic, size, activity, language, membership, sort). Only public Spaces/groups whose owners opt in are listed; public Spaces can be previewed before joining.

**Files** — upload once, send anywhere (messages reference the stored file; identical content is stored once), My Files categories (Recent, Images, Videos, Audio, Documents, Archives, Shared, Trash), Save to My Files, rename, trash/restore/delete, storage quota by plan, **share links** (anyone / contacts / selected people, password, expiry, max downloads, preview-only, revoke) and **Files → Shared** management, **password-protected files**.

**Moderation & administration**
- Reports with evidence snapshots (the reported message plus the context the reporter could see).
- Site roles: User, Site Moderator, Site Admin, Super Admin, plus the separate **Evidence Access** grant.
- Admin console (fully responsive): Overview, Users, Communications, Conversations, Groups, Spaces, Files, Storage, Reports, Explore, Analytics, Security, Billing, System, Audit Logs, and **global search** by username, Account ID or any ID, filename or SHA-256.
- Communications dashboard with rankings (conversations, groups, Spaces, channels, fastest-growing, media/file-heavy, storage consumers) and 1h / 24h / 7d / 30d / custom ranges.
- Conversation inspector (metadata for moderators; message contents only with Evidence Access), file inspector (popular vs. trending, downloads, bandwidth, velocity, password reveal, restrict / quarantine / remove, including all copies with the same hash).
- Site analytics: users, messaging, groups, Spaces, storage (with 90-day forecast), bandwidth, engagement, revenue, moderation, security.
- All large admin lists use **server-side pagination, filtering and sorting** with 25/50/100 page sizes and keyset cursors for Next/Previous (deep page jumps are capped).

## Security model

| Area | Implementation |
| --- | --- |
| Transport | HTTPS expected in production (HSTS header, `Secure` cookies when `NODE_ENV=production`) |
| Sessions | 256-bit random tokens in `HttpOnly`, `SameSite=Lax` cookies; only SHA-256 hashes stored; 90-day idle expiry; revocable |
| CSRF | Custom request header required on every state-changing API call + Origin check + SameSite cookies |
| WebSockets | Same cookie auth, Origin allow-list, 64 KB frame limit |
| XSS | React escaping, strict CSP, uploaded files served with `nosniff`, sandbox CSP and `attachment` disposition unless an allow-listed media type |
| Uploads | Size limits per plan, **file-signature detection** (client MIME ignored), extension/content mismatch rejected |
| At rest | Blobs encrypted with AES-256-GCM using per-blob HKDF keys from `STORAGE_KEY`; TOTP secrets sealed with `APP_SECRET_KEY`; recoverable file/link passwords sealed with a dedicated `FILE_PASSWORD_KEY` (kept outside the DB) |
| Secrets | Recovery keys and file passwords verified with scrypt; timing-safe comparisons; dummy work for unknown accounts |
| Brute force | Rate limits on sign-in, links, unlocks, registrations; exponential account lockout |
| Admin | Capability-based RBAC, mandatory staff 2FA, **10-minute privileged sessions** (2FA re-auth) for Evidence Access, bans, security changes, staff changes and exports; investigation reasons required |
| Audit | Append-only (DB triggers block UPDATE/DELETE) and **hash-chained** audit log with a verification tool |

Only established primitives from Node's `crypto` module are used — no custom cryptography.

### Privacy model (shown to users in Settings → Privacy model)

Messages and files are encrypted in transit and at rest **but are not end-to-end encrypted**. The service can read them to provide search, moderation and safety. Staff with Evidence Access can view conversations, download files and reveal stored file passwords during investigations; every such access requires a reason and a fresh 2FA check and is audit-logged. The app never describes this as zero-knowledge.

## Configuration

See [`.env.example`](.env.example). In development the three encryption keys are generated into `data/keys/`; in production they must be supplied from a secret store and kept out of database backups.

Plans and limits (free / Plus / Space Pro) live in [`server/config.js`](server/config.js). Payments are not wired up: admins assign plans, and the Billing page shows estimated MRR.

## Deployment

```bash
docker build -t messgae .
docker run -p 3000:3000 -v messgae-data:/data --env-file .env messgae
```

Put it behind a TLS-terminating reverse proxy (set `TRUST_PROXY=1`, `PUBLIC_ORIGIN`, `ALLOWED_ORIGINS`) that also forwards WebSocket upgrades on `/ws`.

## Project layout

```
server/
  app.js              Express app, security headers, CSRF guard, route mounting
  db.js               Schema (SQLite) and a small query helper
  lib/                auth, crypto, permissions, messaging, files, storage, pagination, audit, realtime
  routes/             auth, me, users, conversations, messages, files, links, spaces, invites, explore, reports, admin/*
  test/               integration tests
client/src/
  styles.css          design system (tokens, components, responsive shell)
  components/         shell, conversation, composer, message, dialogs
  pages/              chats, spaces, explore, files, profile, settings, admin/*
scripts/              dev runner, seed, make-admin
```

## Known limitations / next steps

- Single-node: rate limits and WebSocket fan-out are in-process. Scaling out needs Redis (or similar) and an S3-compatible blob backend.
- Admin 2FA is TOTP; WebAuthn passkeys are the next step.
- Video is served without HTTP range support (files are GCM-encrypted as a whole); chunked encryption would enable seeking in long videos.
- No push notifications, payment processing or end-to-end encryption in this MVP.
- Analytics are computed from live tables. With 20k users / 300k messages, list and chat endpoints respond in ~1–9 ms and the 7-day communications dashboard in ~0.5 s (`npm run bench`); move dashboards to rollup tables before much larger volumes.
