# Lane Brief — AI Chat Room rebuild scaffold (idw-2)

You are a build lane on idw-2 (hostname IDW). Build a project scaffold in a NEW
directory `~/Work/ai-chat-room-build/`. Do not touch any other project. No real
secrets exist yet: every key/URL is a placeholder supplied via config files.

## Product

A single-user chat room where Isaac talks with real cluster agents. It replaces
a Muse Space + 5-minute polling watcher with: a static page on GitHub Pages, a
Supabase backend (Postgres + Realtime + Auth), and an always-on bridge listener
on this machine (idw-2) that runs the agent lanes within seconds.

Participants: Muse (conductor), Claude Duet (Claude Code on the M1 Mac),
Codex, OpenCode, Grok, Hermes (all idw-2 lanes except Duet/Hermes Mac-pinned),
Meta AI (NO live lane: visibly labelled "No live lane — simulated only", never
queued, never faked).

Routing rule (standing, from Isaac): light tasks -> idw-2 lanes; complex tasks
-> M1 Mac agents; if the Mac is not online in the tailnet, complex tasks
automatically run on idw-2 and the fallback is recorded in route_note, never
silent. Manual route override in the job wins. Duet is pinned to the Mac (fail
honestly if the Mac is offline). Hermes is Mac-only (fail honestly if offline).

## Deliverables (all inside ~/Work/ai-chat-room-build/, one git repo, one commit)

1. `index.html`, `app.js`, `style.css` — static chat UI, no build step:
   - Loads supabase-js v2 from CDN and `config.js` (window.CHAT_CONFIG with
     SUPABASE_URL and SUPABASE_ANON_KEY placeholder values).
   - Supabase Auth email/password login gate; signed-out visitors see only the
     login form (data protection is RLS, not the page).
   - Message list rendering sender, kind badge (live / simulated / failed /
     system), agent and machine labels, timestamps.
   - Participant sidebar: the 7 participants above with presence dots driven
     by the `presence` table; Meta AI labelled simulated-only.
   - Composer: pick a participant (or Room), type, send. Sending to a
     lane-backed participant inserts a row into `jobs` (kind='chat') plus the
     user's own message row into `messages`. A "Queued for the real
     Agent @ Machine" placeholder message is inserted and later replaced by
     the bridge's live reply (the bridge updates that placeholder row's
     content/kind, matched by jobs.placeholder_message_id).
   - A Live Dispatch form (prompt, lane select, complexity Auto/Light/Complex,
     route Auto/Mac/IDW-2) inserting jobs kind='dispatch'.
   - Realtime subscriptions on `messages` and `presence` so replies render
     the instant the bridge writes them.
   - Two-tap Clear room button (deletes messages, keeps jobs audit).
   - Clean, compact styling consistent with a chat app; dark theme fine.

2. `supabase/schema.sql` — idempotent where reasonable:
   - Tables: `messages` (id uuid pk default gen_random_uuid(), created_at
     timestamptz default now(), sender text, kind text check in
     ('user','live','simulated','failed','system'), content text, agent text,
     machine text, job_id uuid null), `jobs` (id uuid pk, created_at, kind
     text check in ('chat','dispatch'), prompt text, lane text, agent text,
     classification text default 'auto', route_mode text default 'auto',
     route_note text, target_machine text, status text default 'pending'
     check in ('pending','running','done','failed','cancelled'), result text,
     error text, placeholder_message_id uuid null, claimed_by text,
     claimed_at timestamptz, finished_at timestamptz), `presence` (machine
     text pk, online boolean, checked_at timestamptz, detail text).
   - Indexes on jobs(status, created_at) and messages(created_at).
   - RLS enabled on all three tables; policies: authenticated role may
     select/insert/update/delete (single-user app; signups get disabled in
     the dashboard — note that in a SQL comment); anon role: no policies.
   - `alter publication supabase_realtime add table` for messages, jobs,
     presence.

