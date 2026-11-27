// AI Chat Room frontend. No build step. Data protection is Supabase Auth + RLS.
// Slack-style shell: Status tab, Direct Messages tab, Channels tab (#general + #dispatch).
(() => {
  const cfg = window.CHAT_CONFIG || {};
  const $ = (id) => document.getElementById(id);

  // lane = value stored in jobs.lane (null => no live lane)
  const PARTICIPANTS = [
    { lane: "muse", name: "Muse", role: "conductor", machine: "idw-2" },
    { lane: "duet", name: "Claude Duet", role: "Claude Code on M1 Mac", machine: "idw-m1-mac" },
    { lane: "codex", name: "Codex", role: "idw-2 lane", machine: "idw-2" },
    { lane: "opencode", name: "OpenCode", role: "idw-2 lane", machine: "idw-2" },
    { lane: "grok", name: "Grok", role: "idw-2 lane", machine: "idw-2" },
    { lane: "hermes", name: "Hermes", role: "Mac-only lane", machine: "idw-m1-mac" },
    { lane: null, name: "Meta AI", role: "No live lane — simulated only", machine: null },
  ];
  const MACHINES = [
    { id: "idw-2", label: "IDW-2" },
    { id: "idw-m1-mac", label: "M1 Mac" },
  ];
  const PRESENCE_FRESH_MS = 3 * 60 * 1000;

  if (!window.supabase || !cfg.SUPABASE_URL) {
    document.body.textContent = "Missing supabase-js or config.js";
    return;
  }
  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  const messages = new Map(); // id -> row
  const jobs = new Map();     // id -> row
  const presence = new Map(); // machine -> row
  let channel = null;
  let clearArmed = false;
  let clearTimer = null;

  // ---------- view state ----------
  let tab = "channels";       // 'status' | 'dms' | 'channels'
  let dmLane = undefined;     // undefined = DM list; otherwise a lane string or 'meta'
  let activeChannel = "general"; // null = channel list; 'general' | 'dispatch'

  function setStatus(text) { $("status").textContent = text || ""; }

  // ---------- auth gate ----------
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

  let lastUser = null;
  sb.auth.onAuthStateChange((_event, session) => {
    const uid = session ? session.user.id : null;
    if (uid === lastUser) return; // ignore token refreshes
    lastUser = uid;
    onSession(session);
  });

  // ---------- data ----------
  async function loadAll() {
    const [m, p, j] = await Promise.all([
      sb.from("messages").select("*").order("created_at", { ascending: true }).limit(500),
      sb.from("presence").select("*"),
      sb.from("jobs").select("*").order("created_at", { ascending: false }).limit(200),
    ]);
    if (m.error) setStatus("Load messages failed: " + m.error.message);
    if (p.error) setStatus("Load presence failed: " + p.error.message);
    if (j.error) setStatus("Load jobs failed: " + j.error.message);
    messages.clear(); presence.clear(); jobs.clear();
    (m.data || []).forEach((r) => messages.set(r.id, r));
    (p.data || []).forEach((r) => presence.set(r.machine, r));
    (j.data || []).forEach((r) => jobs.set(r.id, r));
  }

  function subscribe() {
    teardown();
    channel = sb.channel("room")
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, (payload) => {
        if (payload.eventType === "DELETE") messages.delete(payload.old.id);
        else messages.set(payload.new.id, payload.new);
        renderAll();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "jobs" }, (payload) => {
        if (payload.eventType === "DELETE") jobs.delete(payload.old.id);
        else jobs.set(payload.new.id, payload.new);
        renderAll();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "presence" }, (payload) => {
        if (payload.eventType === "DELETE") presence.delete(payload.old.machine);
        else presence.set(payload.new.machine, payload.new);
        renderAll();
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
  function sortedMessages() {
    return [...messages.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
  }
  function sortedJobs() {
    return [...jobs.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
  function isOnline(machine) {
    const p = presence.get(machine);
    return !!p && p.online && p.checked_at && Date.now() - new Date(p.checked_at).getTime() < PRESENCE_FRESH_MS;
  }
  function dotClass(p) {
    return "dot " + (p.lane === null ? "sim" : isOnline(p.machine) ? "on" : "off");
  }
  function snippet(text, n) {
    const t = (text || "").replace(/\s+/g, " ").trim();
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  }

  function buildMsgEl(r) {
    const el = document.createElement("div");
    el.className = "msg";
    const head = document.createElement("div");
    head.className = "msg-head";
    const add = (cls, text) => {
      if (!text) return;
      const s = document.createElement("span");
      s.className = cls; s.textContent = text; head.append(s);
    };
    add("sender", r.sender || "unknown");
    add("badge " + r.kind, r.kind);
    add("agent", r.agent && "agent: " + r.agent);
    add("machine", r.machine && "@ " + r.machine);
    add("time", fmtTime(r.created_at));
    const body = document.createElement("div");
    body.className = "msg-body";
    body.textContent = r.content || ""; // textContent: never interpret agent output as HTML
    el.append(head, body);
    return el;
  }

  function fillThread(box, rows) {
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    box.replaceChildren(...rows.map(buildMsgEl));
    if (stick) box.scrollTop = box.scrollHeight;
  }

  function buildJobEl(job, compact) {
    const el = document.createElement("div");
    el.className = "job-card";
    const head = document.createElement("div");
    head.className = "msg-head";
    const add = (cls, text) => {
      if (!text) return;
      const s = document.createElement("span");
      s.className = cls; s.textContent = text; head.append(s);
    };
    add("sender", job.agent || job.lane || "job");
    add("badge job-" + job.status, job.status);
    add("machine", job.target_machine && "@ " + job.target_machine);
    add("time", fmtTime(job.created_at));
    el.append(head);
    if (job.prompt) {
      const p = document.createElement("div");
      p.className = "job-prompt";
      p.textContent = compact ? snippet(job.prompt, 140) : job.prompt;
      el.append(p);
    }
    const bodyText = job.status === "failed" ? job.error : job.result;
    if (bodyText) {
      const b = document.createElement("div");
      b.className = "msg-body";
      b.textContent = compact ? snippet(bodyText, 220) : bodyText;
      el.append(b);
    } else if (job.status === "pending" || job.status === "running") {
      const b = document.createElement("div");
      b.className = "msg-body dim";
      b.textContent = job.status === "pending" ? "Queued…" : "Running…";
      el.append(b);
    }
    return el;
  }

  // ---------- DM membership ----------
  function dmKey(p) { return p.lane === null ? "meta" : p.lane; }
  function dmRows(p) {
    const keys = p.lane === null ? ["meta", "Meta AI"] : [p.lane, p.name];
    return sortedMessages().filter((r) => {
      if (!keys.includes(r.agent)) return false;
      const job = r.job_id ? jobs.get(r.job_id) : null;
      if (job && job.kind === "dispatch") return false; // dispatches live in #dispatch
      return true;
    });
  }

  // ---------- rendering: status ----------
  function renderStatus() {
    $("st-machines").replaceChildren(...MACHINES.map((m) => {
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
        ? (isOnline(m.id) ? "online" : "offline") + " · checked " + fmtTime(pr.checked_at)
        : "no data yet";
      label.append(name, sub);
      li.append(dot, label);
      return li;
    }));
    $("st-participants").replaceChildren(...PARTICIPANTS.map((p) => {
      const li = document.createElement("li");
      li.className = "row-item static";
      const dot = document.createElement("span");
      dot.className = dotClass(p);
      const label = document.createElement("span");
      label.className = "row-main";
      const name = document.createElement("span");
      name.className = "row-name"; name.textContent = p.name;
      const sub = document.createElement("small");
      sub.textContent = p.role + (p.machine ? " · " + (isOnline(p.machine) ? "online" : "offline") : "");
      label.append(name, sub);
      li.append(dot, label);
      return li;
    }));
    $("st-jobs").replaceChildren(...sortedJobs().slice(0, 8).map((j) => buildJobEl(j, true)));
  }

  // ---------- rendering: DMs ----------
  function renderDmList() {
    $("dm-list").replaceChildren(...PARTICIPANTS.map((p) => {
      const rows = dmRows(p);
      const last = rows[rows.length - 1];
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "row-item";
      const dot = document.createElement("span");
      dot.className = dotClass(p);
      const main = document.createElement("span");
      main.className = "row-main";
      const name = document.createElement("span");
      name.className = "row-name"; name.textContent = p.name;
      const sub = document.createElement("small");
      sub.textContent = last ? snippet(last.content, 60) : p.role;
      main.append(name, sub);
      btn.append(dot, main);
      if (last) {
        const t = document.createElement("span");
        t.className = "row-time"; t.textContent = fmtTime(last.created_at);
        btn.append(t);
      }
      btn.addEventListener("click", () => { dmLane = dmKey(p); renderAll(); });
      li.append(btn);
      return li;
    }));
  }

  function renderDmThread() {
    const p = PARTICIPANTS.find((x) => dmKey(x) === dmLane);
    if (!p) return;
    $("dm-title").textContent = p.name;
    $("dm-presence").textContent = p.lane === null ? "simulated only" : isOnline(p.machine) ? "online" : "offline";
    fillThread($("dm-messages"), dmRows(p));
  }

  // ---------- rendering: channels ----------
  function renderChannelList() {
    const all = sortedMessages();
    const last = all[all.length - 1];
    const active = sortedJobs().filter((j) => j.status === "pending" || j.status === "running").length;
    const defs = [
      { id: "general", name: "#general", desc: "Everyone · the shared room", last: last ? snippet(last.content, 60) : "", time: last && fmtTime(last.created_at) },
      { id: "dispatch", name: "#dispatch", desc: "Live Dispatch jobs", last: active ? active + " job(s) in flight" : "No jobs in flight", time: "" },
    ];
    $("ch-list").replaceChildren(...defs.map((d) => {
      const li = document.createElement("li");
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "row-item";
      const main = document.createElement("span");
      main.className = "row-main";
      const name = document.createElement("span");
      name.className = "row-name"; name.textContent = d.name;
      const sub = document.createElement("small");
      sub.textContent = d.last || d.desc;
      main.append(name, sub);
      btn.append(main);
      if (d.time) {
        const t = document.createElement("span");
        t.className = "row-time"; t.textContent = d.time;
        btn.append(t);
      }
      btn.addEventListener("click", () => { activeChannel = d.id; renderAll(); });
      li.append(btn);
      return li;
    }));
  }

  function renderDispatch() {
    const dispatches = sortedJobs().filter((j) => j.kind === "dispatch");
    $("jobs-list").replaceChildren(...dispatches.map((j) => buildJobEl(j, false)));
  }

  // ---------- view switching ----------
  function placeComposer() {
    const composer = $("composer");
    const status = $("status");
    let slot = null;
    if (tab === "dms" && dmLane !== undefined) slot = $("dm-thread").querySelector(".composer-slot");
    if (tab === "channels" && activeChannel === "general") slot = $("general-wrap").querySelector(".composer-slot");
    if (slot) {
      slot.append(composer, status);
      composer.hidden = false; status.hidden = false;
    } else {
      $("app").append(composer, status);
      composer.hidden = true; status.hidden = true;
    }
    // DM mode: fixed recipient, no target picker. Channel mode: picker visible.
    const inDm = tab === "dms" && dmLane !== undefined;
    $("c-target").hidden = inDm;
    const to = $("c-to");
    to.hidden = !inDm;
    if (inDm) {
      const p = PARTICIPANTS.find((x) => dmKey(x) === dmLane);
      to.textContent = "To · " + (p ? p.name : "");
    }
  }

  function renderAll() {
    if ($("app").hidden) return;
    document.querySelectorAll(".tab").forEach((b) => {
      if (b.dataset.tab === tab) b.setAttribute("aria-current", "page");
      else b.removeAttribute("aria-current");
    });
    $("view-status").hidden = tab !== "status";
    $("view-dms").hidden = tab !== "dms";
    $("view-channels").hidden = tab !== "channels";

    const active = sortedJobs().filter((j) => j.status === "pending" || j.status === "running").length;
    const badge = $("jobs-badge");
    badge.hidden = active === 0;
    badge.textContent = active ? String(active) : "";

    if (tab === "status") renderStatus();
    if (tab === "dms") {
      const inThread = dmLane !== undefined;
      $("dm-list-wrap").hidden = inThread;
      $("dm-thread").hidden = !inThread;
      if (inThread) renderDmThread(); else renderDmList();
    }
    if (tab === "channels") {
      const inThread = activeChannel !== null;
      $("ch-list-wrap").hidden = inThread;
      $("ch-thread").hidden = !inThread;
      if (!inThread) renderChannelList();
      else if (activeChannel === "general") {
        $("ch-title").textContent = "#general";
        $("general-wrap").hidden = false;
        $("dispatch-wrap").hidden = true;
        fillThread($("ch-messages"), sortedMessages());
      } else {
        $("ch-title").textContent = "#dispatch";
        $("general-wrap").hidden = true;
        $("dispatch-wrap").hidden = false;
        renderDispatch();
      }
    }
    placeComposer();
  }

  document.querySelectorAll(".tab").forEach((b) => {
    b.addEventListener("click", () => { tab = b.dataset.tab; renderAll(); });
  });
  $("dm-back").addEventListener("click", () => { dmLane = undefined; renderAll(); });
  $("ch-back").addEventListener("click", () => { activeChannel = null; renderAll(); });

  // ---------- sending ----------
  function fillSelects() {
    const live = PARTICIPANTS.filter((p) => p.lane);
    $("c-target").replaceChildren(
      new Option("Room (goes to Muse)", "room"),
      ...PARTICIPANTS.map((p) => new Option(p.lane ? p.name : p.name + " (simulated only)", p.lane || "meta")),
    );
    $("d-lane").replaceChildren(...live.map((p) => new Option(p.name, p.lane)));
  }

  const byLane = (lane) => PARTICIPANTS.find((p) => p.lane === lane);

  function machineHint(p) {
    return p.machine === "idw-m1-mac" ? "M1 Mac" : "machine chosen by router";
  }

  async function queueJob({ kind, lane, prompt, classification, route_mode }) {
    const p = byLane(lane);
    const placeholderId = crypto.randomUUID();
    const jobId = crypto.randomUUID();
    const ins = await sb.from("messages").insert({
      id: placeholderId, sender: "System", kind: "system", agent: p.name, job_id: jobId,
      content: `Queued for the real ${p.name} @ ${machineHint(p)}…`,
    });
    if (ins.error) throw ins.error;
    const job = await sb.from("jobs").insert({
      id: jobId, kind, lane, agent: p.name, prompt,
      classification: classification || "auto", route_mode: route_mode || "auto",
      placeholder_message_id: placeholderId,
    });
    if (job.error) throw job.error;
  }

  $("composer").addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = $("c-text").value.trim();
    if (!text) return;
    let target = (tab === "dms" && dmLane !== undefined) ? dmLane : $("c-target").value;
    setStatus("");
    try {
      const um = await sb.from("messages").insert({ sender: "Isaac", kind: "user", content: text, agent: target });
      if (um.error) throw um.error;
      $("c-text").value = "";
      if (target === "meta") {
        // Honest: no lane exists, nothing is queued, nothing is faked.
        const r = await sb.from("messages").insert({
          sender: "System", kind: "system", agent: "Meta AI",
          content: "Meta AI has no live lane — simulated only. Nothing was queued.",
        });
        if (r.error) throw r.error;
        return;
      }
      if (target === "room") target = "muse";
      await queueJob({ kind: "chat", lane: target, prompt: text });
    } catch (err) {
      setStatus("Send failed: " + (err.message || err));
    }
  });

  $("dispatch-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const prompt = $("d-prompt").value.trim();
    if (!prompt) return;
    setStatus("");
    try {
      await queueJob({
        kind: "dispatch", lane: $("d-lane").value, prompt,
        classification: $("d-complexity").value, route_mode: $("d-route").value,
      });
      $("d-prompt").value = "";
    } catch (err) {
      setStatus("Dispatch failed: " + (err.message || err));
    }
  });

  // ---------- clear room (two taps; jobs audit is kept) ----------
  $("clear-room").addEventListener("click", async () => {
    const btn = $("clear-room");
    if (!clearArmed) {
      clearArmed = true;
      btn.textContent = "Tap again to confirm";
      btn.classList.add("danger");
      clearTimer = setTimeout(disarm, 4000);
      return;
    }
    disarm();
    const { error } = await sb.from("messages").delete().gte("created_at", "1970-01-01T00:00:00Z");
    if (error) setStatus("Clear failed: " + error.message);
    else { messages.clear(); renderAll(); }
  });

  function disarm() {
    clearArmed = false; clearTimeout(clearTimer);
    const btn = $("clear-room");
    btn.textContent = "Clear room"; btn.classList.remove("danger");
  }

  fillSelects();
  setInterval(renderAll, 30000); // presence freshness decays without events
})();
