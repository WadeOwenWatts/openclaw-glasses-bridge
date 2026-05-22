// In-memory ring buffer of cross-surface "mirror" messages so the Even Hub
// glasses HUD can render Telegram (or other channel) traffic when the user
// taps into the openclaw-main session. The Even App reads bubbles from
// /api/sessions/<id>/history; SSE is only used for the live in-flight turn
// the WebView itself initiated, so unsolicited mirror events broadcast over
// SSE alone are silently dropped.
//
// Backed by an append-only JSONL file on disk so bridge restarts don't
// erase conversation context. On module load we read the tail of the
// file (up to MAX_ENTRIES) into memory; on push we append + retain.

import { mkdirSync, appendFileSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const MAX_ENTRIES = 200;
const DATA_DIR = join(homedir(), "openclaw-glasses-bridge", "data");
const HISTORY_FILE = join(DATA_DIR, "mirror-history.jsonl");

// Window during which a glasses-turn timeout-busy bubble is still
// considered "resolvable" by a subsequent real assistant reply. After
// this, the busy entry stays in history (the user has effectively
// adopted it as part of the conversation, so dropping it would be
// disorienting).
const TIMEOUT_BUSY_RESOLVE_WINDOW_MS = parseInt(
  process.env.GLASSES_TIMEOUT_BUSY_RESOLVE_WINDOW_MS || `${5 * 60 * 1000}`,
  10,
);

/**
 * @typedef {Object} MirrorEntry
 * @property {"user"|"assistant"} role
 * @property {string} text
 * @property {number} ts
 */

/** @type {MirrorEntry[]} */
const entries = [];

/**
 * Pending timeout-busy markers — each is a reference back into `entries`
 * by exact (ts, text) match so we can splice it out cleanly when the
 * real assistant reply lands. Tracked separately from `entries` to
 * avoid any string-matching heuristics on bubble text.
 * @type {Array<{ ts: number, text: string }>}
 */
let pendingTimeoutBusyMarkers = [];

function ensureDir() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    console.warn(
      `[mirror-history] failed to mkdir ${DATA_DIR}: ${err?.message || err}`,
    );
  }
}

