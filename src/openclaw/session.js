// OpenClawSession — drives an in-flight prompt against OpenClaw's main
// session via /tools/invoke -> sessions_send, and translates the result into
// the bridge's SSE message shapes (user_prompt, status, result, etc.) that
// the Even App + glasses HUD already understand.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  pushMirrorHistory,
  pushTimeoutBusyEntry,
  resolvePendingTimeoutBusy,
} from "./mirror-history.js";
import {
  getMainBusyState,
  setMainBusy,
  clearMainBusy,
} from "./main-busy-state.js";

const HOME = homedir();
const OPENCLAW_CONFIG = join(HOME, ".openclaw", "openclaw.json");
const GATEWAY_URL = process.env.OPENCLAW_GATEWAY_URL || "http://127.0.0.1:18789";
const TARGET_SESSION_KEY = process.env.OPENCLAW_TARGET_SESSION_KEY || "main";
// Default 180s. Tuned 2026-05-01: 90s was too tight for any tool-calling
// turn (journalctl + log tail + structured reply easily breaches it). The
// late reply still lands in mirror history via the Telegram-outbound
// plugin, so a timeout no longer means lost — just means "check back".
// Override via OPENCLAW_PROMPT_TIMEOUT_SECONDS for long-running tasks.
const PROMPT_TIMEOUT_SECONDS = parseInt(
  process.env.OPENCLAW_PROMPT_TIMEOUT_SECONDS || "180",
  10
);

// Telegram mirror — fan glasses-originated turns out to Alex's Telegram
// chat in real time so both surfaces see the conversation. The reverse
// direction (Telegram->glasses) is handled by the channel-plugin's
// message_received hook; sessions_send injections bypass that hook, so
// glasses->Telegram has to be explicit here.
const TG_MIRROR_ENABLED =
  (process.env.GLASSES_TG_MIRROR_ENABLED || "1") === "1";
const TG_MIRROR_TARGET = process.env.GLASSES_TG_TARGET_CHAT_ID || "";
const TG_MIRROR_CHANNEL = process.env.GLASSES_TG_CHANNEL || "telegram";

// Long-running task ceiling. Triggered by either an explicit `[long-task]`
// prefix on the prompt, or by intent keywords that map to known multi-min
// flows (closeout / vault sweep / build / etc.). Default 600s (10 min).
const LONG_TASK_TIMEOUT_SECONDS = parseInt(
  process.env.OPENCLAW_LONG_TASK_TIMEOUT_SECONDS || "600",
  10
);

// Intent keywords that flag the prompt as long-running. Case-insensitive
// substring match on the (un-prefixed) prompt body. Keep this list tight:
// false positives waste 10 min of glasses "thinking" if main never replies.
const LONG_TASK_KEYWORDS = [
  "closeout",
  "close out",
  "shutdown procedure",
  "end of task",
  "end-of-task",
  "vault sweep",
  "final summary",
  "slash new",
  "/new",
];

function resolveTimeoutForPrompt(text) {
  if (typeof text !== "string" || !text) {
    return { timeout: PROMPT_TIMEOUT_SECONDS, text, longTask: false };
  }
  let body = text;
  let longTask = false;
  // Explicit prefix wins. Strip it so main Churchill doesn't see the marker.
  const prefixMatch = body.match(/^\s*\[long-task\]\s*/i);
  if (prefixMatch) {
    body = body.slice(prefixMatch[0].length);
    longTask = true;
  } else {
    const lower = body.toLowerCase();
    if (LONG_TASK_KEYWORDS.some((k) => lower.includes(k))) {
      longTask = true;
    }
  }
  return {
    timeout: longTask ? LONG_TASK_TIMEOUT_SECONDS : PROMPT_TIMEOUT_SECONDS,
    text: body,
    longTask,
  };
}

export const OPENCLAW_SYNTHETIC_SESSION_ID = "openclaw-main";

function loadGatewayToken() {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  try {
    const cfg = JSON.parse(readFileSync(OPENCLAW_CONFIG, "utf8"));
    return cfg?.gateway?.auth?.token || cfg?.gateway?.auth?.password || "";
  } catch {
    return "";
  }
}

