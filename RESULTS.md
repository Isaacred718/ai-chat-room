# RESULTS — AI Chat Room rebuild scaffold

## What was built
A no-build static chat UI, a Supabase schema, and an always-on bridge listener, with every URL and key a placeholder.

| File | Purpose |
|---|---|
| `index.html`, `app.js`, `style.css` | Login gate, message list (kind badges, agent/machine labels, times), 7-participant sidebar with presence dots, composer, Live Dispatch form, realtime subscriptions, two-tap Clear room |
| `config.js`, `config.example.js` | `window.CHAT_CONFIG` placeholders (`config.js` is the committed placeholder copy) |
| `supabase/schema.sql` | `messages`, `jobs`, `presence`, indexes, RLS (authenticated full access, anon none), guarded realtime publication adds |
| `bridge/listener.mjs`, `bridge/package.json` | Job claimer, router, lane runners, presence heartbeat, SIGTERM handling |
| `bridge/ai-chat-room-bridge.service` | systemd user unit template |
| `README.md`, `.gitignore` | Setup (Phase 0, Pages, bridge install), security notes |

## How it was verified
- `node --check bridge/listener.mjs`: passed.
- `node --check app.js`: passed.
- HTML reference check: `style.css`, `config.js` and `app.js` exist. The supabase-js script is a CDN URL, which I did not fetch.
- Every element id that `app.js` looks up exists in `index.html` (checked by comparing the lists by eye).
- A grep of the repo found no real keys, URLs or tokens, only placeholders. The one non-placeholder value is the tailnet address `100.77.231.71`, which the brief supplied as a default.

## Design notes
- Chat sends insert the user message, then a "Queued for the real Agent @ Machine" system message (`kind='system'`), then the job. The UI generates the placeholder and job UUIDs client-side so the two rows link. The bridge updates that placeholder row. If the room was cleared meanwhile, it inserts a new row.
- The "Room" target goes to Muse. The brief did not define Room routing, so this is my assumption.
- Meta AI inserts the user message plus a system note ("no live lane"). No job is created.
- Auto-classification is a simple heuristic: prompt over 800 characters, or a keyword such as refactor, implement, debug, build or design. It is easy to change in `classify()`.
- The Mac-capable lanes are duet, hermes, muse and codex, plus claude. A complex job on any other lane (grok, opencode) runs on idw-2 and says so in `route_note`.
- On startup the bridge fails any job it left `running` earlier, with an honest error. On SIGTERM it kills child processes, fails those jobs, and marks idw-2 offline.

## Known gaps / not verified
- **Nothing was run end to end.** There is no Supabase project, so login, RLS, realtime, job claiming and message updates were never exercised.
- `npm install` was not run (it needed approval), so the `@supabase/supabase-js` import in `listener.mjs` is unresolved here. Run `npm install` in `bridge/`.
- I did not test the `claude`, `codex`, `grok` and `opencode` CLIs, or the claude `--append-system-prompt` flag, on this machine.
- Grok headless detection checks `--help` for `--prompt`, then `--print`, then `--headless`. The calling convention for each is a guess.
- The Mac ssh path is untested. I don't know whether stdin passes through `launchctl asuser` with `zsh -lc`. If it doesn't, the Mac lanes will fail with the real error.
- The Hermes non-interactive command is unknown. It defaults to `hermes chat -q` and is overridable with `HERMES_MAC_CMD`.
- The Mac's presence row comes only from the bridge's `tailscale ping`. Nothing on the Mac writes to it.
- The browser UI was never opened. The syntax check and the id comparison are the only UI checks.
- `config.js` is committed with placeholders. Replace the values before deploying, and never put the service key in it.
