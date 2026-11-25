#!/usr/bin/env node
// AI Chat Room bridge: claims jobs from Supabase and runs the real agent lanes.
// Node 20+, ESM. Never fabricates output: every failure is written back honestly.
import { createClient } from "@supabase/supabase-js";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();

// ---------- config ----------
function loadEnvFile(path) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return; }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, "$2");
    if (process.env[m[1]] === undefined) process.env[m[1]] = v; // real env wins
  }
}
loadEnvFile(process.env.AICR_ENV || join(HOME, ".config/ai-chat-room/bridge.env"));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_KEY are required (see README).");
  process.exit(1);
}

const ME = "idw-2";
const MAC = "idw-m1-mac";
const LABEL = { [ME]: "IDW-2", [MAC]: "M1 Mac" };
const MAC_HOST = process.env.MAC_HOST || "100.77.231.71";
const MAC_USER = process.env.MAC_USER || "idw-1";
const SSH_PROXY = process.env.SSH_PROXY || join(HOME, "workspace/ssh_tailnet.sh");
const SSH_KEY = process.env.SSH_KEY || join(HOME, ".ssh/omarchy_muse");
const HERMES_MAC_CMD = process.env.HERMES_MAC_CMD || "hermes chat -q"; // unverified: set to the real non-interactive form
const CWD = process.env.LANE_CWD || join(HOME, "Work/cluster");
const MAX_CONCURRENT = 3;
const DEFAULT_TIMEOUT_MS = 240_000;
const OPENCODE_TIMEOUT_MS = 120_000;
const PRESENCE_FRESH_MS = 3 * 60_000;
const MUSE_PROMPT =
  "You are Muse, the conductor of a multi-agent cluster. Answer as the orchestrator: " +
  "be concise, say which agent lane should do what when work should be delegated, " +
  "and never claim to have run anything you did not run.";

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const log = (...a) => console.log(new Date().toISOString(), ...a);
const errlog = (...a) => console.error(new Date().toISOString(), ...a);

// ---------- process helpers ----------
const children = new Set();
let shuttingDown = false;

function run(cmd, args, { timeoutMs = DEFAULT_TIMEOUT_MS, input, cwd = CWD } = {}) {
  return new Promise((resolve) => {
    let stdout = "", stderr = "", timedOut = false, settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = spawn(cmd, args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: process.env });
    } catch (e) {
      return done({ code: -1, stdout, stderr: String(e), timedOut, spawnError: true });
    }
    children.add(child);
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.stdin.on("error", () => {});
    child.on("error", (e) => {
      clearTimeout(timer); children.delete(child);
      done({ code: -1, stdout, stderr: e.message, timedOut, spawnError: true });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer); children.delete(child);
      done({ code: code ?? -1, signal, stdout, stderr, timedOut });
    });
    child.stdin.end(input ?? "");
  });
}

const tail = (s, n = 1500) => (s.length > n ? "…" + s.slice(-n) : s).trim();
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

class LaneError extends Error {}
const fail = (msg) => { throw new LaneError(msg); };

// Turn a finished process into output text or an honest failure.
function outputOrFail(r, what, timeoutMsg) {
  if (shuttingDown) fail("Bridge shut down while the job was running");
  if (r.spawnError) fail(`${what} could not start: ${r.stderr}`);
  if (r.timedOut) fail(timeoutMsg || `${what} timed out`);
  if (r.code !== 0) fail(`${what} exited with code ${r.code}: ${tail(r.stderr || r.stdout)}`);
  const out = r.stdout.trim();
  if (!out) fail(`${what} returned no output`);
  return out;
}

// ---------- presence / routing ----------
async function tailscalePing() {
  const r = await run("tailscale", ["ping", "-c", "1", MAC_HOST], { timeoutMs: 8000, cwd: HOME });
  return r.code === 0;
}

async function macUp() {
  const { data } = await sb.from("presence").select("*").eq("machine", MAC).maybeSingle();
  if (data && data.online && data.checked_at && Date.now() - new Date(data.checked_at).getTime() < PRESENCE_FRESH_MS) {
    return true;
  }
  return tailscalePing(); // one direct check before declaring the Mac down
}

async function heartbeat() {
  const now = new Date().toISOString();
  const up = await tailscalePing();
  const { error } = await sb.from("presence").upsert([
    { machine: ME, online: !shuttingDown, checked_at: now, detail: "bridge listener" },
    { machine: MAC, online: up, checked_at: now, detail: up ? "tailscale ping ok" : "tailscale ping failed" },
  ]);
  if (error) errlog("heartbeat failed:", error.message);
}

function classify(job) {
  const c = job.classification || "auto";
  if (c === "light" || c === "complex") return { cls: c, auto: false };
  const p = job.prompt || "";
  const complex = p.length > 800 ||
    /\b(refactor|architecture|implement|debug|build|migrate|multi-?file|code review|design)\b/i.test(p);
  return { cls: complex ? "complex" : "light", auto: true };
}

