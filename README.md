# openclaw-glasses-bridge

Run [OpenClaw](https://openclaw.ai) on [Even Realities G2](https://www.evenrealities.com) smart glasses via Even Terminal Mode.

Your OpenClaw `main` session paints live on the G2 HUD. Voice prompt from the glasses goes in, the reply is rendered on the HUD as it lands, and the same conversation continues on whatever channel you already use (Telegram, Discord, Signal, etc.).

One brain, two surfaces.

## How it works

[Even Terminal](https://www.npmjs.com/package/@evenrealities/even-terminal) is Even Realities' official bridge between the Even App on your phone and a coding-agent CLI on a host machine. Out of the box it ships providers for Claude Code and Codex.

This repo is a light fork that adds a third provider: **OpenClaw**.

```
G2 glasses (voice + HUD)
        |
        |  BLE
        v
Even App on phone (Terminal Mode)
        |
        |  HTTP over Tailscale (or LAN)
        v
Even Terminal bridge (this fork)  -- port 3457
        |
        |  POST /tools/invoke  { tool: "sessions_send", args: { sessionKey: "main", ... } }
        v
OpenClaw gateway   (your local OpenClaw install)
        |
        v
OpenClaw main agent  --->  reply
        |
        |  reply text streamed back as SSE text_delta
        v
HUD bubble on glasses
```

The bridge exposes the same provider interface Even Terminal already speaks (`listSessions`, `getSessionStatus`, `prompt`, `getHistory`, etc.) but routes every call into OpenClaw's `sessions_send` tool against a single synthetic session id (`openclaw-main`). The Even App is happy because the wire shape is identical; OpenClaw is happy because it sees a normal inter-session message.

## What you get

- Voice-in from the glasses, reply painted on the HUD in real time
- Conversation history mirrored to your other OpenClaw channels (Telegram by default) so the thread continues seamlessly between surfaces
- A persistent `openclaw-main` session that survives bridge restarts (history is JSONL-backed)
- Optional long-task timeout (10 min default) for closeout / build / sweep style prompts triggered by keywords or `[long-task]` prefix
- Pre-flight busy check so the glasses don't deadlock when main is mid-Telegram turn

## What it does NOT do

- HUD-side approval cards (exec approvals still land on your other channel)
- True token-streaming (reply is one `text_delta` chunk per turn — OpenClaw doesn't yet expose a streaming runtime hook)
- Audio output (G2 has a speaker but Even Terminal Mode is text-only on the HUD)

## Setup

See [SETUP.md](./SETUP.md) for the full recipe. Roughly:

1. Install `@evenrealities/even-terminal` globally (`npm i -g @evenrealities/even-terminal`)
2. Drop the 4 files in `src/openclaw/` into the installed package's `dist/openclaw/`
3. Apply the 2 unified diffs in `patches/` to the installed package's `dist/routes/core.js` and `dist/session.js`
4. Add the required keys to your `~/.openclaw/openclaw.json`
5. Start the bridge with `DEFAULT_PROVIDER=openclaw even-terminal --port 3457 --tailscale ...`
6. Pair from the Even App (host enrollment QR)

## Requirements

- OpenClaw 2026.4.25 or newer (this is what the `sessions_send` response shape was tested against; older versions may need an `_extractReplyText` tweak)
- Node 18+
- Even Realities G2 glasses paired with the Even App, Terminal Mode enabled
- Reachability between the phone and the bridge host: Tailscale, same LAN, or any tunnel you like

## License

MIT. See [LICENSE](./LICENSE).

This is a derivative work of `@evenrealities/even-terminal`. The upstream package is © Even Realities and shipped under its own license; this repo only contains the additional/modified code, not the upstream source itself. You install upstream via npm and patch on top.

## Status

Working for the maintainer's daily use. Filed under "share if useful, don't expect support" but issues + PRs welcome.