3. `bridge/listener.mjs` — Node 20+ ESM, dependency: @supabase/supabase-js
   (add package.json). Behaviour:
   - Config from env file path in AICR_ENV or default
     ~/.config/ai-chat-room/bridge.env: SUPABASE_URL, SUPABASE_SERVICE_KEY
     (service role; bypasses RLS; this file is chmod 600 and never committed).
   - Creates Supabase client with the service key; subscribes to INSERT on
     jobs via Realtime; ALSO polls every 2s for status='pending' as fallback.
   - Claims a job atomically: update set status='running', claimed_by='idw-2',
     claimed_at=now() where id and status='pending'; skip if 0 rows changed.
     Max 3 concurrent jobs.
   - Router: resolve target machine from job fields + presence freshness
     (Mac presence row checked_at within 3 min and online=true means Mac up;
     else also try `tailscale ping -c 1 100.77.231.71` once). Complex -> Mac
     if up else idw-2 with route_note 'Complex → IDW-2 (Mac offline)'.
     Duet/Hermes -> Mac only; if Mac down, fail the job with error
     'Mac offline — Duet/Hermes lanes live on the Mac'.
   - Lane runners (local, cwd ~/Work/cluster, 240s timeout unless noted):
     * claude: first run `claude auth status`; if not loggedIn, fail with
       'Claude auth expired on IDW-2'. Else `claude -p --model sonnet`.
     * muse: same claude lane with a conductor/orchestrator system prompt
       (pass via --append-system-prompt), labelled Muse @ IDW-2.
     * codex: `codex exec <prompt>`.
     * grok: detect a headless/print flag from `grok --help`; if none, fail
       honestly 'Grok headless mode unavailable'.
     * opencode: `opencode run <prompt>` with a 120s timeout; on timeout
       fail once with 'OpenCode headless run timed out (known issue)'.
       Never retry in a loop.
     * hermes/duet (Mac): run over ssh
       `ssh -o ProxyCommand="$HOME/workspace/ssh_tailnet.sh %h %p" -o
       StrictHostKeyChecking=accept-new -i ~/.ssh/omarchy_muse
       idw-1@100.77.231.71` — Duet via the GUI-domain wrapper script
       ~/workspace/claude-duet-comms/duet.sh equivalent ON THE MAC:
       use the Mac path from the brief: run `claude -p --model sonnet` in the
       Mac GUI domain via launchctl asuser per the known pattern; if that
       route errors, fail honestly with the error. Hermes: if a hermes CLI
       exists on the Mac, call it non-interactively; else fail honestly.
   - On success: update job status='done', result, finished_at; update the
     placeholder message (or insert a new messages row) sender='<Agent> @
     <Machine>', kind='live', content=result.
   - On failure: job status='failed', error set; placeholder/message updated
     kind='failed' with the honest reason. Never fabricate output.
   - Presence heartbeat every 60s: upsert presence row for 'idw-2'
     (online=true) and for 'idw-m1-mac' from a tailscale ping result.
   - Graceful SIGTERM handling; plain console logging with timestamps.

4. `bridge/ai-chat-room-bridge.service` — systemd USER unit template
   (ExecStart node listener.mjs, Restart=always, EnvironmentFile pointing at
   the bridge.env), with install notes in README.

5. `config.example.js`, `.gitignore` (node_modules, bridge.env, *.local),
   `README.md` — setup steps: Phase 0 (create Supabase project, run
   schema.sql in SQL editor, create Isaac's auth user, disable signups),
   fill config.js, enable GitHub Pages on the repo, install the bridge on
   idw-2 (npm install, env file chmod 600, systemctl --user enable --now),
   security notes (anon key public by design; service key only on idw-2/Mac;
   page shell is public, data is behind Auth + RLS).

6. `RESULTS.md` — what you built, file list, how you verified (at minimum:
   `node --check` on listener.mjs and app.js, and a headless sanity pass that
   the HTML references resolve), known gaps, anything you could not verify.

## Hard constraints

- Placeholders only: no real URLs, keys, or tokens anywhere.
- Fail honestly in code paths; never invent agent output.
- One git init + one commit containing everything, message
  'AI Chat Room rebuild scaffold'.
- Keep it dependency-light and readable; Isaac maintains this after you.

Done = all files exist, syntax checks pass, commit made, RESULTS.md written.