// Best-effort post to Telegram via OpenClaw's message tool. Fire-and-forget:
// never blocks the glasses turn, never throws, swallows all errors. If the
// gateway is down or the message tool refuses, the glasses turn still works
// — only the Telegram mirror is lost. Truncates to 3500 chars (Telegram cap).
function pushToTelegram(text) {
  if (!TG_MIRROR_ENABLED) return;
  if (typeof text !== "string" || !text.trim()) return;
  const token = loadGatewayToken();
  if (!token) {
    console.warn("[openclaw-session] tg-mirror skipped: no gateway token");
    return;
  }
  const message = text.length > 3500 ? text.slice(0, 3490) + "\u2026" : text;
  fetch(`${GATEWAY_URL}/tools/invoke`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      tool: "message",
      action: "json",
      args: {
        action: "send",
        channel: TG_MIRROR_CHANNEL,
        target: TG_MIRROR_TARGET,
        message,
      },
    }),
  })
    .then((resp) => {
      if (!resp.ok) {
        console.warn(
          `[openclaw-session] tg-mirror non-2xx: HTTP ${resp.status}`
        );
      }
    })
    .catch((err) => {
      console.warn(
        `[openclaw-session] tg-mirror failed: ${err?.message || err}`
      );
    });
}

export class OpenClawSession {
  emit;
  sessionId = OPENCLAW_SYNTHETIC_SESSION_ID;
  _busy = false;
  busyEmitted = false;
  abortController = null;
  promptQueue = [];
  turnStartMs = 0;

  constructor(emit) {
    this.emit = emit;
  }

  get id() {
    return this.sessionId;
  }

  get busy() {
    return this._busy;
  }

  get alive() {
    return true;
  }

  get status() {
    return this._busy ? "busy" : "idle";
  }

  send(msg) {
    this.emit(this.sessionId, msg);
  }

  waitForId() {
    return Promise.resolve(this.sessionId);
  }

  onIdReady(cb) {
    queueMicrotask(() => cb(this.sessionId));
  }

  async start(_sessionId, _cwd) {
    // No-op; OpenClaw's main session is already running. We just attach.
  }

  enqueue(text) {
    this.promptQueue.push(text);
    console.log(
      `[openclaw-session] Enqueued prompt (queue size: ${this.promptQueue.length})`
    );
  }

  async run(text) {
    if (this._busy) {
      throw new Error("Session is busy");
    }
    this._busy = true;
    this.busyEmitted = true;
    this.turnStartMs = Date.now();

    // Resolve per-prompt timeout: long-task prompts get LONG_TASK_TIMEOUT,
    // everything else gets the default. Strip the [long-task] prefix from
    // the body the main session sees.
    const resolved = resolveTimeoutForPrompt(text);
    const effectiveTimeoutSeconds = resolved.timeout;
    const promptBody = resolved.text;
    if (resolved.longTask) {
      console.log(
        `[openclaw-session] long-task detected — timeout=${effectiveTimeoutSeconds}s`
      );
    }

    // Mirror the glasses-originated user prompt into history. The plugin's
    // message_received hook does NOT fire for inter-session sessions_send,
    // so without this, glasses-originated turns are invisible to /history.
    try {
      pushMirrorHistory("user", promptBody);
    } catch (e) {
      console.error(`[openclaw-session] mirror-history push (user) failed: ${e?.message || e}`);
    }

    // PRE-FLIGHT BUSY CHECK
    // ------------------------------------------------------------------
    // If main is currently processing a non-glasses turn (e.g. a Telegram
    // message), bail out fast: emit a friendly "Churchill is busy" reply
    // and skip sessions_send entirely. Without this, the call would block
    // OpenClaw's serial main session for up to PROMPT_TIMEOUT_SECONDS,
    // racing the abort and producing the duplicate-delivery + dead-spin
    // UX Alex hit on 2026-04-30 / 2026-05-01.
    //
    // We deliberately DON'T queue or auto-retry: silent retries hide a
    // real contention signal. Better that the user knows main is busy
    // and chooses to retry or wait for the late-mirror to land.
    const mainBusy = getMainBusyState();
    if (mainBusy.busy && mainBusy.source !== "glasses") {
      const ageS = Math.round((Date.now() - mainBusy.since) / 1000);
      const busySource =
        mainBusy.source && mainBusy.source !== "external"
          ? mainBusy.source
          : "another channel";
      const busyMsg = `🎩 Churchill busy on ${busySource} (${ageS}s in) — back out + back in in ~30s and your reply will be there.`;
      console.log(
        `[openclaw-session] pre-flight: main busy on ${mainBusy.source} (${ageS}s) — short-circuit`,
      );
      this.send({
        type: "status",
        state: "busy",
        sessionId: this.sessionId,
      });
      this.send({ type: "text_delta", text: busyMsg });
      try {
        pushMirrorHistory("assistant", busyMsg);
      } catch (e) {
        console.error(
          `[openclaw-session] mirror-history push (busy short-circuit) failed: ${
            e?.message || e
          }`,
        );
      }
      // Don't pushToTelegram — Alex IS on Telegram, no need to echo a
      // "busy on telegram" message back to the very surface that's busy.
      this._finish(false, busyMsg);
      return;
    }

    // No external busy detected — claim the slot for ourselves so any
    // OTHER glasses-originated turn (e.g. a fast-fired follow-up from a
    // second device) sees us as busy too. clearMainBusy is called in the
    // finally block.
    setMainBusy("glasses");

    // Mirror to Telegram in real time (best-effort, never blocks the turn).
    pushToTelegram(`🥽 you: ${promptBody}`);

    this.send({
      type: "status",
      state: "busy",
      sessionId: this.sessionId,
    });

    const token = loadGatewayToken();
    if (!token) {
      this.send({
        type: "error",
        message:
          "OpenClaw gateway token not found. Set OPENCLAW_GATEWAY_TOKEN or ensure ~/.openclaw/openclaw.json is readable.",
      });
      this._finish(false, "OpenClaw gateway auth missing");
      return;
    }

    this.abortController = new AbortController();
    const timeout = setTimeout(() => {
      try {
        this.abortController?.abort();
      } catch {}
    }, effectiveTimeoutSeconds * 1000);

    try {
      // Mark glasses-originated prompts so main Churchill knows the surface.
      const wrapped = `[from glasses] ${promptBody}`;

      const resp = await fetch(`${GATEWAY_URL}/tools/invoke`, {
        method: "POST",
        signal: this.abortController.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          tool: "sessions_send",
          action: "json",
          args: {
            sessionKey: TARGET_SESSION_KEY,
            message: wrapped,
            timeoutSeconds: effectiveTimeoutSeconds,
          },
        }),
      });

