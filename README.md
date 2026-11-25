# AI Chat Room

Single-user chat room for talking with real cluster agents. Static page (GitHub Pages)
+ Supabase (Postgres, Realtime, Auth) + an always-on bridge on idw-2 that runs the lanes.

```
index.html app.js style.css config.js   static UI (no build step)
supabase/schema.sql                      tables, RLS, realtime
bridge/listener.mjs                      job runner (Node 20+)
bridge/ai-chat-room-bridge.service       systemd user unit
```

## Phase 0 — Supabase

1. Create a Supabase project.
2. SQL editor: paste and run `supabase/schema.sql` (safe to re-run).
3. Authentication → Users → add Isaac's email/password user.
4. Authentication → Providers → Email → **disable "Allow new users to sign up"**.
   RLS lets *any* authenticated user do everything, so signups must stay off.

## Configure the page

```
cp config.example.js config.js   # then edit
```
Set `SUPABASE_URL` and `SUPABASE_ANON_KEY` (Project settings → API). The anon key is
public by design; protection comes from Auth + RLS. Commit `config.js` only with the anon key.

Enable GitHub Pages: repo Settings → Pages → deploy from branch, root folder.

## Install the bridge on idw-2

```
cd bridge && npm install
mkdir -p ~/.config/ai-chat-room
cat > ~/.config/ai-chat-room/bridge.env <<'EOF'
SUPABASE_URL=https://YOUR-PROJECT-REF.supabase.co
SUPABASE_SERVICE_KEY=YOUR-SERVICE-ROLE-KEY
EOF
chmod 600 ~/.config/ai-chat-room/bridge.env

mkdir -p ~/.config/systemd/user
cp ai-chat-room-bridge.service ~/.config/systemd/user/   # edit WorkingDirectory/paths if needed
systemctl --user daemon-reload
systemctl --user enable --now ai-chat-room-bridge
journalctl --user -u ai-chat-room-bridge -f
```
Use `loginctl enable-linger $USER` so it runs without an open session.
Foreground test: `AICR_ENV=/path/to/bridge.env node listener.mjs`.

Optional env: `MAC_HOST`, `MAC_USER`, `SSH_PROXY`, `SSH_KEY`, `LANE_CWD`, `HERMES_MAC_CMD`.

## Routing

Light → idw-2. Complex → M1 Mac if up (presence row fresh within 3 min, else one
`tailscale ping`), otherwise idw-2 with `route_note` "Complex → IDW-2 (Mac offline)".
Manual route in a dispatch wins. Duet and Hermes are Mac-only and fail honestly if the
Mac is offline. Meta AI has no lane: nothing is queued. "Room" messages go to Muse.

## Security

- The anon key is public by design. The page shell is public; data is behind Auth + RLS
  (anon role has no policies).
- The service-role key bypasses RLS: keep it only in `bridge.env` (chmod 600) on idw-2/Mac.
  Never commit it or put it in `config.js`.
- Disable signups (Phase 0 step 4).
- Agent output is rendered with `textContent`, never as HTML.