function loadFromDisk() {
  if (!existsSync(HISTORY_FILE)) return;
  try {
    const raw = readFileSync(HISTORY_FILE, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    // Take the tail (most recent MAX_ENTRIES lines) for memory.
    const tail = lines.slice(-MAX_ENTRIES);
    for (const line of tail) {
      try {
        const obj = JSON.parse(line);
        if (
          obj &&
          (obj.role === "user" || obj.role === "assistant") &&
          typeof obj.text === "string" &&
          obj.text
        ) {
          entries.push({
            role: obj.role,
            text: obj.text,
            ts: typeof obj.ts === "number" ? obj.ts : Date.now(),
          });
        }
      } catch {
        // Skip malformed line.
      }
    }
    console.log(
      `[mirror-history] loaded ${entries.length} entries from ${HISTORY_FILE}`,
    );
  } catch (err) {
    console.warn(
      `[mirror-history] failed to read ${HISTORY_FILE}: ${
        err?.message || err
      }`,
    );
  }
}

ensureDir();
loadFromDisk();

/**
 * Append a mirror entry. Persists to JSONL before adding to in-memory
 * ring so a crash mid-write doesn't lose the entry.
 * @param {"user"|"assistant"} role
 * @param {string} text
 */
export function pushMirrorHistory(role, text) {
  if (role !== "user" && role !== "assistant") return;
  if (typeof text !== "string" || !text) return;
  const entry = { role, text, ts: Date.now() };
  try {
    appendFileSync(HISTORY_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.warn(
      `[mirror-history] failed to persist entry: ${err?.message || err}`,
    );
  }
  entries.push(entry);
  while (entries.length > MAX_ENTRIES) entries.shift();
}

/**
 * Rewrite the JSONL file by removing entries whose (ts, text) tuple
 * is in `keysToDrop`. Reads the FULL disk file and filters — we cannot
 * just dump in-memory `entries` because in-memory is a bounded ring
 * (MAX_ENTRIES = 200) and disk can hold more historical entries; a
 * naive memory-dump would silently truncate the older tail. (Caught
 * 2026-05-01 by /tmp/dedupe-test.mjs which ate ~30 entries on first
 * call.)
 *
 * @param {Set<string>} keysToDrop  exact `${ts}|${text}` tuples
 */
function rewriteHistoryJsonl(keysToDrop) {
  if (!existsSync(HISTORY_FILE)) return;
  try {
    const raw = readFileSync(HISTORY_FILE, "utf8");
    const lines = raw.split("\n").filter(Boolean);
    const kept = [];
    for (const line of lines) {
      let drop = false;
      try {
        const obj = JSON.parse(line);
        if (
          obj &&
          typeof obj.ts === "number" &&
          typeof obj.text === "string" &&
          keysToDrop.has(`${obj.ts}|${obj.text}`)
        ) {
          drop = true;
        }
      } catch {
        // Malformed line — keep as-is so we don't accidentally lose
        // data we couldn't parse.
      }
      if (!drop) kept.push(line);
    }
    writeFileSync(
      HISTORY_FILE,
      kept.join("\n") + (kept.length ? "\n" : ""),
      "utf8",
    );
  } catch (err) {
    console.warn(
      `[mirror-history] failed to rewrite ${HISTORY_FILE}: ${
        err?.message || err
      }`,
    );
  }
}

/**
 * Variant of pushMirrorHistory that flags the entry for later dedupe
 * when a real assistant reply arrives. Used by the glasses-bridge's
 * sessions_send timeout handler so the "⎘️ Still working..." bubble can
 * be silently removed once the late reply lands via the
 * Telegram-outbound mirror hook.
 *
 * The marker is held for TIMEOUT_BUSY_RESOLVE_WINDOW_MS; after that the
 * entry stays in history permanently (it's effectively adopted as part
 * of the conversation by then).
 * @param {string} text
 */
export function pushTimeoutBusyEntry(text) {
  if (typeof text !== "string" || !text) return;
  pushMirrorHistory("assistant", text);
  const last = entries[entries.length - 1];
  if (last) {
    pendingTimeoutBusyMarkers.push({ ts: last.ts, text: last.text });
  }
}

/**
 * Sweep pending timeout-busy markers and remove any matching entries
 * from history (in-memory + disk). Called by the channel-mirror route
 * when a real assistant reply lands via the Telegram-outbound mirror,
 * and by the bridge's own glasses-success path.
 *
 * Markers older than TIMEOUT_BUSY_RESOLVE_WINDOW_MS are dropped without
 * touching the entry — the user has had time to read it.
 *
 * @returns {number} count of entries actually removed
 */
export function resolvePendingTimeoutBusy() {
  if (pendingTimeoutBusyMarkers.length === 0) return 0;
  const now = Date.now();
  const remaining = [];
  /** @type {Set<string>} */
  const keysToDrop = new Set();
  let removed = 0;
  for (const marker of pendingTimeoutBusyMarkers) {
    if (now - marker.ts > TIMEOUT_BUSY_RESOLVE_WINDOW_MS) {
      // Too old to resolve — drop the marker, leave the entry.
      continue;
    }
    // Find the entry by exact (ts, text) match. There should be at
    // most one match because ts is millisecond-resolution and we only
    // push from one event loop.
    const idx = entries.findIndex(
      (e) => e.ts === marker.ts && e.text === marker.text,
    );
    if (idx !== -1) {
      entries.splice(idx, 1);
      keysToDrop.add(`${marker.ts}|${marker.text}`);
      removed += 1;
    }
    // Either way the marker is consumed (we either removed the entry
    // or it was already removed). Don't re-add to remaining.
  }
  pendingTimeoutBusyMarkers = remaining;
  if (keysToDrop.size > 0) {
    rewriteHistoryJsonl(keysToDrop);
    console.log(
      `[mirror-history] dedupe: removed ${removed} stale timeout-busy entr${
        removed === 1 ? "y" : "ies"
      }`,
    );
  }
  return removed;
}

/** Test helper — inspect the pending-marker list. */
export function _peekPendingTimeoutBusyForTests() {
  return [...pendingTimeoutBusyMarkers];
}

/**
 * Return the most recent N entries in chronological order, formatted
 * matching the shape the Even App expects from claude/codex providers
 * (`{ role, text }`).
 * @param {number} limit
 * @returns {Array<{role:"user"|"assistant",text:string}>}
 */
export function getMirrorHistory(limit) {
  const n = Math.min(Math.max(1, limit | 0 || 50), entries.length);
  return entries.slice(-n).map((e) => ({ role: e.role, text: e.text }));
}

/** Test helper \u2014 clear the in-memory buffer (does NOT touch disk). */
export function _clearMirrorHistoryForTests() {
  entries.length = 0;
}

/**
 * Append a progress note. Convenience wrapper around pushMirrorHistory
 * with a fixed assistant role and a leading marker so progress lines are
 * visually distinguishable from full replies on session re-entry.
 * @param {string} text
 */
export function pushProgressNote(text) {
  if (typeof text !== "string" || !text) return;
  // Leading marker is intentional — Even Hub WebView treats history
  // entries as plain text, so the prefix is the only differentiator.
  pushMirrorHistory("assistant", `• ${text}`);
}
