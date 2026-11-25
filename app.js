// AI Chat Room frontend. No build step. Data protection is Supabase Auth + RLS.
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
  const presence = new Map(); // machine -> row
  let channel = null;
  let clearArmed = false;
  let clearTimer = null;

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
    const [m, p] = await Promise.all([
      sb.from("messages").select("*").order("created_at", { ascending: true }).limit(500),
      sb.from("presence").select("*"),
    ]);
    if (m.error) setStatus("Load messages failed: " + m.error.message);
    if (p.error) setStatus("Load presence failed: " + p.error.message);
    messages.clear(); presence.clear();
    (m.data || []).forEach((r) => messages.set(r.id, r));
    (p.data || []).forEach((r) => presence.set(r.machine, r));
    renderMessages(); renderSidebar();
  }

  function subscribe() {
    teardown();
    channel = sb.channel("room")
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, (payload) => {
        if (payload.eventType === "DELETE") messages.delete(payload.old.id);
        else messages.set(payload.new.id, payload.new);
        renderMessages();
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "presence" }, (payload) => {
        if (payload.eventType === "DELETE") presence.delete(payload.old.machine);
        else presence.set(payload.new.machine, payload.new);
        renderSidebar();
      })
      .subscribe();
  }

  function teardown() {
    if (channel) { sb.removeChannel(channel); channel = null; }
  }

  // ---------- rendering ----------
  function fmtTime(iso) {
    return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  }

  function renderMessages() {
    const box = $("messages");
    const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    const rows = [...messages.values()].sort((a, b) => a.created_at.localeCompare(b.created_at));
    box.replaceChildren(...rows.map((r) => {
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
    }));
    if (stick) box.scrollTop = box.scrollHeight;
  }

  function isOnline(machine) {
    const p = presence.get(machine);
    return !!p && p.online && p.checked_at && Date.now() - new Date(p.checked_at).getTime() < PRESENCE_FRESH_MS;
  }

  function renderSidebar() {
    $("participants").replaceChildren(...PARTICIPANTS.map((p) => {
      const li = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = "dot " + (p.lane === null ? "sim" : isOnline(p.machine) ? "on" : "off");
      const label = document.createElement("span");
      label.textContent = p.name + " ";
      const small = document.createElement("small");
      small.textContent = p.role;
      label.append(small);
      li.append(dot, label);
      return li;
    }));
    $("machines").replaceChildren(...MACHINES.map((m) => {
      const li = document.createElement("li");
      const dot = document.createElement("span");
      dot.className = "dot " + (isOnline(m.id) ? "on" : "off");
      const label = document.createElement("span");
      const pr = presence.get(m.id);
      label.textContent = m.label + (pr && pr.checked_at ? " · " + fmtTime(pr.checked_at) : " · no data");
      li.append(dot, label);
      return li;
    }));
  }

  function fillSelects() {
    const live = PARTICIPANTS.filter((p) => p.lane);
    const target = $("c-target");
    target.replaceChildren(
      new Option("Room (goes to Muse)", "room"),
      ...PARTICIPANTS.map((p) => new Option(p.lane ? p.name : p.name + " (simulated only)", p.lane || "meta")),
    );
    $("d-lane").replaceChildren(...live.map((p) => new Option(p.name, p.lane)));
  }

  // ---------- sending ----------
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
    let target = $("c-target").value;
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
    else { messages.clear(); renderMessages(); }
  });

  function disarm() {
    clearArmed = false; clearTimeout(clearTimer);
    const btn = $("clear-room");
    btn.textContent = "Clear room"; btn.classList.remove("danger");
  }

  fillSelects();
  renderSidebar();
  setInterval(renderSidebar, 30000); // presence freshness decays without events
})();
