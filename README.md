# pi-go-usage

See how much of your OpenCode Go plan is left while you work: one bar per window, the last 5 hours ($12), the week ($30), the month ($60), with percent used, dollars left, and when each window resets.

## What it looks like

`/usage` — three windows, one row each:

```text
────────────────────────────────────────────────────────────────────────
 OpenCode Go

 5h        █████████████░░░░░░░░░░░░░░░░░   42% used
          $6.96 left · resets Oct 9, 4:37 PM UTC

 Weekly    ██████████████████████████░░░░   88% used
          $3.60 left · resets Oct 11, 4:37 PM UTC

 Monthly   ███████████████████░░░░░░░░░░░   64% used
          $21.60 left · resets Oct 20, 4:37 PM UTC

 key: pi-auth#opencode-go · updated 2:37 PM
 r refresh · q / Esc close
────────────────────────────────────────────────────────────────────────
```

With the footer, the tightest window rides in your status bar, the color escalating as it climbs:

```text
GO 5h 31%     calm (muted)
GO wk 87%     warning (amber)
GO mo limit   capped (red)
```

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

Install [`pi-powerline-footer`](https://github.com/udit-001/pi-powerline-footer) and the tightest window rides in your bar while you're on an opencode-go model (the states are pictured above). It refreshes every 5 minutes. Non-Go models, a missing key, or a dead API show nothing; `/usage` explains why. The meter and the bar work independently.

## Develop

`npm install`, then `npm run typecheck`. Types come from the same pi you run, so the extension typechecks against your installed version.