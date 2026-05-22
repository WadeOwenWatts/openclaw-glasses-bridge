// main-busy-state — in-memory tracker for whether the main OpenClaw
// session (the one shared across Telegram + glasses) is currently
// processing a turn. Used by the glasses bridge to fail-fast on a
// glasses-originated prompt when main is mid-Telegram turn, instead of
// blocking sessions_send for 180s and racing the timeout.
//
// State is pushed in by:
//   - The openclaw-plugin-glasses channel hooks (`message_received`
//     marks busy=true, `message_sent` marks busy=false) via the
//     /api/main-busy POST endpoint.
//   - The bridge itself, when it fires its own glasses turn through
//     sessions_send (markBusy("glasses") / clearBusy("glasses") around
//     the call).
//
// Source-aware clearing: only the source that set busy can clear it,
// so a Telegram-busy state can't be accidentally cleared by an
// unrelated glasses event (and vice versa).
//
// Staleness guard: if a turn somehow fails to dispatch its outbound
// (main crash, NO_REPLY, plugin POST drop), the busy flag would stick
// forever. We auto-clear after BUSY_STALENESS_MS regardless of source.

// 5 min — longer than the LONG_TASK_TIMEOUT (10 min default) is
// deliberately NOT used here. If a long-task glasses turn is in flight,
// the bridge holds its own busy via setBusy("glasses") and won't let
// staleness clear it because the bridge re-pings on the next turn. For
// telegram-originated turns we'd rather false-clear than false-hold; a
// sticky "busy on telegram" message that's actually wrong is worse UX
// than a missed pre-flight that just falls back to current behaviour.
const BUSY_STALENESS_MS = parseInt(
  process.env.GLASSES_MAIN_BUSY_STALENESS_MS || `${5 * 60 * 1000}`,
  10,
);

let state = {
  busy: false,
  source: null,
  since: 0,
};

function isStale() {
  if (!state.busy) return false;
  return Date.now() - state.since > BUSY_STALENESS_MS;
}

export function getMainBusyState() {
  if (isStale()) {
    console.log(
      `[main-busy] stale clear: was source=${state.source} since=${
        Date.now() - state.since
      }ms ago`,
    );
    state = { busy: false, source: null, since: 0 };
  }
  return { ...state };
}

export function setMainBusy(source) {
  if (typeof source !== "string" || !source) return;
  state = { busy: true, source, since: Date.now() };
  console.log(`[main-busy] set busy=true source=${source}`);
}

export function clearMainBusy(source) {
  if (typeof source !== "string" || !source) return;
  if (!state.busy) return;
  // Only the matching source can clear. This prevents a stale
  // outbound mirror event for one source from accidentally clearing a
  // freshly-set busy from a different source.
  if (state.source !== source) {
    console.log(
      `[main-busy] clear ignored: requested source=${source} but current=${state.source}`,
    );
    return;
  }
  console.log(
    `[main-busy] cleared source=${source} after ${Date.now() - state.since}ms`,
  );
  state = { busy: false, source: null, since: 0 };
}

// Test/debug helper — never called in production code paths.
export function _debugSetState(next) {
  state = { busy: false, source: null, since: 0, ...next };
}
