# pi-go-usage

See how much of your plan is left while you work, without leaving the terminal. `/usage` opens a meter inside pi. OpenCode Go support is built in, and other pi packages add their own providers — [pi-zcode](https://github.com/zorro432/pi-zcode) contributes a ZCode Start Plan tab, so one command covers every plan you're on.

## Install

```bash
pi install git:github.com/udit-001/pi-go-usage
```

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

A second provider (say, pi-zcode installed) turns the header into a tab bar — `Tab` or `←→` switches, and each tab carries a health glyph so you can spot a problem without flipping to it:

```text
────────────────────────────────────────────────────────────────────────
 ← [✓ OpenCode Go] [✓ ZCode Start Plan] →
```

✓ ready · ✕ error · ! stale refresh · … loading

## Use

```bash
/usage
```

`r` refreshes. `q` or `Esc` closes. `/usage close` closes it from the prompt.

## What you get

- **Read one bar per window** — the last 5 hours ($12), the week ($30), the month ($60)
- **Track dollars left** — from used-percent against OpenCode's published caps
- **See reset times** — when each window rolls over
- **Switch providers in tabs** — one tab per installed provider, current data kept per tab
- **Catch peak pricing** — switching to a DeepSeek Go model during peak hours (Mon–Fri, 01:00–04:00 and 06:00–10:00 UTC) warns you're paying 2x and when it ends. Off-peak, weekends, and other models stay silent
- **Read honest failures** — a 403 meaning "no Go subscription" says so and shows how to sign in

## Sign in

Keys resolve in this order, so set any one:

1. `OPENCODE_GO_API_KEY` or `OPENCODE_API_KEY` in the environment
2. the `opencode-go` entry in pi's auth store, or `/login opencode` inside pi
3. the opencode CLI's `auth.json` — `$XDG_DATA_HOME/opencode/auth.json`, else `~/.local/share/opencode/auth.json` (same path on Linux, macOS, and Windows)

## Status bar (optional)

Install [`pi-powerline-footer`](https://github.com/udit-001/pi-powerline-footer) and the provider whose model you're on sits in your bar, its tightest window polled every 5 minutes:

```text
GO 5h 31%     calm (muted)
GO wk 87%     warning (amber)
GO mo limit   capped (red)
```

Switch to a model the meter doesn't cover and the segment clears; `/usage` explains why.

## Your key

Goes to `https://opencode.ai/zen/go/v1/usage` and nowhere else. Nothing is scraped.

## Plug in your own provider

Any pi package can add a usage source. Auth and API calls stay in the contributing package; pi-go-usage only renders. The seam is a `globalThis` registry — pi loads every package's extensions into one process, so there is no npm dependency in either direction and load order doesn't matter:

```ts
(globalThis as any).__piUsageProviders?.register({
  id: "zcode",
  label: "ZCode Start Plan",
  statusTag: "ZC",
  matchesModel: (model) => model?.provider === "zcode",
  fetchUsage: async () => ({
    state: "ready",
    windows: [{ label: "GLM-5.3-Flash", usedPercent: 2.1, statusLabel: "293.6M left" }],
    updatedAt: new Date(),
  }),
});
```

`fetchUsage` returns `{ state: "ready", windows: UsageWindow[] }` or `{ state: "error", message, authHint? }`. Registration is idempotent by `id`; resolve credentials inside `fetchUsage` so credential rotations need no re-registration.

## Develop

`npm install`, then `npm run typecheck`. Types come from the same pi you run, so the extension typechecks against your installed version.