const PINNED_MAC = new Set(["duet", "hermes"]);
const MAC_CAPABLE = new Set(["duet", "hermes", "muse", "claude", "codex"]);

// Returns { machine, note } or throws LaneError (honest failure).
async function route(job) {
  const lane = job.lane;
  const mode = job.route_mode || "auto";
  if (PINNED_MAC.has(lane)) {
    if (mode === "idw-2") fail(`${lane} is pinned to the Mac and cannot run on IDW-2`);
    if (!(await macUp())) fail("Mac offline — Duet/Hermes lanes live on the Mac");
    return { machine: MAC, note: `${lane} is Mac-pinned → M1 Mac` };
  }
  if (mode === "mac") {
    if (!MAC_CAPABLE.has(lane)) fail(`Manual route to Mac requested but the ${lane} lane has no Mac runner`);
    if (!(await macUp())) fail("Manual route to Mac requested but the Mac is offline");
    return { machine: MAC, note: "Manual route override → M1 Mac" };
  }
  if (mode === "idw-2") return { machine: ME, note: "Manual route override → IDW-2" };

  const { cls, auto } = classify(job);
  const why = auto ? `auto-classified ${cls}` : `${cls} (requested)`;
  if (cls === "light") return { machine: ME, note: `Light → IDW-2 (${why})` };
  if (!MAC_CAPABLE.has(lane)) return { machine: ME, note: `Complex → IDW-2 (${lane} has no Mac runner)` };
  if (await macUp()) return { machine: MAC, note: `Complex → M1 Mac (${why})` };
  return { machine: ME, note: "Complex → IDW-2 (Mac offline)" };
}

// ---------- lane runners ----------
async function claudeAuthOk() {
  const r = await run("claude", ["auth", "status"], { timeoutMs: 30_000 });
  if (r.spawnError || r.code !== 0) return false;
  try { return JSON.parse(r.stdout).loggedIn === true; }
  catch { return /"loggedIn"\s*:\s*true/.test(r.stdout); }
}

async function localClaude(prompt, systemPrompt) {
  if (!(await claudeAuthOk())) fail("Claude auth expired on IDW-2");
  const args = ["-p", "--model", "sonnet"];
  if (systemPrompt) args.push("--append-system-prompt", systemPrompt);
  return outputOrFail(await run("claude", args, { input: prompt }), "claude");
}

async function localGrok(prompt) {
  const help = await run("grok", ["--help"], { timeoutMs: 15_000 });
  if (help.spawnError) fail("Grok headless mode unavailable (grok CLI not runnable)");
  const h = help.stdout + help.stderr;
  let flag = null;
  if (/--prompt\b/.test(h)) flag = "--prompt";
  else if (/--print\b/.test(h)) flag = "--print";
  else if (/--headless\b/.test(h)) flag = "--headless";
  if (!flag) fail("Grok headless mode unavailable");
  return outputOrFail(await run("grok", [flag, prompt]), "grok");
}

const noDash = (p) => (p.startsWith("-") ? "\n" + p : p); // keep prompt from being parsed as a flag

async function runLocal(job) {
  const prompt = job.prompt || "";
  switch (job.lane) {
    case "claude": return localClaude(prompt);
    case "muse": return localClaude(prompt, MUSE_PROMPT);
    case "codex": return outputOrFail(await run("codex", ["exec", noDash(prompt)]), "codex");
    case "grok": return localGrok(prompt);
    case "opencode":
      return outputOrFail(
        await run("opencode", ["run", noDash(prompt)], { timeoutMs: OPENCODE_TIMEOUT_MS }),
        "opencode", "OpenCode headless run timed out (known issue)"); // single attempt, never retried
    default: return fail(`Unknown lane '${job.lane}'`);
  }
}

// Mac runs go over ssh; the prompt travels on stdin so no quoting of user text is needed.
function ssh(remoteCmd, input) {
  const args = [
    "-o", `ProxyCommand=${SSH_PROXY} %h %p`,
    "-o", "StrictHostKeyChecking=accept-new",
    "-i", SSH_KEY,
    `${MAC_USER}@${MAC_HOST}`,
    remoteCmd,
  ];
  return run("ssh", args, { input, cwd: HOME });
}

// Claude Code needs the Mac GUI login domain (keychain auth), hence launchctl asuser.
const MAC_GUI = (inner) => `launchctl asuser "$(id -u)" /bin/zsh -lc ${shq(inner)}`;

async function runMac(job) {
  const prompt = job.prompt || "";
  switch (job.lane) {
    case "duet":
    case "claude":
      return outputOrFail(await ssh(MAC_GUI("claude -p --model sonnet"), prompt), "Mac claude");
    case "muse":
      return outputOrFail(
        await ssh(MAC_GUI("claude -p --model sonnet"), `${MUSE_PROMPT}\n\n---\n\n${prompt}`), "Mac claude (Muse)");
    case "codex":
      return outputOrFail(await ssh(MAC_GUI('codex exec "$(cat)"'), prompt), "Mac codex");
    case "hermes": {
      const probe = await ssh("/bin/zsh -lc 'command -v hermes'", "");
      if (probe.code !== 0) fail("Hermes CLI not found on the Mac");
      return outputOrFail(await ssh(MAC_GUI(`${HERMES_MAC_CMD} "$(cat)"`), prompt), "Mac hermes");
    }
    default: return fail(`Lane '${job.lane}' has no Mac runner`);
  }
}

