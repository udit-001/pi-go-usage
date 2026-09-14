# pi-go-usage

See how much of your OpenCode Go plan is left while you work: one bar per window, the last 5 hours ($12), the week ($30), the month ($60), with percent used, dollars left, and when each window resets.

## Install

```bash
pi install git:github.com/udit-001/pi-go-usage
```

## What you get

- **Read one bar per window** — last 5 hours ($12), the week ($30), the month ($60)
- **Track dollars left** — from used-percent against OpenCode's published caps
- **See reset times** — when each window rolls over
- **Read honest failures** — a 403 meaning "no Go subscription" says so and shows how to sign in

Your key goes to `https://opencode.ai/zen/go/v1/usage` and nowhere else. Nothing is scraped.

## Sign in

Keys resolve in this order, so set any one:

1. `OPENCODE_GO_API_KEY` or `OPENCODE_API_KEY` in the environment
2. the `opencode-go` entry in pi's auth store, or `/login opencode` inside pi
3. the opencode CLI's `auth.json` — `$XDG_DATA_HOME/opencode/auth.json`, else `~/.local/share/opencode/auth.json` (same path on Linux, macOS, and Windows)

## Use

```bash
/usage
```

`r` refreshes. `q` or `Esc` closes. `/usage close` closes it from the prompt.

## Status bar (optional)

With [`pi-powerline-footer`](https://github.com/udit-001/pi-powerline-footer) installed, the tightest window's usage sits in your bar while you run an opencode-go model:

- `GO 5h 31%` (muted) — current usage, tightest of the three windows
- `GO wk 87%` (amber) — a window has crossed 75%
- `GO wk limit` (red) — a window has capped you

Refreshes every 5 minutes. Non-Go models, a missing key, or a dead API show nothing; `/usage` explains why. The meter and the bar work independently.

## Develop

`npm install`, then `npm run typecheck`. Types come from the same pi you run, so the extension typechecks against your installed version.