      const bodyText = await resp.text();
      let body;
      try {
        body = JSON.parse(bodyText);
      } catch {
        body = { raw: bodyText };
      }

      if (!resp.ok || body?.ok === false) {
        const errMsg =
          body?.error?.message ||
          body?.error ||
          body?.raw ||
          `HTTP ${resp.status}`;
        console.error(`[openclaw-session] /tools/invoke failed: ${errMsg}`);
        this.send({ type: "error", message: String(errMsg).slice(0, 500) });
        this._finish(false, String(errMsg).slice(0, 500));
        return;
      }

      // sessions_send response shape (OpenClaw 2026.4.25):
      //   { ok: true, result: { content: [{type:'text', text: <stringified-json>}],
      //                         details: { runId, status, reply, sessionKey, delivery } } }
      // The reply we want lives at result.details.reply.
      const wrapper = body?.result ?? body;
      const detailsBag = wrapper?.details ?? wrapper;
      let replyText = this._extractReplyText(detailsBag);
      if (!replyText) replyText = this._extractReplyText(wrapper);

      // Emit the reply as a text_delta so the glasses HUD renders it. The
      // HUD listens for streaming text_delta chunks (that's how Claude Code
      // feeds typing); a final `result` event alone is treated as metadata
      // and produces an empty bubble. Send the reply as one chunk.
      const finalText = replyText || "(empty reply)";
      if (finalText) {
        this.send({ type: "text_delta", text: finalText });
      }

      // Mirror the assistant reply into history so the glasses-originated
      // exchange shows up on session re-entry.
      if (replyText) {
        try {
          pushMirrorHistory("assistant", replyText);
          // A real reply landed — dedupe any pending timeout-busy
          // bubble from a previous turn that the user hasn't read yet.
          resolvePendingTimeoutBusy();
        } catch (e) {
          console.error(`[openclaw-session] mirror-history push (assistant) failed: ${e?.message || e}`);
        }
        // Mirror reply to Telegram in real time (best-effort).
        pushToTelegram(`🥽 Churchill: ${replyText}`);
      }

