# Setup

End-to-end recipe. Should take about 10 minutes if OpenClaw and the Even App are already working on their own.

## 0. Prereqs

- OpenClaw 2026.4.25+ running locally with the `main` agent reachable via Telegram (or any other channel) so you know `sessions_send` works end-to-end.
- Even Realities G2 glasses paired with the Even App, Terminal Mode visible in the app.
- Node 18+ on the host machine the bridge will run on (usually the same machine OpenClaw runs on).
- Network reachability between your phone and the bridge host. Easiest is [Tailscale](https://tailscale.com) on both ends.

## 1. Install upstream Even Terminal

```bash
npm install -g @evenrealities/even-terminal
```

Find where npm dropped it:

```bash
npm root -g
# e.g. /usr/lib/node_modules
# upstream lives at <npm-root>/@evenrealities/even-terminal/
```

Test it with the stock Claude provider just to confirm the install works:

```bash
even-terminal --port 3456 --tailscale
```

Pair from the Even App, prove the HUD lights up. Then `Ctrl-C` and we'll swap providers.

## 2. Drop in the OpenClaw provider files

Copy the 4 files from this repo's `src/openclaw/` into the installed package's `dist/openclaw/`:

```bash
UPSTREAM=$(npm root -g)/@evenrealities/even-terminal/dist
mkdir -p $UPSTREAM/openclaw
cp src/openclaw/*.js $UPSTREAM/openclaw/
```

## 3. Apply the two upstream patches

```bash
UPSTREAM=$(npm root -g)/@evenrealities/even-terminal
cd $UPSTREAM
patch -p1 < /path/to/this/repo/patches/01-routes-core.patch
patch -p1 < /path/to/this/repo/patches/02-session.patch
```

The patches are tiny:

- `01-routes-core.patch` — imports the OpenClaw provider and short-circuits `getProvider()` to it when `DEFAULT_PROVIDER=openclaw`. Also widens the `/api/sessions/:id/history` cap from 10 to 200 so cross-surface mirror bubbles don't bury earlier turns.
- `02-session.patch` — teaches `getDefaultProvider()` to accept `"openclaw"` as a valid value.

## 4. Configure OpenClaw

Add these to `~/.openclaw/openclaw.json` (merge with whatever you already have):

```json
{
  "gateway": {
    "tools": { "allow": ["sessions_send"] }
  },
  "tools": {
    "sessions": { "visibility": "all" }
  },
  "session": {
    "agentToAgent": { "maxPingPongTurns": 0 }
  }
}
```

What each one does:

- `gateway.tools.allow` exposes `sessions_send` over the gateway's HTTP `/tools/invoke` endpoint (the bridge talks to OpenClaw via this).
- `tools.sessions.visibility=all` lets the bridge see the `main` session.
- `session.agentToAgent.maxPingPongTurns=0` disables a chat-style follow-up loop that would otherwise count the bridge's inter-session message as a chain step.

Restart OpenClaw to pick up the config.

## 5. Pick a gateway token

The bridge needs to authenticate to OpenClaw. Either:

- Set `OPENCLAW_GATEWAY_TOKEN=<your-token>` in the bridge's environment, OR
- Make sure `~/.openclaw/openclaw.json` has `gateway.auth.token` populated and is readable by the bridge process (the bridge falls back to reading it from disk).

## 6. Start the bridge

```bash
DEFAULT_PROVIDER=openclaw \
  even-terminal \
  --port 3457 \
  --token $(openssl rand -hex 16) \
  --tailscale \
  --cwd ~/your-workspace
```

What the flags do:

- `DEFAULT_PROVIDER=openclaw` — the env var that activates the OpenClaw provider short-circuit in the patched `routes/core.js`.
- `--port 3457` — pick anything free. The Even App will scan for hosts on your network.
- `--token` — the Even App-to-bridge token. Random hex is fine; you only enter it once during pairing.
- `--tailscale` — bind to the Tailscale IPv4 address. Use `--interface eth0` (or whatever) for plain LAN, or omit both for localhost only.
- `--cwd` — workspace directory. The bridge surfaces this through `listSessions().cwd`. Cosmetic for OpenClaw (OpenClaw uses its own workspace), but the Even App displays it.

To keep it running, drop a systemd unit (see [systemd/openclaw-glasses-bridge.service](./systemd/openclaw-glasses-bridge.service)) or use pm2 / launchd / whatever you prefer.

## 7. Pair from the Even App

In the Even App, open Terminal Mode, scan for hosts. You should see the bridge advertised. Tap to pair, paste the token from step 6.

Send a voice prompt from the glasses. Wait a few seconds. The reply should paint on the HUD.

## Optional: mirror to Telegram (or any OpenClaw channel)

The provider includes an optional cross-surface mirror so glasses-originated turns also push into your Telegram chat in real time, and Telegram-originated replies show up in the glasses HUD history when you re-enter the session.

Set:

```bash
GLASSES_TG_MIRROR_ENABLED=1
GLASSES_TG_CHANNEL=telegram             # or discord / signal / etc.
GLASSES_TG_TARGET_CHAT_ID=<your-id>     # required: bridge won't mirror without it
```

If `GLASSES_TG_TARGET_CHAT_ID` is empty (default), the bridge silently skips the mirror and the HUD still works normally.

## Optional: tune timeouts

| Env var                                  | Default | What it does                                      |
| ---------------------------------------- | ------- | ------------------------------------------------- |
| `OPENCLAW_PROMPT_TIMEOUT_SECONDS`        | 180     | Default per-turn timeout                          |
| `OPENCLAW_LONG_TASK_TIMEOUT_SECONDS`     | 600     | Timeout for long-task prompts (10 min)            |
| `OPENCLAW_TARGET_SESSION_KEY`            | `main`  | Which OpenClaw session the bridge talks to        |
| `OPENCLAW_GATEWAY_URL`                   | `http://127.0.0.1:18789` | OpenClaw gateway URL              |

Long-task prompts are detected by either:

- An explicit `[long-task]` prefix (stripped before forwarding), OR
- A keyword match against `closeout`, `close out`, `shutdown procedure`, `end of task`, `vault sweep`, `final summary`, `/new`, etc. (see `session.js` for the full list).

## Troubleshooting

**HUD shows "0 sessions"** — Even App filters host-card sessions by `provider === "claude"` client-side. The bridge reports `provider: "claude"` for that reason; if you've patched it back to `"openclaw"` somewhere, the count breaks. Look at `listSessions()` in `provider.js`.

**HUD shows the prompt then a dead "thinking" spinner** — bridge timeout fired but main session is still working. Default 180s. Either raise `OPENCLAW_PROMPT_TIMEOUT_SECONDS` or use the `[long-task]` prefix on prompts you know will take a while. The reply still lands later via mirror history when you re-enter the session.

**"OpenClaw gateway token not found"** — set `OPENCLAW_GATEWAY_TOKEN` in the bridge's env, or fix the file permissions on `~/.openclaw/openclaw.json` so the bridge can read it.

**"main busy on telegram"** — main session is mid-turn on another channel. Pre-flight busy check is doing its job. Wait a few seconds and try again.

**Empty reply bubble** — `_extractReplyText()` couldn't find the reply field in OpenClaw's response. Probably a future OpenClaw version changed the `sessions_send` response shape. Look at the response with `curl ... /tools/invoke` and add the new field name to `_extractReplyText()`.