// ---------- job lifecycle ----------
const inflight = new Set();

async function writeMessage(job, patch) {
  const row = { ...patch, job_id: job.id, agent: job.agent || job.lane };
  if (job.placeholder_message_id) {
    const { data, error } = await sb.from("messages").update(row)
      .eq("id", job.placeholder_message_id).select("id");
    if (!error && data && data.length) return;
    if (error) errlog("placeholder update failed:", error.message);
    // Placeholder gone (room cleared): fall through and insert a fresh row.
  }
  const { error } = await sb.from("messages").insert(row);
  if (error) errlog("message insert failed:", error.message);
}

async function finishFailed(job, machine, reason) {
  errlog(`job ${job.id} failed: ${reason}`);
  await sb.from("jobs").update({ status: "failed", error: reason, finished_at: new Date().toISOString() }).eq("id", job.id);
  await writeMessage(job, {
    sender: `${job.agent || job.lane} @ ${LABEL[machine] || "bridge"}`,
    kind: "failed", machine: machine || null, content: `Failed: ${reason}`,
  });
}

async function process_(job) {
  let machine = null;
  try {
    const r = await route(job);
    machine = r.machine;
    await sb.from("jobs").update({
      target_machine: machine, route_note: r.note,
      classification: classify(job).cls,
    }).eq("id", job.id);
    log(`job ${job.id} lane=${job.lane} → ${machine} (${r.note})`);
    const result = machine === MAC ? await runMac(job) : await runLocal(job);
    await sb.from("jobs").update({ status: "done", result, finished_at: new Date().toISOString() }).eq("id", job.id);
    await writeMessage(job, {
      sender: `${job.agent || job.lane} @ ${LABEL[machine]}`, kind: "live", machine, content: result,
    });
    log(`job ${job.id} done`);
  } catch (e) {
    const reason = e instanceof LaneError ? e.message : `Unexpected bridge error: ${e?.message || e}`;
    await finishFailed(job, machine, reason);
  }
}

async function tryClaim(job) {
  if (shuttingDown || inflight.has(job.id) || inflight.size >= MAX_CONCURRENT) return;
  inflight.add(job.id); // reserve the slot before the await so concurrent triggers cannot overshoot
  let claimed = false;
  try {
    const { data, error } = await sb.from("jobs")
      .update({ status: "running", claimed_by: ME, claimed_at: new Date().toISOString() })
      .eq("id", job.id).eq("status", "pending").select("*");
    if (error) { errlog("claim failed:", error.message); return; }
    if (!data || data.length === 0) return; // someone else got it
    claimed = true;
    await process_(data[0]);
  } finally {
    inflight.delete(job.id);
    if (claimed) setImmediate(poll); // a slot freed up: pick up any waiting job
  }
}

let polling = false;
async function poll() {
  if (polling || shuttingDown) return;
  polling = true;
  try {
    const { data, error } = await sb.from("jobs").select("*")
      .eq("status", "pending").order("created_at", { ascending: true }).limit(10);
    if (error) { errlog("poll failed:", error.message); return; }
    for (const j of data || []) tryClaim(j); // fire and forget; tryClaim enforces the cap
  } finally { polling = false; }
}

// Jobs left 'running' by a previous crash will never finish: say so, don't leave them hanging.
async function recoverStale() {
  const { data } = await sb.from("jobs").select("*").eq("status", "running").eq("claimed_by", ME);
  for (const j of data || []) await finishFailed(j, null, "Bridge restarted while the job was running");
}

// ---------- main ----------
let channel;
const timers = [];

async function main() {
  log("bridge starting; cwd for lanes:", CWD);
  await recoverStale();
  channel = sb.channel("jobs-listener")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "jobs" }, (p) => {
      if (p.new?.status === "pending") tryClaim(p.new);
    })
    .subscribe((status) => log("realtime:", status));
  timers.push(setInterval(poll, 2000)); // fallback if realtime drops
  timers.push(setInterval(heartbeat, 60_000));
  await heartbeat();
  poll();
}

async function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`${sig} received; shutting down`);
  timers.forEach(clearInterval);
  for (const c of children) c.kill("SIGTERM");
  const deadline = Date.now() + 10_000;
  while (inflight.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  try {
    await sb.from("presence").upsert({ machine: ME, online: false, checked_at: new Date().toISOString(), detail: "bridge stopped" });
    if (channel) await sb.removeChannel(channel);
  } catch { /* best effort */ }
  process.exit(0);
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

main().catch((e) => { errlog("fatal:", e); process.exit(1); });
