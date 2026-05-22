// OpenClaw provider — adapts OpenClaw's main session into the
// even-terminal bridge's provider interface.
//
// Mirrors the surface implemented by claude/provider.js + codex/provider.js:
//   listSessions(limit, cwd) -> Session[]
//   getSessionStatus(sessionId) -> "idle" | "busy"
//   getInfo() -> { account, model, version, provider }
//   getHistory(sessionId, limit) -> historyEntry[]
//   prompt(sessionId, text, cwd) -> { sessionId, provider }
//   respondPermission(sessionId, decision)
//   respondQuestion(sessionId, answer)
//   interrupt(sessionId)
//   getStatus(sessionId) -> { state, provider } | null

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  OpenClawSession,
  OPENCLAW_SYNTHETIC_SESSION_ID,
} from "./session.js";
import { getMirrorHistory } from "./mirror-history.js";

const HOME = homedir();
const OPENCLAW_CONFIG = join(HOME, ".openclaw", "openclaw.json");

function readOpenClawConfig() {
  try {
    return JSON.parse(readFileSync(OPENCLAW_CONFIG, "utf8"));
  } catch {
    return null;
  }
}

function getMainAgentModel(cfg) {
  // Probe the most common config shapes.
  const defaults = cfg?.agents?.defaults || {};
  const main = cfg?.agents?.main || {};
  const candidate =
    main.model ||
    main.models?.primary ||
    defaults.model?.primary ||
    defaults.model ||
    defaults.models?.primary;
  if (typeof candidate === "string" && candidate) return candidate;
  return "Unknown";
}

export function createOpenClawProvider(emit) {
  // Single shared session — OpenClaw's main session is one long-lived thing.
  // We surface it as a single bridge-level session with synthetic id.
  let session = null;

  function ensureSession() {
    if (!session) session = new OpenClawSession(emit);
    return session;
  }

  async function prompt(_sessionId, text, _cwd) {
    const s = ensureSession();
    // Always emit user_prompt so glasses HUD shows what was said.
    emit(OPENCLAW_SYNTHETIC_SESSION_ID, { type: "user_prompt", text });
    if (s.busy) {
      s.enqueue(text);
    } else {
      s.run(text).catch((err) => {
        console.error(
          `[openclaw-provider] run failed: ${err?.message || err}`
        );
      });
    }
    return { sessionId: OPENCLAW_SYNTHETIC_SESSION_ID, provider: "openclaw" };
  }

  function respondPermission(_sessionId, decision) {
    ensureSession().respondPermission(decision);
  }

  function respondQuestion(_sessionId, answer) {
    ensureSession().respondQuestion(answer);
  }

  function interrupt(_sessionId) {
    if (session) session.interrupt();
  }

  function getStatus(_sessionId) {
    if (!session) return null;
    return { state: session.status, provider: "openclaw" };
  }

  async function getSessionStatus(_sessionId) {
    if (!session) return "idle";
    return session.status;
  }

  async function listSessions(_limit, _cwd) {
    // Glasses sees ONE persistent OpenClaw session. Always returns the
    // synthetic main session. provider field is reported as "claude"
    // because the Even App's host-card counter filters by
    // provider==="claude" client-side; reporting "openclaw" makes the UI
    // show "0 sessions" even when /api/sessions returns the entry. The
    // actual routing is OpenClaw underneath (see getProvider short-circuit
    // in PATCHES.md). 2026-05-13: spotted during Option 3 cutover.
    const cfg = readOpenClawConfig();
    return [
      {
        id: OPENCLAW_SYNTHETIC_SESSION_ID,
        title: "Churchill (main OpenClaw)",
        timestamp: new Date().toISOString(),
        cwd: cfg?.gateway?.workspace || HOME,
        provider: "claude",
        status: session ? session.status : "idle",
      },
    ];
  }

  async function getInfo() {
    const cfg = readOpenClawConfig();
    let version = "Unknown";
    try {
      const meta = JSON.parse(
        readFileSync(
          "/usr/lib/node_modules/openclaw/package.json",
          "utf8"
        )
      );
      if (meta?.version) version = meta.version;
    } catch {}
    const model = getMainAgentModel(cfg);
    const account = {
      // Best-effort identity surface; OpenClaw doesn't expose an account
      // model the same way Claude Code does, so we surface session config.
      surface: "openclaw-main",
      sessionKey:
        process.env.OPENCLAW_TARGET_SESSION_KEY ||
        cfg?.session?.mainKey ||
        "main",
    };
    return {
      account,
      model: typeof model === "string" ? model : "Unknown",
      version,
      provider: "openclaw",
    };
  }

  async function getHistory(_sessionId, limit) {
    // Returns cross-surface mirror entries (Telegram inbound/outbound,
    // etc.) so the HUD paints them as bubbles when the user taps into
    // the openclaw-main session. Glasses-originated turns that go
    // through OpenClawSession.run() render live via SSE during the turn
    // but are NOT (yet) persisted into mirror-history; could be added by
    // hooking emit() in createOpenClawProvider if we want them to
    // survive a session re-entry.
    return getMirrorHistory(typeof limit === "number" ? limit : 50);
  }

  return {
    listSessions,
    getSessionStatus,
    getInfo,
    getHistory,
    prompt,
    respondPermission,
    respondQuestion,
    interrupt,
    getStatus,
  };
}
