// Ultra Dashboard Phase 2 frontend. No build step.
// Reads: Supabase selects + realtime subscriptions + auth.
// WRITE ALLOWLIST (Phase 2, Isaac-click + confirm only, nothing else):
//   (a) jobs INSERT in retryJob() — Retry / Re-run, dispatch field shape.
//   (b) jobs UPDATE of status to 'cancelled' in cancelJob() — one job id.
// No other inserts/updates/deletes/upserts/RPC anywhere in this file,
// and it writes nothing to Bot HQ or Muse Dash.
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

  // ---------- auth gate (same approach as the Chat Room) ----------
  function showApp(signedIn) {
    $("login").hidden = signedIn;
    $("app").hidden = !signedIn;
  }

  async function onSession(session) {
    showApp(!!session);
    if (!session) { teardown(); return; }
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

  // ---------- Needs Isaac actions (Phase 2) ----------
  // The ONLY writes in this file live in retryJob() and cancelJob() below.
  // They run exclusively from the confirm dialog's confirm button, which is
  // only reachable from Isaac's click on a Needs Isaac action button.
  function displayMachine(job) {
    if (job.target_machine) return job.target_machine;
    if (job.route_mode === "mac") return "idw-m1-mac";
    if (job.route_mode === "idw-2") return "idw-2";
    const p = PARTICIPANTS.find((x) => x.lane === job.lane);
    return p ? p.machine : "router decides";
  }

  async function retryJob(job) {
    const p = PARTICIPANTS.find((x) => x.lane === job.lane);
    // Same field shape as app.js queueJob()'s jobs insert. Two honest notes:
    // target_machine is carried via route_mode (the bridge sets target_machine
    // itself after routing), and placeholder_message_id is omitted because the
    // Phase 2 allowlist covers only this jobs insert — the bridge treats a
    // missing placeholder as "insert a fresh result message" (listener.mjs).
    const row = {
      id: crypto.randomUUID(),
      kind: job.kind || "dispatch",
      lane: job.lane,
      agent: job.agent || (p ? p.name : job.lane),
      prompt: job.prompt,
      classification: job.classification || "auto",
      route_mode: job.target_machine === "idw-m1-mac" ? "mac"
        : job.target_machine === "idw-2" ? "idw-2"
        : (job.route_mode || "auto"),
    };
    const { error } = await sb.from("jobs").insert(row);
    if (error) throw error;
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
      li.className = "row-item static";
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
      li.append(dot, label);
      return li;
    }));
    const all = sortedJobs();
    $("fleet-lanes").replaceChildren(...PARTICIPANTS.map((p) => {
      const li = document.createElement("li");
      li.className = "row-item static";
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
      li.append(dot, label);
      return li;
    }));
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

  // ---------- Detail (read-only) ----------
  function openDetail(job) {
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
    const d = $("detail");
    if (typeof d.showModal === "function") d.showModal(); else d.setAttribute("open", "");
  }
  $("d-close").addEventListener("click", () => {
    const d = $("detail");
    if (typeof d.close === "function") d.close(); else d.removeAttribute("open");
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

  function renderAll() {
    if ($("app").hidden) return;
    renderLiveLabel();
    renderNeeds();
    renderBoard();
    renderFleet();
    renderAdapters();
  }

  setInterval(renderAll, 30000); // stuck-job ages and presence freshness decay without events
})();
