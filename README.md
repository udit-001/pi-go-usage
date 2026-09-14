# pi-go-usage

See how much of your OpenCode Go plan is left while you work. `/usage` reads OpenCode's official usage API and renders one bar per window: the last 5 hours ($12), the week ($30), the month ($60), with percent used, dollars left, and when each window resets.

## Install

```bash
pi install git:github.com/udit-001/pi-go-usage
```

## Sign in

Keys resolve in this order, so set any one:

1. `OPENCODE_GO_API_KEY` or `OPENCODE_API_KEY` in the environment
2. `~/.local/share/opencode/auth.json`, if you use the opencode CLI
3. `/login opencode` inside pi

## Use

```bash
/usage
```

`r` refreshes. `q` or `Esc` closes. `/usage close` closes it from the prompt.

## What you get

- **Watch three windows** — last 5 hours ($12), the week ($30), the month ($60)
- **Track dollars left** — from used-percent against OpenCode's published caps
- **See reset times** — when each window rolls over
- **Read honest failures** — a 403 that means "no Go subscription" says so and shows how to authenticate

Your key goes to `https://opencode.ai/zen/go/v1/usage` and nowhere else. Nothing is scraped.

## Develop

`npm install`, then `npm run typecheck`. Types come from the same pi you run, so the extension typechecks against your installed version.