      this._finish(true, finalText);
    } catch (err) {
      const aborted =
        err?.name === "AbortError" ||
        String(err?.message || "").includes("aborted");
      if (aborted) {
        // Distinguish a true user-initiated interrupt from a timeout.
        // The bridge's only abort path right now is the PROMPT_TIMEOUT
        // setTimeout in the same try-block — there's no /interrupt route
        // for glasses prompts in v1 — so an AbortError here is, in
        // practice, a timeout. Emit a friendly text_delta so the HUD
        // paints a real bubble instead of the dead "thinking" spin
        // Alex saw on 2026-04-30, and persist it in mirror history.
        const busyMsg = `☘️ Still working (over ${effectiveTimeoutSeconds}s) — your reply will land here. Back out + back in to refresh.`;
        this.send({ type: "text_delta", text: busyMsg });
        try {
          // pushTimeoutBusyEntry persists to history AND tags the
          // entry for dedupe — when the real reply lands later via
          // the Telegram-outbound mirror hook (or bridge success path),
          // resolvePendingTimeoutBusy splices this entry back out, so
          // the HUD doesn't end up with both a "Still working..." and
          // the real reply on session re-entry.
          pushTimeoutBusyEntry(busyMsg);
        } catch (e) {
          console.error(`[openclaw-session] mirror-history push failed: ${e?.message || e}`);
        }
        // Tell Telegram the glasses turn timed out.
        pushToTelegram(`🥽 Churchill: ${busyMsg}`);
        this.send({
          type: "result",
          success: false,
          text: busyMsg,
          sessionId: this.sessionId,
          costUsd: 0,
          provider: "openclaw",
          turns: 1,
          durationMs: Date.now() - this.turnStartMs,
          inputTokens: 0,
          outputTokens: 0,
        });
        this._finish(false, busyMsg, { skipResultEvent: true });
      } else {
        console.error(`[openclaw-session] run failed: ${err?.message || err}`);
        this.send({
          type: "error",
          message: String(err?.message || err).slice(0, 500),
        });
        this._finish(false, String(err?.message || err).slice(0, 500));
      }
    } finally {
      clearTimeout(timeout);
      this.abortController = null;
      clearMainBusy("glasses");
    }
  }

  _extractReplyText(result) {
    if (!result) return "";
    if (typeof result === "string") {
      const trimmed = result.trim();
      // Maybe a stringified JSON blob — peel one layer.
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          const parsed = JSON.parse(trimmed);
          const inner = this._extractReplyText(parsed);
          if (inner) return inner;
        } catch {}
      }
      return result;
    }
    // Probe common shapes (OpenClaw uses .reply for sessions_send output).
    if (typeof result.reply === "string" && result.reply.trim()) return result.reply;
    if (typeof result.message === "string" && result.message.trim()) return result.message;
    if (typeof result.text === "string" && result.text.trim()) {
      // Could itself be a stringified JSON; recurse.
      const inner = this._extractReplyText(result.text);
      if (inner && inner !== result.text) return inner;
      return result.text;
    }
    if (typeof result.assistantReply === "string" && result.assistantReply.trim()) return result.assistantReply;
    if (typeof result.body === "string" && result.body.trim()) return result.body;
    if (typeof result.content === "string" && result.content.trim()) return result.content;
    if (Array.isArray(result.content) && result.content.length > 0) {
      const joined = result.content
        .map((c) => (typeof c === "string" ? c : c?.text || ""))
        .filter(Boolean)
        .join("\n");
      if (joined.trim()) {
        const inner = this._extractReplyText(joined);
        if (inner && inner !== joined) return inner;
        return joined;
      }
    }
    if (Array.isArray(result.messages) && result.messages.length > 0) {
      const last = result.messages[result.messages.length - 1];
      return this._extractReplyText(last);
    }
    // Could not find a reply field — return empty so caller falls back.
    return "";
  }

  _finish(success, text, opts = {}) {
    this._busy = false;
    if (!opts.skipResultEvent) {
      this.send({
        type: "result",
        success,
        text,
        sessionId: this.sessionId,
        costUsd: 0,
        provider: "openclaw",
        turns: 1,
        durationMs: Date.now() - this.turnStartMs,
        inputTokens: 0,
        outputTokens: 0,
      });
    }
    if (this.promptQueue.length > 0) {
      const next = this.promptQueue.shift();
      console.log(
        `[openclaw-session] Dispatching queued prompt (remaining: ${this.promptQueue.length})`
      );
      this.send({ type: "user_prompt", text: next });
      this.run(next).catch((err) => {
        console.error(
          `[openclaw-session] queued run failed: ${err?.message || err}`
        );
      });
    } else {
      this.send({
        type: "status",
        state: "idle",
        sessionId: this.sessionId,
      });
    }
  }

  respondPermission(_decision) {
    console.warn(
      "[openclaw-session] respondPermission called but bridge-level approvals are not wired in v1"
    );
  }

  respondQuestion(_answer) {
    console.warn(
      "[openclaw-session] respondQuestion called but bridge-level questions are not wired in v1"
    );
  }

  interrupt() {
    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch {}
    }
  }

  async close() {
    this.interrupt();
    this.promptQueue.length = 0;
    this._busy = false;
  }
}
