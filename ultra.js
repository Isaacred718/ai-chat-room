// Ultra Dashboard Phase 5 frontend. No build step.
// Reads: Supabase selects + realtime subscriptions + auth.
// WRITE ALLOWLIST (Phases 2-5 — Isaac-click + confirm only, nothing
// else):
//   (a) jobs INSERT via insertJob() — the one shared code path for
//       Retry / Re-run, Dispatch (global + follow-up), AND the
//       Capability Finder approval job (Phase 5), dispatch shape.
//   (b) jobs UPDATE of status to 'cancelled' in cancelJob() — one job id.
// No other inserts/updates/deletes/upserts/RPC anywhere in this file,
// and it writes nothing to Bot HQ or Muse Dash. localStorage keys:
// 'ultra-followups-v1' (on-device follow-up links) and
// 'ultra-skill-proposals-v1' (Phase 5, on-device skill proposals).
// fetch(): NONE anywhere in this file. skills.sh's JSON search API
// sends no Access-Control-Allow-Origin header (verified 2026-11-28,
// GET + OPTIONS preflight), so a browser fetch from this origin is
// blocked by CORS and the Capability Finder ships its fallback branch:
// it links out to skills.sh search and takes pasted candidates.
(() => {
  const cfg = window.CHAT_CONFIG || {};
  const $ = (id) => document.getElementById(id);

  // Same roster, machines, freshness window, and colors as the Chat Room (app.js).
  const PARTICIPANTS = [
    { lane: "muse", name: "Muse", role: "conductor", machine: "idw-2" },
    { lane: "duet", name: "Claude Duet", role: "Claude Code on M1 Mac", machine: "idw-m1-mac" },
    { lane: "codex", name: "Codex", role: "idw-2 lane", machine: "idw-2" },
    { lane: "opencode", name: "OpenCode", role: "idw-2 lane", machine: "idw-2" },
    { lane: "grok", name: "Grok", role: "idw-2 lane", machine: "idw-2" },
    { lane: "hermes", name: "Hermes", role: "Mac-only lane", machine: "idw-m1-mac" },
    { lane: "meta", name: "Meta AI", role: "Live via meta.ai on M1 Mac", machine: "idw-m1-mac" },
  ];
  const MACHINES = [
    { id: "idw-2", label: "IDW-2" },
    { id: "idw-m1-mac", label: "M1 Mac" },
  ];
  const PRESENCE_FRESH_MS = 3 * 60 * 1000;
  const STUCK_MS = 15 * 60 * 1000;

  const AGENT_COLORS = {
    "Isaac": "#8cf23a", "Muse": "#b388ff", "Claude Duet": "#ff9e64",
    "Codex": "#f778ba", "OpenCode": "#2dd4bf", "Grok": "#d7dae0",
    "Hermes": "#ffd166", "Meta AI": "#4da3ff", "System": "#8a978c",
  };
  function colorFor(name) { return AGENT_COLORS[name] || "#8a978c"; }
  function initialsOf(name) {
    return (name || "?").split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
  }
  function makeAvatar(who) {
    const a = document.createElement("span");
    a.className = "avatar"; a.textContent = initialsOf(who);
    return a;
  }

  if (!window.supabase || !cfg.SUPABASE_URL) {
    document.body.textContent = "Missing supabase-js or config.js";
    return;
  }
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  const jobs = new Map();     // id -> row
  const presence = new Map(); // machine -> row
  const counts = { messages: null, jobs: null, presence: null };
  let channel = null;
  let lastUpdatedAt = null;
  let countsTimer = null;
  let railSelection = null; // { type: "lane", lane } | { type: "machine", id } — in-memory UI state only, never stored
  // Bot HQ lives on the Mac (server on localhost:8787 there). Its
  // Tailscale Serve endpoint was re-verified from idw-2 on 2026-11-28
  // (GET /api/health and GET / both HTTP 200), so the fleet rail links
  // to it, tailnet only. The rail copies nothing from Bot HQ.
  const BOTHQ_URL = "http://idw-m1-mac.tail2637a8.ts.net:8788";
  const BOTHQ_SERVE_OK = true;

  function setStatus(text) { $("status").textContent = text || ""; }

  // ---------- live freshness + toast ----------
  function touchUpdated() {
    lastUpdatedAt = new Date();
    renderLiveLabel();
  }
  function renderLiveLabel() {
    const el = $("last-updated");
    if (el) {
      el.textContent = lastUpdatedAt
        ? "updated " + lastUpdatedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
        : "";
    }
    const dot = $("live-dot");
    if (dot) dot.classList.toggle("on", !!channel);
  }
  let toastTimer = null;
  function showToast(text, isError) {
    const t = $("toast");
    if (!t) return;
    t.textContent = text;
    t.classList.toggle("error", !!isError);
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 6000); // UI only; never writes
  }

  // ---------- follow-up links (on-device only) ----------
  // The jobs table has no parent/link column (schema changes are out of
  // scope), so a follow-up dispatched from this page records its link
  // here, on this device only: new job id -> parent job id. The link
  // lives on the device that dispatched it until a schema field exists.
  const FOLLOWUPS_KEY = "ultra-followups-v1";
  function loadFollowups() {
    try { return JSON.parse(localStorage.getItem(FOLLOWUPS_KEY)) || {}; }
    catch { return {}; }
  }
  function recordFollowup(childId, parentId) {
    const m = loadFollowups();
    m[childId] = parentId;
    try { localStorage.setItem(FOLLOWUPS_KEY, JSON.stringify(m)); }
    catch { /* storage unavailable: the link simply is not kept */ }
  }
  // ---------- Skill proposals (Phase 5, on-device only) ----------
  // Capability Finder proposals live on this device only, under
  // 'ultra-skill-proposals-v1'. Dismissing a proposal is a local-only
  // change (no server write). The one server effect a proposal can
  // have is the Approve path further below, which queues exactly ONE
  // job through insertJob() after Isaac's confirm click.
  const PROPOSALS_KEY = "ultra-skill-proposals-v1";
  const NOT_CHECKED = "Not checked — review required";
  function loadProposals() {
    try {
      const v = JSON.parse(localStorage.getItem(PROPOSALS_KEY));
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  }
  function saveProposals(list) {
    try { localStorage.setItem(PROPOSALS_KEY, JSON.stringify(list)); }
    catch { /* storage unavailable: proposals simply are not kept */ }
  }
  function addProposal(prop) {
    const list = loadProposals();
    list.unshift(prop);
    saveProposals(list);
  }
  function dismissProposal(id) {
    saveProposals(loadProposals().filter((x) => x.id !== id));
    renderAll();
  }
  function setProposalState(id, state) {
    const list = loadProposals();
    const prop = list.find((x) => x.id === id);
    if (prop) { prop.state = state; saveProposals(list); }
  }
  function proposalMachine(prop) {
    // The failed job's machine when it is known, else idw-2.
    const job = prop.jobId ? jobs.get(prop.jobId) : null;
    if (!job) return "idw-2";
    const m = displayMachine(job);
    return (m === "idw-m1-mac" || m === "idw-2") ? m : "idw-2";
  }

  function parentOf(id) { return loadFollowups()[id] || null; }
  function childrenOf(id) {
    const m = loadFollowups();
    return Object.keys(m).filter((k) => m[k] === id);
  }

  // ---------- auth gate (same approach as the Chat Room) ----------
  function showApp(signedIn) {
    $("login").hidden = signedIn;
    $("app").hidden = !signedIn;
  }

  async function onSession(session) {
    showApp(!!session);
    if (!session) { closeRail(); teardown(); return; }
    await loadAll();
    subscribe();
    renderAll();
  }

  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    $("login-error").textContent = "";
    const { error } = await sb.auth.signInWithPassword({
      email: $("email").value.trim(),
      password: $("password").value,
    });
    if (error) $("login-error").textContent = error.message;
  });

  $("sign-out").addEventListener("click", () => sb.auth.signOut());
  $("refresh").addEventListener("click", async () => { await loadAll(); renderAll(); });

  let lastUser = null;
  sb.auth.onAuthStateChange((_event, session) => {
    const uid = session ? session.user.id : null;
    if (uid === lastUser) return; // ignore token refreshes
    lastUser = uid;
    onSession(session);
  });

  // ---------- data (reads only) ----------
  async function loadAll() {
    const [j, p, cm, cj, cp] = await Promise.all([
      sb.from("jobs").select("*").order("created_at", { ascending: false }).limit(200),
      sb.from("presence").select("*"),
      sb.from("messages").select("*", { count: "exact", head: true }),
      sb.from("jobs").select("*", { count: "exact", head: true }),
      sb.from("presence").select("*", { count: "exact", head: true }),
    ]);
    if (j.error) setStatus("Load jobs failed: " + j.error.message);
    if (p.error) setStatus("Load presence failed: " + p.error.message);
    jobs.clear(); presence.clear();
    (j.data || []).forEach((r) => jobs.set(r.id, r));
    (p.data || []).forEach((r) => presence.set(r.machine, r));
    counts.messages = cm.error ? null : cm.count;
    counts.jobs = cj.error ? null : cj.count;
    counts.presence = cp.error ? null : cp.count;
    touchUpdated();
  }

  async function refreshCounts() {
    const [cm, cj, cp] = await Promise.all([
      sb.from("messages").select("*", { count: "exact", head: true }),
      sb.from("jobs").select("*", { count: "exact", head: true }),
      sb.from("presence").select("*", { count: "exact", head: true }),
    ]);
    counts.messages = cm.error ? null : cm.count;
    counts.jobs = cj.error ? null : cj.count;
    counts.presence = cp.error ? null : cp.count;
  }

  function subscribe() {
    teardown();
    channel = sb.channel("ultra")
      .on("postgres_changes", { event: "*", schema: "public", table: "jobs" }, (payload) => {
        if (payload.eventType === "DELETE") jobs.delete(payload.old.id);
        else jobs.set(payload.new.id, payload.new);
        touchUpdated();
        renderAll();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "presence" }, (payload) => {
        if (payload.eventType === "DELETE") presence.delete(payload.old.machine);
        else presence.set(payload.new.machine, payload.new);
        touchUpdated();
        renderAll();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, () => {
        // Messages feed only the adapter counts; refresh them (debounced, reads only).
        touchUpdated();
        if (countsTimer) clearTimeout(countsTimer);
        countsTimer = setTimeout(async () => { await refreshCounts(); renderAdapters(); }, 800);
      })
      .subscribe();
  }

  function teardown() {
    if (channel) { sb.removeChannel(channel); channel = null; }
  }

  // ---------- helpers ----------
  function fmtTime(iso) {
    return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  }
  function fmtDateTime(iso) {
    return iso ? new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  }
  function sortedJobs() {
    return [...jobs.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  function isOnline(machine) {
    const p = presence.get(machine);
    return !!p && p.online && p.checked_at && Date.now() - new Date(p.checked_at).getTime() < PRESENCE_FRESH_MS;
  }
  function snippet(text, n) {
    const t = (text || "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  }
  function agentName(job) { return job.agent || job.lane || "System"; }

  // ---------- Needs Isaac (read-only roll-up from jobs) ----------
  function needsItems() {
    const now = Date.now();
    const items = [];
    for (const job of sortedJobs()) {
      if (job.status === "failed") {
        items.push({ job, kind: "failed", text: job.error || "Failed with no error text recorded." });
      } else if (job.status === "running") {
        const since = job.claimed_at || job.created_at;
        if (since && now - new Date(since).getTime() > STUCK_MS) {
          const mins = Math.floor((now - new Date(since).getTime()) / 60000);
          items.push({ job, kind: "stuck", text: "Running for " + mins + " min (claimed " + fmtDateTime(since) + ")." });
        }
      }
    }
    return items;
  }

  function buildJobCard(job, onOpen) {
    const el = document.createElement("article");
    el.className = "job-card";
    el.style.setProperty("--agent", colorFor(agentName(job)));
    const head = document.createElement("div");
    head.className = "msg-head";
    const add = (cls, text) => {
      if (!text) return;
      const s = document.createElement("span");
      s.className = cls; s.textContent = text; head.append(s);
    };
    head.append(makeAvatar(agentName(job)));
    add("sender", agentName(job));
    add("badge job-" + job.status, job.status);
    add("machine", job.target_machine && "@ " + job.target_machine);
    add("time", fmtTime(job.created_at));
    el.append(head);
    if (job.prompt) {
      const p = document.createElement("div");
      p.className = "job-prompt";
      p.textContent = snippet(job.prompt, 140);
      el.append(p);
    }
    const meta = document.createElement("div");
    meta.className = "card-meta";
    meta.textContent = [job.kind, job.lane && "lane: " + job.lane, fmtDateTime(job.created_at)].filter(Boolean).join(" · ");
    el.append(meta);
    if (onOpen) {
      el.classList.add("clickable");
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      el.addEventListener("click", () => onOpen(job));
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onOpen(job); } });
    }
    return el;
  }

  function renderNeeds() {
    const items = needsItems();
    $("needs-count").textContent = String(items.length);
    $("needs-count").classList.toggle("has-items", items.length > 0);
    $("needs-clear").hidden = items.length > 0;
    $("needs-list").replaceChildren(...items.map((it) => {
      const card = buildJobCard(it.job, openDetail);
      const b = document.createElement("div");
      b.className = "msg-body " + (it.kind === "failed" ? "err-text" : "dim");
      b.textContent = it.kind === "failed" ? snippet(it.text, 300) : it.text;
      card.append(b);
      card.append(buildNeedsActions(it));
      const tag = document.createElement("span");
      tag.className = "badge " + (it.kind === "failed" ? "job-failed" : "job-running");
      tag.textContent = it.kind === "failed" ? "failed" : "stuck";
      card.querySelector(".msg-head").append(tag);
      return card;
    }));
  }

  // ---------- Writes: insertJob() + cancelJob() (Phases 2-3) ----------
  // The ONLY Supabase writes in this file live in insertJob() and
  // cancelJob() below. They run exclusively from the confirm dialog's
  // confirm button, reachable only from Isaac's click on a Needs Isaac
  // action button or on the dispatch form's submit button.
  function displayMachine(job) {
    if (job.target_machine) return job.target_machine;
    if (job.route_mode === "mac") return "idw-m1-mac";
    if (job.route_mode === "idw-2") return "idw-2";
    const p = PARTICIPANTS.find((x) => x.lane === job.lane);
    return p ? p.machine : "router decides";
  }

  function routeModeFor(job) {
    // The bridge sets target_machine itself after routing, so a job's
    // machine is carried via route_mode: an explicit target wins,
    // otherwise the job's own route_mode is kept.
    return job.target_machine === "idw-m1-mac" ? "mac"
      : job.target_machine === "idw-2" ? "idw-2"
      : (job.route_mode || "auto");
  }

  // The single shared jobs INSERT for Retry / Re-run AND Dispatch.
  // Field shape matches app.js queueJob()'s jobs insert. One deliberate
  // difference, forced by the jobs-only allowlist: placeholder_message_id
  // is omitted — the bridge treats a missing placeholder as "insert a
  // fresh result message" (listener.mjs writeMessage fall-through).
  async function insertJob(row) {
    const { error } = await sb.from("jobs").insert(row);
    if (error) throw error;
    return row.id;
  }

  async function retryJob(job) {
    const p = PARTICIPANTS.find((x) => x.lane === job.lane);
    const row = {
      id: crypto.randomUUID(),
      kind: job.kind || "dispatch",
      lane: job.lane,
      agent: job.agent || (p ? p.name : job.lane),
      prompt: job.prompt,
      classification: job.classification || "auto",
      route_mode: routeModeFor(job),
    };
    await insertJob(row);
  }

  async function cancelJob(job) {
    const { error } = await sb.from("jobs").update({ status: "cancelled" }).eq("id", job.id);
    if (error) throw error;
  }

  let pendingConfirm = null; // { run, doneText } — set only by an action-button click
  function openConfirm(opts) {
    pendingConfirm = opts;
    $("c-title").textContent = opts.title;
    $("c-body").textContent = opts.body;
    $("c-error").textContent = "";
    const ok = $("c-ok");
    ok.textContent = opts.confirmLabel;
    ok.disabled = false;
    ok.classList.toggle("danger", !!opts.danger);
    const d = $("confirm");
    if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
  }
  function closeConfirm() {
    pendingConfirm = null;
    const d = $("confirm");
    if (typeof d.close === "function") d.close(); else d.removeAttribute("open");
  }

  function confirmRetry(job, isStuck) {
    const who = agentName(job) + " @ " + displayMachine(job);
    openConfirm({
      title: isStuck ? "Re-run stuck job" : "Retry failed job",
      body: "Queue a new job with the same prompt and lane?\n" + who +
        "\n\nPrompt: " + snippet(job.prompt, 240),
      confirmLabel: isStuck ? "Re-run" : "Retry",
      run: () => retryJob(job),
      doneText: "Retry queued for " + who,
    });
  }
  function confirmCancel(job, isStuck) {
    openConfirm({
      title: isStuck ? "Mark job cancelled" : "Dismiss failed job",
      body: isStuck
        ? "Mark this running job as cancelled? This only updates the board. A lane already running may still finish and post its result."
        : "Dismiss this failed job? It will be marked cancelled and leave Needs Isaac. Nothing else about the job changes.",
      confirmLabel: isStuck ? "Mark cancelled" : "Dismiss",
      danger: true,
      run: () => cancelJob(job),
      doneText: (isStuck ? "Marked cancelled: " : "Dismissed: ") + agentName(job) + " @ " + displayMachine(job),
    });
  }

  function buildNeedsActions(it) {
    const row = document.createElement("div");
    row.className = "needs-actions";
    const mk = (label, danger, handler) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "action-btn" + (danger ? " danger" : "");
      btn.textContent = label;
      btn.addEventListener("click", (e) => { e.stopPropagation(); handler(); });
      return btn;
    };
    const job = it.job;
    if (it.kind === "failed") {
      row.append(
        mk("Retry", false, () => confirmRetry(job, false)),
        mk("Dismiss", true, () => confirmCancel(job, false)),
        mk("Find a skill", false, () => openFinder(job)),
      );
    } else {
      row.append(
        mk("Re-run", false, () => confirmRetry(job, true)),
        mk("Mark cancelled", true, () => confirmCancel(job, true)),
      );
    }
    return row;
  }

  // ---------- Board ----------
  const COLUMNS = [
    { key: "queued", label: "Queued", statuses: ["pending"] },
    { key: "running", label: "Running", statuses: ["running"] },
    { key: "done", label: "Done", statuses: ["done"] },
    { key: "failed", label: "Failed", statuses: ["failed", "cancelled"] },
  ];

  function renderBoard() {
    const all = sortedJobs();
    $("board-total").textContent = all.length ? all.length + " job(s) shown" : "";
    $("board-columns").replaceChildren(...COLUMNS.map((col) => {
      const wrap = document.createElement("div");
      wrap.className = "board-col";
      const head = document.createElement("div");
      head.className = "board-col-head";
      const title = document.createElement("span");
      title.className = "board-col-title";
      title.textContent = col.label;
      const rows = all.filter((j) => col.statuses.includes(j.status));
      const count = document.createElement("span");
      count.className = "board-col-count";
      count.textContent = String(rows.length);
      head.append(title, count);
      wrap.append(head);
      const list = document.createElement("div");
      list.className = "job-list";
      if (!rows.length) {
        const empty = document.createElement("p");
        empty.className = "col-empty";
        empty.textContent = "None";
        list.append(empty);
      } else {
        rows.forEach((j) => list.append(buildJobCard(j, openDetail)));
      }
      wrap.append(list);
      return wrap;
    }));
  }

  // ---------- Fleet ----------
  function renderFleet() {
    $("fleet-machines").replaceChildren(...MACHINES.map((m) => {
      const li = document.createElement("li");
      li.className = "row-item";
      const dot = document.createElement("span");
      dot.className = "dot " + (isOnline(m.id) ? "on" : "off");
      const label = document.createElement("span");
      label.className = "row-main";
      const pr = presence.get(m.id);
      const name = document.createElement("span");
      name.className = "row-name"; name.textContent = m.label;
      const sub = document.createElement("small");
      sub.textContent = pr && pr.checked_at
        ? (isOnline(m.id) ? "online" : "offline") + " · heartbeat " + fmtDateTime(pr.checked_at) + (pr.detail ? " · " + pr.detail : "")
        : "no heartbeat data yet";
      label.append(name, sub);
      activatable(li, { type: "machine", id: m.id });
      li.append(dot, label);
      return li;
    }));
    const all = sortedJobs();
    $("fleet-lanes").replaceChildren(...PARTICIPANTS.map((p) => {
      const li = document.createElement("li");
      li.className = "row-item";
      li.style.setProperty("--agent", colorFor(p.name));
      const dot = document.createElement("span");
      dot.className = "dot " + (isOnline(p.machine) ? "on" : "off");
      const label = document.createElement("span");
      label.className = "row-main";
      const name = document.createElement("span");
      name.className = "row-name"; name.textContent = p.name; name.style.color = colorFor(p.name);
      const last = all.find((j) => j.lane === p.lane);
      const sub = document.createElement("small");
      sub.textContent = last
        ? "last job: " + last.status + " · " + fmtDateTime(last.created_at) + " · @ " + p.machine
        : "no jobs yet · @ " + p.machine;
      label.append(name, sub);
      activatable(li, { type: "lane", lane: p.lane });
      li.append(dot, label);
      return li;
    }));
  }

  // ---------- Fleet rail (Phase 4) ----------
  // Selecting a fleet machine or lane opens this contextual rail. It
  // renders only from the in-memory jobs/presence data the page already
  // loaded: no new reads, and NO new writes — its one action reuses the
  // Phase 3 dispatch form and its confirm flow. Rail selection is
  // in-memory UI state only; it is never written to localStorage.
  function activatable(li, sel) {
    li.classList.add("clickable");
    const selNow = railSelection;
    const isSel = !!selNow && selNow.type === sel.type &&
      (sel.type === "lane" ? selNow.lane === sel.lane : selNow.id === sel.id);
    li.classList.toggle("selected", isSel);
    li.setAttribute("role", "button");
    li.setAttribute("tabindex", "0");
    li.addEventListener("click", () => openRail(sel));
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openRail(sel); }
    });
  }
  function openRail(sel) { railSelection = sel; renderRail(); renderFleet(); }
  function closeRail() {
    railSelection = null;
    const r = $("rail");
    if (r) r.hidden = true;
  }
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (document.querySelector("dialog[open]")) return; // dialogs handle their own Esc
    if (railSelection) { closeRail(); renderFleet(); }
  });
  $("rail-close").addEventListener("click", () => { closeRail(); renderFleet(); });

  function jobsForLane(lane) { return sortedJobs().filter((j) => j.lane === lane); }
  function jobsForMachine(id) { return sortedJobs().filter((j) => displayMachine(j) === id); }
  function statusCounts(list) {
    const m = new Map();
    list.forEach((j) => m.set(j.status, (m.get(j.status) || 0) + 1));
    return m;
  }

  function railPresenceBlock(machineId) {
    const wrap = document.createElement("div");
    wrap.className = "rail-presence";
    const dot = document.createElement("span");
    dot.className = "dot " + (isOnline(machineId) ? "on" : "off");
    const txt = document.createElement("div");
    const pr = presence.get(machineId);
    const line = document.createElement("div");
    line.textContent = pr && pr.checked_at
      ? (isOnline(machineId) ? "Online" : "Offline") + " · heartbeat " + fmtDateTime(pr.checked_at)
      : "No heartbeat data yet";
    txt.append(line);
    if (pr && pr.detail) {
      const d = document.createElement("small");
      d.textContent = pr.detail;
      txt.append(d);
    }
    wrap.append(dot, txt);
    return wrap;
  }

  function railCountsBlock(list) {
    const wrap = document.createElement("div");
    const h = document.createElement("h3");
    h.className = "sub-title"; h.textContent = "Jobs by status";
    wrap.append(h);
    const countsEl = document.createElement("div");
    countsEl.className = "rail-counts";
    const m = statusCounts(list);
    if (!m.size) {
      const b = document.createElement("span");
      b.className = "badge"; b.textContent = "no jobs yet";
      countsEl.append(b);
    } else {
      [...m.entries()].forEach(([st, n]) => {
        const b = document.createElement("span");
        b.className = "badge job-" + st;
        b.textContent = st + ": " + n;
        countsEl.append(b);
      });
    }
    wrap.append(countsEl);
    return wrap;
  }

  function railRecentBlock(list) {
    const wrap = document.createElement("div");
    const h = document.createElement("h3");
    h.className = "sub-title"; h.textContent = "Recent jobs";
    wrap.append(h);
    const recent = list.slice(0, 5);
    if (!recent.length) {
      const p = document.createElement("p");
      p.className = "col-empty"; p.textContent = "No jobs yet.";
      wrap.append(p);
    } else {
      const jl = document.createElement("div");
      jl.className = "job-list";
      recent.forEach((j) => jl.append(buildJobCard(j, openDetail)));
      wrap.append(jl);
    }
    return wrap;
  }

  function railBotHqBlock() {
    const wrap = document.createElement("div");
    wrap.className = "rail-bothq";
    const h = document.createElement("h3");
    h.className = "sub-title"; h.textContent = "Bot HQ";
    wrap.append(h);
    if (BOTHQ_SERVE_OK) {
      const a = document.createElement("a");
      a.className = "glass-btn";
      a.href = BOTHQ_URL;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = "Open Bot HQ";
      wrap.append(a);
      const cap = document.createElement("small");
      cap.textContent = "Bot HQ on your Mac — tailnet only";
      wrap.append(cap);
    } else {
      const p = document.createElement("p");
      p.textContent = "Bot HQ runs on your Mac at localhost:8787 (on the Mac itself). Its tailnet link did not answer in the latest check.";
      wrap.append(p);
    }
    const s = document.createElement("p");
    s.textContent = "Bot settings live in Bot HQ (local data on the Mac) and stay there; this rail links to them, it does not copy them.";
    wrap.append(s);
    const v = document.createElement("p");
    v.textContent = "Computer viewer lives in Bot HQ. Its cloud screens are off until real Orgo keys are added in Bot HQ, so there is no viewer to embed yet.";
    wrap.append(v);
    return wrap;
  }

  function renderRail() {
    const rail = $("rail");
    if (!rail) return;
    if (!railSelection || $("app").hidden) { rail.hidden = true; return; }
    const identity = $("rail-identity");
    const body = $("rail-body");
    identity.replaceChildren();
    body.replaceChildren();
    if (railSelection.type === "lane") {
      const p = PARTICIPANTS.find((x) => x.lane === railSelection.lane);
      if (!p) { rail.hidden = true; return; }
      identity.style.setProperty("--agent", colorFor(p.name));
      identity.append(makeAvatar(p.name));
      const tw = document.createElement("div");
      const nm = document.createElement("div");
      nm.className = "rail-name"; nm.textContent = p.name; nm.style.color = colorFor(p.name);
      const sub = document.createElement("div");
      sub.className = "rail-sub";
      const mLabel = (MACHINES.find((m) => m.id === p.machine) || {}).label || p.machine;
      sub.textContent = p.role + " · @ " + mLabel;
      tw.append(nm, sub);
      identity.append(tw);
      const list = jobsForLane(p.lane);
      body.append(railPresenceBlock(p.machine));
      body.append(railCountsBlock(list));
      body.append(railRecentBlock(list));
      const act = document.createElement("button");
      act.type = "button";
      act.className = "action-btn rail-dispatch";
      act.textContent = "Dispatch to " + p.name;
      act.addEventListener("click", () => openDispatch({
        lane: p.lane,
        route: p.machine === "idw-m1-mac" ? "mac" : "idw-2",
      }));
      body.append(act);
      body.append(railBotHqBlock());
    } else {
      const m = MACHINES.find((x) => x.id === railSelection.id);
      if (!m) { rail.hidden = true; return; }
      identity.style.setProperty("--agent", "#8a978c");
      const av = document.createElement("span");
      av.className = "avatar";
      av.textContent = m.id === "idw-m1-mac" ? "M1" : "I2";
      identity.append(av);
      const tw = document.createElement("div");
      const nm = document.createElement("div");
      nm.className = "rail-name"; nm.textContent = m.label;
      const sub = document.createElement("div");
      sub.className = "rail-sub"; sub.textContent = m.id;
      tw.append(nm, sub);
      identity.append(tw);
      const list = jobsForMachine(m.id);
      body.append(railPresenceBlock(m.id));
      const lanesWrap = document.createElement("div");
      const h = document.createElement("h3");
      h.className = "sub-title"; h.textContent = "Lanes on this machine";
      lanesWrap.append(h);
      const ul = document.createElement("div");
      ul.className = "row-list";
      PARTICIPANTS.filter((x) => x.machine === m.id).forEach((x) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "row-item clickable rail-lane-btn";
        b.style.setProperty("--agent", colorFor(x.name));
        const dot = document.createElement("span");
        dot.className = "dot " + (isOnline(x.machine) ? "on" : "off");
        const lab = document.createElement("span");
        lab.className = "row-main";
        const nm2 = document.createElement("span");
        nm2.className = "row-name"; nm2.textContent = x.name; nm2.style.color = colorFor(x.name);
        const sm = document.createElement("small");
        sm.textContent = x.role;
        lab.append(nm2, sm);
        b.append(dot, lab);
        b.addEventListener("click", () => openRail({ type: "lane", lane: x.lane }));
        ul.append(b);
      });
      lanesWrap.append(ul);
      body.append(lanesWrap);
      body.append(railCountsBlock(list));
      body.append(railRecentBlock(list));
      body.append(railBotHqBlock());
    }
    rail.hidden = false;
  }

  // ---------- Adapters ----------
  function renderAdapters() {
    const badge = $("adapter-room-badge");
    if (counts.jobs === null && counts.messages === null) {
      badge.textContent = "Read failed";
      badge.className = "badge job-failed";
      $("adapter-room").textContent = "The Supabase read did not return counts. Check the status line above for the error.";
    } else {
      badge.textContent = "Live";
      badge.className = "badge job-done";
      const parts = [];
      if (counts.messages !== null) parts.push(counts.messages + " messages");
      if (counts.jobs !== null) parts.push(counts.jobs + " jobs");
      if (counts.presence !== null) parts.push(counts.presence + " presence rows");
      $("adapter-room").textContent = "Live — read from Supabase for this account: " + parts.join(" · ") + ".";
    }
    const mac = presence.get("idw-m1-mac");
    $("adapter-bothq").textContent = mac
      ? "Only signal available here: the Mac presence heartbeat — " + (isOnline("idw-m1-mac") ? "online" : "offline") + (mac.checked_at ? ", last heartbeat " + fmtDateTime(mac.checked_at) : "") + "."
      : "Only signal available here: the Mac presence heartbeat — no heartbeat row was read.";
  }

  // ---------- Detail ----------
  let detailJob = null;
  function renderDetailLinks(job) {
    const lines = [];
    const pid = parentOf(job.id);
    if (pid) {
      const pj = jobs.get(pid);
      lines.push("Follow-up to: " + (pj
        ? agentName(pj) + " · " + snippet(pj.prompt, 120)
        : "a job that is not in the current board load"));
    }
    const kids = childrenOf(job.id);
    if (kids.length) {
      lines.push("Follow-ups: " + kids.length);
      kids.forEach((cid) => {
        const cj = jobs.get(cid);
        lines.push("· " + (cj
          ? agentName(cj) + " · " + snippet(cj.prompt, 120)
          : "a job that is not in the current board load"));
      });
    }
    $("d-links-wrap").hidden = lines.length === 0;
    $("d-links").textContent = lines.join("\n");
  }

  function openDetail(job) {
    detailJob = job;
    $("d-title").textContent = agentName(job) + " · " + job.status;
    const rows = [
      ["Agent", job.agent], ["Lane", job.lane], ["Status", job.status],
      ["Kind", job.kind], ["Target machine", job.target_machine],
      ["Classification", job.classification], ["Route mode", job.route_mode],
      ["Route note", job.route_note], ["Claimed by", job.claimed_by],
      ["Created", fmtDateTime(job.created_at)], ["Claimed", fmtDateTime(job.claimed_at)],
      ["Finished", fmtDateTime(job.finished_at)],
    ];
    $("d-meta").replaceChildren(...rows.filter((r) => r[1]).map((r) => {
      const wrap = document.createElement("div");
      const dt = document.createElement("dt"); dt.textContent = r[0];
      const dd = document.createElement("dd"); dd.textContent = r[1];
      wrap.append(dt, dd);
      return wrap;
    }));
    $("d-prompt").textContent = job.prompt || "(no prompt recorded)";
    $("d-result").textContent = job.result || "(no result yet)";
    $("d-error").textContent = job.error || "(no error)";
    $("d-finder-btn").hidden = job.status !== "failed";
    renderDetailLinks(job);
    const d = $("detail");
    if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
  }
  $("d-close").addEventListener("click", () => {
    const d = $("detail");
    if (typeof d.close === "function") d.close(); else d.removeAttribute("open");
  });
  $("d-followup-btn").addEventListener("click", () => {
    if (!detailJob) return;
    openDispatch({ lane: detailJob.lane, route: routeModeFor(detailJob), parent: detailJob });
  });

  $("c-cancel").addEventListener("click", () => closeConfirm());
  $("c-ok").addEventListener("click", async () => {
    if (!pendingConfirm) return;
    const action = pendingConfirm;
    const ok = $("c-ok");
    ok.disabled = true;
    ok.textContent = "Working...";
    $("c-error").textContent = "";
    try {
      await action.run();
      const doneText = action.doneText;
      closeConfirm();
      showToast(doneText);
      await loadAll();
      renderAll();
    } catch (err) {
      // Show the real error in place; never swallow it silently.
      $("c-error").textContent = "Action failed: " + (err && err.message ? err.message : String(err));
      ok.disabled = false;
      ok.textContent = action.confirmLabel;
    }
  });

  // ---------- Dispatch (Phase 3): global + follow-up ----------
  // This form mirrors the Chat Room's #dispatch form in app.js: the lane
  // select offers every live PARTICIPANTS lane; classification is the
  // form's Complexity value sent verbatim ("auto" / "light" / "complex"
  // — app.js does NOT derive classification from the prompt; the bridge
  // resolves "auto" when it claims the job); route_mode is one of
  // "auto" / "mac" / "idw-2"; kind is "dispatch", exactly as app.js.
  let dispatchParent = null; // parent job row for a follow-up, else null

  function routeLabel(mode) {
    return mode === "mac" ? "M1 Mac" : mode === "idw-2" ? "IDW-2" : "Auto";
  }
  function fillDispatchLanes() {
    $("x-lane").replaceChildren(
      ...PARTICIPANTS.filter((p) => p.lane).map((p) => new Option(p.name, p.lane)),
    );
  }
  function renderAgentChip() {
    const p = PARTICIPANTS.find((x) => x.lane === $("x-lane").value);
    const chip = $("x-agent-chip");
    chip.replaceChildren();
    if (!p) return;
    chip.style.setProperty("--agent", colorFor(p.name));
    chip.append(makeAvatar(p.name));
    const n = document.createElement("span");
    n.className = "x-agent-name";
    n.textContent = p.name;
    n.style.color = colorFor(p.name);
    chip.append(n);
  }
  function openDispatch(preset) {
    dispatchParent = preset && preset.parent ? preset.parent : null;
    if (preset && preset.lane) $("x-lane").value = preset.lane;
    if (preset && preset.route) $("x-route").value = preset.route;
    $("x-prompt").value = ""; // always empty: never prefilled, not even for a follow-up
    $("x-error").textContent = "";
    $("x-title").textContent = dispatchParent ? "Dispatch follow-up" : "New dispatch";
    const note = $("x-parent-note");
    if (dispatchParent) {
      note.hidden = false;
      note.textContent = "Follow-up to: " + agentName(dispatchParent) + " · " + snippet(dispatchParent.prompt, 160);
    } else {
      note.hidden = true;
      note.textContent = "";
    }
    renderAgentChip();
    const d = $("dispatch");
    if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
  }
  function closeDispatch() {
    const d = $("dispatch");
    if (typeof d.close === "function") d.close(); else d.removeAttribute("open");
  }

  fillDispatchLanes();
  $("new-dispatch").addEventListener("click", () => openDispatch(null));
  $("x-lane").addEventListener("change", renderAgentChip);
  $("x-cancel").addEventListener("click", () => { dispatchParent = null; closeDispatch(); });
  $("x-submit").addEventListener("click", () => {
    const prompt = $("x-prompt").value.trim();
    if (!prompt) { $("x-error").textContent = "A prompt is required to queue a job."; return; }
    const lane = $("x-lane").value;
    const p = PARTICIPANTS.find((x) => x.lane === lane);
    if (!p) { $("x-error").textContent = "Pick a lane first."; return; }
    const parent = dispatchParent;
    const row = {
      id: crypto.randomUUID(),
      kind: "dispatch",
      lane,
      agent: p.name,
      prompt,
      classification: $("x-complexity").value || "auto",
      route_mode: $("x-route").value || "auto",
    };
    dispatchParent = null;
    closeDispatch();
    openConfirm({
      title: parent ? "Dispatch follow-up" : "New dispatch",
      body: "Queue this job?\n" + p.name + " @ " + routeLabel(row.route_mode) +
        " · complexity " + row.classification +
        (parent ? "\nFollow-up to: " + agentName(parent) + " · " + snippet(parent.prompt, 120) : "") +
        "\n\nPrompt: " + snippet(prompt, 240),
      confirmLabel: "Queue job",
      run: async () => {
        await insertJob(row);
        if (parent) recordFollowup(row.id, parent.id);
      },
      doneText: "Job queued for " + p.name + " @ " + routeLabel(row.route_mode),
    });
  });

  // ---------- Skill proposals in Needs Isaac (Phase 5) ----------
  function renderProposals() {
    const wrap = $("needs-proposals-wrap");
    if (!wrap) return;
    const list = loadProposals();
    wrap.hidden = list.length === 0;
    $("needs-proposals").replaceChildren(...list.map((prop) => {
      const card = document.createElement("article");
      card.className = "job-card proposal-card";
      const head = document.createElement("div");
      head.className = "msg-head";
      const nm = document.createElement("span");
      nm.className = "sender";
      nm.textContent = prop.name;
      const tag = document.createElement("span");
      tag.className = "badge " + (prop.state === "install-queued" ? "job-done" : "badge-pending");
      tag.textContent = prop.state === "install-queued" ? "Install queued" : "Proposal";
      head.append(nm, tag);
      card.append(head);
      const src = document.createElement("div");
      src.className = "card-meta";
      src.textContent = prop.sourceId;
      card.append(src);
      if (prop.description) {
        const d = document.createElement("div");
        d.className = "msg-body";
        d.textContent = prop.description;
        card.append(d);
      }
      if (prop.installs !== null && prop.installs !== undefined) {
        const ins = document.createElement("div");
        ins.className = "card-meta";
        ins.textContent = prop.installs + " installs";
        card.append(ins);
      }
      const sec = document.createElement("div");
      sec.className = "msg-body dim";
      sec.textContent = "Security status: " + prop.securityStatus;
      card.append(sec);
      if (prop.taskText) {
        const t = document.createElement("div");
        t.className = "card-meta";
        t.textContent = "For: " + snippet(prop.taskText, 140);
        card.append(t);
      }
      const link = document.createElement("a");
      link.className = "proposal-link";
      link.href = prop.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "View on skills.sh";
      card.append(link);
      const row = document.createElement("div");
      row.className = "needs-actions";
      if (prop.state !== "install-queued") {
        const ap = document.createElement("button");
        ap.type = "button";
        ap.className = "action-btn";
        ap.textContent = "Approve install";
        ap.addEventListener("click", (e) => { e.stopPropagation(); confirmApproveProposal(prop); });
        row.append(ap);
      }
      const dis = document.createElement("button");
      dis.type = "button";
      dis.className = "action-btn danger";
      dis.textContent = "Dismiss";
      dis.addEventListener("click", (e) => { e.stopPropagation(); dismissProposal(prop.id); });
      row.append(dis);
      card.append(row);
      return card;
    }));
  }

  function confirmApproveProposal(prop) {
    const machine = proposalMachine(prop);
    const prompt = "Install request approved by Isaac from the Ultra Capability Finder. Skill: [" + prop.sourceId + "] — [" + prop.url + "]. Target machine: [" + machine + "]. Steps: (1) Inspect the skill's files and any published security audit first. (2) If anything looks unsafe, unclear, or not genuinely relevant to the task below, STOP and report instead of installing. (3) Only if it checks out, install it for the agent setup on this machine using the standard skills tooling, then verify it is recognized/listed and report what was installed and where. Task this skill is for: [" + prop.taskText + "]";
    openConfirm({
      title: "Approve skill install",
      body: "Queue an install job for this skill?\n" + prop.name +
        "\nSource: " + prop.sourceId +
        "\n" + prop.url +
        "\nSecurity status: " + prop.securityStatus +
        "\nTarget machine: " + machine +
        "\n\nThe job tells the lane to inspect the skill first and stop if anything looks unsafe.",
      confirmLabel: "Queue install job",
      run: async () => {
        await insertJob({
          id: crypto.randomUUID(),
          kind: "dispatch",
          lane: "muse",
          agent: "Muse",
          prompt,
          classification: "auto",
          route_mode: machine === "idw-m1-mac" ? "mac" : "idw-2",
        });
        setProposalState(prop.id, "install-queued");
      },
      doneText: "Install job queued for " + prop.name + " @ " + machine,
    });
  }

  // ---------- Capability Finder (Phase 5, fallback branch) ----------
  // skills.sh data is UNTRUSTED: candidate text is rendered only via
  // text nodes, and nothing from a listing is ever run, fetched, or
  // followed from this page. The search itself happens on skills.sh
  // (external link, new tab, opened only by Isaac's click); a pasted
  // candidate's fields are derived from the identifier alone, and its
  // security status is always NOT_CHECKED — the source provides no
  // audit verdict in this flow, so none is claimed.
  let finderJob = null;

  function finderSearchUrl() {
    return "https://www.skills.sh/search?q=" + encodeURIComponent($("f-task").value.trim());
  }
  function openFinder(job) {
    finderJob = job;
    $("f-context").textContent = "For the failed job: " + agentName(job) + " · " + snippet(job.prompt, 160);
    $("f-task").value = job.prompt || "";
    $("f-paste").value = "";
    $("f-error").textContent = "";
    $("f-candidates").replaceChildren();
    $("f-search-link").href = finderSearchUrl();
    const d = $("finder");
    if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
  }
  function closeFinder() {
    const d = $("finder");
    if (typeof d.close === "function") d.close(); else d.removeAttribute("open");
  }

  function parseCandidate(raw) {
    const text = (raw || "").trim();
    if (!text) return null;
    let owner = null, repo = null, skill = null;
    if (/^https?:\/\//i.test(text)) {
      let u;
      try { u = new URL(text); } catch { return null; }
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length < 3) return null;
      [owner, repo, skill] = parts.slice(0, 3);
    } else {
      const at = text.lastIndexOf("@");
      if (at < 1) return null;
      const left = text.slice(0, at).split("/").filter(Boolean);
      skill = text.slice(at + 1).trim();
      if (left.length !== 2 || !skill) return null;
      [owner, repo] = left;
    }
    if (!owner || !repo || !skill) return null;
    return {
      name: skill,
      sourceId: owner + "/" + repo + "@" + skill,
      url: "https://www.skills.sh/" + owner + "/" + repo + "/" + skill,
      description: null,
      installs: null,
      securityStatus: NOT_CHECKED,
    };
  }

  function renderCandidate(cand) {
    const card = document.createElement("article");
    card.className = "job-card candidate-card";
    const head = document.createElement("div");
    head.className = "msg-head";
    const nm = document.createElement("span");
    nm.className = "sender";
    nm.textContent = cand.name;
    head.append(nm);
    card.append(head);
    const src = document.createElement("div");
    src.className = "card-meta";
    src.textContent = cand.sourceId;
    card.append(src);
    const sec = document.createElement("div");
    sec.className = "msg-body dim";
    sec.textContent = "Security status: " + cand.securityStatus;
    card.append(sec);
    const link = document.createElement("a");
    link.className = "proposal-link";
    link.href = cand.url;
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = "View on skills.sh";
    card.append(link);
    const row = document.createElement("div");
    row.className = "needs-actions";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "action-btn";
    btn.textContent = "Propose";
    btn.addEventListener("click", () => {
      addProposal({
        id: crypto.randomUUID(),
        name: cand.name,
        sourceId: cand.sourceId,
        url: cand.url,
        description: cand.description,
        installs: cand.installs,
        securityStatus: cand.securityStatus,
        taskText: $("f-task").value.trim(),
        jobId: finderJob ? finderJob.id : null,
        createdAt: new Date().toISOString(),
        state: "proposed",
      });
      btn.disabled = true;
      btn.textContent = "Proposed";
      showToast("Proposed: " + cand.name);
      renderAll();
    });
    row.append(btn);
    card.append(row);
    return card;
  }

  $("f-task").addEventListener("input", () => { $("f-search-link").href = finderSearchUrl(); });
  $("f-close").addEventListener("click", () => { finderJob = null; closeFinder(); });
  $("f-add").addEventListener("click", () => {
    const cand = parseCandidate($("f-paste").value);
    if (!cand) {
      $("f-error").textContent = "Could not read that as a skills.sh URL or an owner/repo@skill identifier.";
      return;
    }
    $("f-error").textContent = "";
    $("f-paste").value = "";
    $("f-candidates").append(renderCandidate(cand));
  });
  $("d-finder-btn").addEventListener("click", () => {
    if (!detailJob || detailJob.status !== "failed") return;
    const job = detailJob;
    const d = $("detail");
    if (typeof d.close === "function") d.close(); else d.removeAttribute("open");
    openFinder(job);
  });

  function renderAll() {
    if ($("app").hidden) return;
    renderLiveLabel();
    renderNeeds();
    renderProposals();
    renderBoard();
    renderFleet();
    renderRail();
    renderAdapters();
  }

  setInterval(renderAll, 30000); // stuck-job ages and presence freshness decay without events
})();
