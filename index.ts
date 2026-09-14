import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── OpenCode Go Meter ───────────────────────────────────────────────────────
//
// A pi extension that shows how much of your OpenCode Go subscription is left.
//
// OpenCode Go is the flat-rate plan sold at https://opencode.ai/zen/go. Spend is
// metered against three rolling windows — the last 5 hours, the last week, and
// the current month — each with a published dollar cap ($12 / $30 / $60).
//
//   GET https://opencode.ai/zen/go/v1/usage   (Authorization: Bearer <key>)
//
// returns { usage: { rolling|weekly|monthly: { percent, status, resetsAt } } }
// for each window. `percent` is percent *used*, and `status` may be
// "rate-limited". Dollar amounts are *not* in the response — remaining dollars
// are derived from the used-percent against the published caps.
//
// Auth is resolved in this order (first hit wins):
//   1. env OPENCODE_GO_API_KEY, then OPENCODE_API_KEY
//   2. the opencode CLI's auth file — $XDG_DATA_HOME/opencode/auth.json or
//      ~/.local/share/opencode/auth.json — entries "opencode-go", then "opencode"
//   3. pi's own auth store under the "opencode" provider (/login opencode)
//
// Surface: one command. `/usage` opens the meter inline, in place of the
// editor — the same slot and look pi's built-in selectors use (a thin theme
// border top and bottom, no box, no overlay). `/usage close` closes it.
// Inside: r refresh, q/Esc/Ctrl-C close.

const PROVIDER_LABEL = "OpenCode Go";
const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const REQUEST_TIMEOUT_MS = 15_000;
const OPENCODE_AUTH_RELATIVE_PATH = join(".local", "share", "opencode", "auth.json");

/** Official OpenCode Go spend caps, per window. @see https://opencode.ai/docs/go/ */
const GO_WINDOW_LIMITS_USD = { rolling: 12, weekly: 30, monthly: 60 } as const;

const GO_WINDOW_META = [
  { key: "rolling", label: "5h", limitUsd: GO_WINDOW_LIMITS_USD.rolling },
  { key: "weekly", label: "Weekly", limitUsd: GO_WINDOW_LIMITS_USD.weekly },
  { key: "monthly", label: "Monthly", limitUsd: GO_WINDOW_LIMITS_USD.monthly },
] as const;

const GO_API_KEY_ENV = ["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"] as const;

// The meter never renders raw numbers below 2dp, so any key/secret that leaks
// into an error body is scrubbed before it reaches the dialog.
function redactSecrets(text: string, secrets: Array<string | undefined>): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length > 4) {
      out = out.split(secret).join("[redacted]");
    }
  }
  return out;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface UsageWindow {
  label: string;
  /** Percent of the window's dollar cap already spent (0–100). */
  usedPercent?: number;
  statusLabel?: string;
  resetAt?: Date;
}

export type GoUsageState =
  | { state: "ready"; windows: UsageWindow[]; note: string; updatedAt: Date }
  | { state: "error"; message: string; authHint?: string };

export interface GoAuthResolution {
  key?: string;
  source?: string;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// ─── Pure helpers ────────────────────────────────────────────────────────────

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function parseDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

function formatUsedPercent(value: number): string {
  // Keep one decimal below 10% — sub-1% spend is real (0.4% of a window) and
  // must not round to "0% used". Above 10%, integer precision is enough.
  if (value < 10 && value % 1 !== 0) {
    return `${value.toFixed(1)}% used`;
  }
  return `${Math.round(value)}% used`;
}

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatAbsoluteResetTime(resetAt: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(resetAt);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function firstEnv(names: readonly string[]): { value: string; name: string } | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return { value, name };
    }
  }
  return undefined;
}

function readJsonFile(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function extractApiKey(credential: unknown): string | undefined {
  const record = asRecord(credential);
  if (!record) {
    return undefined;
  }
  if (typeof record.key === "string" && record.key.trim().length > 0) {
    return record.key.trim();
  }
  if (typeof record.apiKey === "string" && record.apiKey.trim().length > 0) {
    return record.apiKey.trim();
  }
  return undefined;
}

// ─── Auth resolution ─────────────────────────────────────────────────────────
//
// Everything about *where a Go key can come from* lives here, behind one small
// interface: resolveGoApiKey() → { key?, source? }.

function readOpenCodeAuthFile(): Record<string, unknown> | undefined {
  const xdg = process.env.XDG_DATA_HOME?.trim();
  const candidates = [
    xdg ? join(xdg, "opencode", "auth.json") : undefined,
    join(homedir(), OPENCODE_AUTH_RELATIVE_PATH),
  ].filter((path): path is string => Boolean(path));

  for (const path of candidates) {
    if (!existsSync(path)) {
      continue;
    }
    const parsed = asRecord(readJsonFile(path));
    if (parsed) {
      return parsed;
    }
  }
  return undefined;
}

interface GoAuthStorage {
  getApiKey(provider: string, options?: { includeFallback?: boolean }): Promise<string | undefined>;
}

function createPiAuthStorage(): GoAuthStorage | undefined {
  const factory = (
    PiCodingAgent as { AuthStorage?: { create?: (authPath?: string) => GoAuthStorage } }
  ).AuthStorage;
  return factory?.create ? factory.create() : undefined;
}

function getAgentDirCompat(): string {
  if (typeof PiCodingAgent.getAgentDir === "function") {
    return PiCodingAgent.getAgentDir();
  }
  return join(homedir(), ".pi", "agent");
}

/** Last-resort auth reader: ~/.pi/agent/auth.json (the same file /login writes). */
function readPiAuthFile(): Record<string, unknown> | undefined {
  const authPath = join(getAgentDirCompat(), "auth.json");
  if (!existsSync(authPath)) {
    return undefined;
  }
  const record = asRecord(readJsonFile(authPath));
  return record && typeof record === "object" && !Array.isArray(record) ? record : undefined;
}

function fileKeySource(pathLabel: string, entry: string): string {
  return `${pathLabel}#${entry}`;
}

async function piStoredKey(provider: string): Promise<{ key?: string; source: string } | undefined> {
  const storage = createPiAuthStorage();
  if (storage) {
    const key = (await storage.getApiKey(provider, { includeFallback: true }))?.trim();
    return key ? { key, source: "pi-auth" } : undefined;
  }

  const record = readPiAuthFile();
  for (const entry of ["opencode", "opencode-go"]) {
    const credential = record ? asRecord(record[entry]) : undefined;
    let key: string | undefined;
    if (credential?.type === "oauth" && typeof credential.access === "string") {
      key = credential.access.trim();
    } else {
      key = extractApiKey(credential);
    }
    if (key) {
      return { key, source: `~/.pi/agent/auth.json#${entry}` };
    }
  }
  return undefined;
}

/** Resolve a Go API key. First hit wins: env → opencode CLI auth file → pi auth. */
export async function resolveGoApiKey(): Promise<GoAuthResolution> {
  const goEnv = firstEnv(GO_API_KEY_ENV);
  if (goEnv) {
    return { key: goEnv.value, source: `env:${goEnv.name}` };
  }

  const localAuth = readOpenCodeAuthFile();
  const localGoKey = extractApiKey(localAuth?.["opencode-go"]);
  if (localGoKey) {
    return { key: localGoKey, source: fileKeySource("opencode auth.json", "opencode-go") };
  }
  const localZenKey = extractApiKey(localAuth?.opencode);
  if (localZenKey) {
    return { key: localZenKey, source: fileKeySource("opencode auth.json", "opencode") };
  }

  const stored = await piStoredKey("opencode");
  if (stored?.key) {
    return { key: stored.key, source: stored.source };
  }

  return {};
}

// ─── Usage fetch + normalization ─────────────────────────────────────────────
//
// The deep core. One function, injected fetch for testability. Returns a
// normalized GoUsageState — ready with windows, or error with a human message.

function parseGoUsageWindow(
  payload: Record<string, unknown> | undefined,
  label: string,
  limitUsd: number,
): UsageWindow | undefined {
  const usedPercent = parseNumber(payload?.percent);
  if (usedPercent === undefined) {
    return undefined;
  }

  const clamped = clampPercent(usedPercent);
  const usedUsd = (limitUsd * clamped) / 100;
  const remainingUsd = Math.max(0, limitUsd - usedUsd);
  const rateLimited = payload?.status === "rate-limited";

  return {
    label,
    usedPercent: clamped,
    resetAt: parseDate(payload?.resetsAt),
    statusLabel: rateLimited ? "limited" : `${formatCurrency(remainingUsd)} left`,
  };
}

async function fetchText(
  url: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
): Promise<{ status: number; body: string }> {
  const response = await fetchImpl(url, {
    method: "GET",
    headers,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    redirect: "follow",
  });
  return { status: response.status, body: await response.text() };
}

function sanitizeError(error: unknown, secrets: Array<string | undefined>): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return "OpenCode Go request timed out.";
  }
  if (error instanceof Error && error.message.trim().length > 0) {
    return redactSecrets(error.message.replace(/\s+/g, " ").trim(), secrets);
  }
  return "Unknown OpenCode Go request error.";
}

export async function fetchGoUsageState(
  apiKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<GoUsageState> {
  const secrets = [apiKey];

  let response: { status: number; body: string };
  try {
    response = await fetchText(
      GO_USAGE_URL,
      {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
        "User-Agent": "pi-go-usage",
      },
      fetchImpl,
    );
  } catch (error) {
    return { state: "error", message: sanitizeError(error, secrets) };
  }

  const { status, body } = response;

  if (status === 401 || status === 403) {
    let detail = body.replace(/\s+/g, " ").trim().slice(0, 240);
    try {
      const parsed = JSON.parse(body) as { error?: { message?: unknown }; message?: unknown };
      const message = parsed.error?.message ?? parsed.message;
      if (typeof message === "string" && message.trim().length > 0) {
        detail = message.trim();
      }
    } catch {
      // fall through to raw snippet
    }
    if (status === 403 && /subscription required|entitlement/i.test(detail)) {
      return { state: "error", message: detail || "OpenCode Go subscription required." };
    }
    return {
      state: "error",
      message: detail
        ? `OpenCode Go usage request failed (${status}). ${detail}`
        : `OpenCode Go usage request failed (${status}).`,
    };
  }

  if (status < 200 || status >= 300) {
    return { state: "error", message: `OpenCode Go usage request failed (${status}).` };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = asRecord(JSON.parse(body)) ?? {};
  } catch {
    return { state: "error", message: "OpenCode Go usage response was not valid JSON." };
  }

  const usage = asRecord(parsed.usage);
  if (!usage) {
    return { state: "error", message: "OpenCode Go usage response did not include a usage object." };
  }

  const windows: UsageWindow[] = [];
  for (const meta of GO_WINDOW_META) {
    const window = parseGoUsageWindow(asRecord(usage[meta.key]), meta.label, meta.limitUsd);
    if (window) {
      windows.push(window);
    }
  }

  if (windows.length === 0) {
    return { state: "error", message: "OpenCode Go usage response did not include any usable windows." };
  }

  return {
    state: "ready",
    windows,
    updatedAt: new Date(),
    note: "official GET opencode.ai/zen/go/v1/usage · $12 / $30 / $60 window caps",
  };
}

// ─── Progress bar ────────────────────────────────────────────────────────────
//
// A plain left-to-right fill: the used portion and the remainder are two
// colored runs, built independently and joined. Nothing per-cell, no markers
// or threshold ticks — the percentage text beside the bar is exact, so the
// bar only needs to be a glanceable shape.

type ThemeColorName = Parameters<Theme["fg"]>[0];

export interface ProgressBarOptions {
  /** Bar width in cells. The meter caps this inside its focus band. */
  width: number;
  /** Used percent, 0–100. Values outside the range are clamped. */
  usedPercent: number;
  /** Color of the used portion. Default: accent. */
  filledColor?: ThemeColorName;
  /** Color of the untouched remainder. Default: dim. */
  emptyColor?: ThemeColorName;
}

/**
 * Render a usage bar: `usedPercent`/100 of `width` cells filled, the rest
 * empty, both as single colored runs. Returns ANSI-styled text for one line.
 */
export function renderProgressBar(theme: Theme, options: ProgressBarOptions): string {
  const cells = Math.max(1, Math.floor(options.width));
  const percent = clampPercent(options.usedPercent);
  const filledCells = Math.round((percent / 100) * cells);
  const restCells = cells - filledCells;

  const fill = "█".repeat(filledCells);
  const rest = "░".repeat(restCells);

  // Skip empty runs — an ANSI span with nothing inside is invisible noise.
  const filledRun = filledCells > 0 ? theme.fg(options.filledColor ?? "accent", fill) : "";
  const emptyRun = restCells > 0 ? theme.fg(options.emptyColor ?? "dim", rest) : "";
  return filledRun + emptyRun;
}

// ─── Meter ───────────────────────────────────────────────────────────────────
//
// Renders in the same slot pi's built-in selectors use: in place of the editor,
// full width, with a thin theme border top and bottom — no box, no centering.
// One row per usage window, matching the /usage meter look: a label, a bar
// with "NN% used" pinned to the right, and a dim line beneath with dollars
// left and the absolute reset time.

interface GoUsageMeterOptions {
  theme: Theme;
  onClose: () => void;
  requestRender: () => void;
}

type MeterPhase = "loading" | "ready" | "error";

export class GoUsageMeter {
  private readonly theme: Theme;
  private readonly onClose: () => void;
  private readonly requestRender: () => void;

  private phase: MeterPhase = "loading";
  private state: GoUsageState | undefined;
  private keySource: string | undefined;
  private updatedAt: Date | undefined;
  private refreshError: string | undefined;
  private reloading = false;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(options: GoUsageMeterOptions) {
    this.theme = options.theme;
    this.onClose = options.onClose;
    this.requestRender = options.requestRender;
    void this.reload();
  }

  dispose(): void {
    this.invalidate();
  }

  async reload(): Promise<void> {
    if (this.reloading) {
      this.requestRender();
      return;
    }
    this.reloading = true;
    const hadReady = this.state?.state === "ready";
    if (hadReady) {
      // Keep the last-known-good windows on screen through the refresh — a
      // failed refresh must not blank the meter. Stale truth beats no truth.
      this.phase = "ready";
    } else {
      this.phase = "loading";
      this.state = undefined;
    }
    this.refreshError = undefined;
    this.invalidate();
    this.requestRender();

    try {
      const auth = await resolveGoApiKey();
      if (!auth.key) {
        if (!hadReady) {
          this.phase = "error";
          this.state = {
            state: "error",
            message: "No OpenCode Go API key found.",
            authHint:
              "Set OPENCODE_GO_API_KEY (or OPENCODE_API_KEY), sign in with the opencode CLI " +
              "(~/.local/share/opencode/auth.json), or run /login opencode inside pi.",
          };
        } else {
          this.refreshError = "no API key";
        }
        return;
      }
      this.keySource = auth.source;
      const next = await fetchGoUsageState(auth.key);
      if (next.state === "ready") {
        this.state = next;
        this.phase = "ready";
        this.updatedAt = next.updatedAt;
        this.refreshError = undefined;
      } else if (hadReady) {
        this.refreshError = next.message;
        this.phase = "ready";
      } else {
        this.state = next;
        this.phase = "error";
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (hadReady || this.state?.state === "ready") {
        this.refreshError = message;
        this.phase = "ready";
      } else {
        this.phase = "error";
        this.state = { state: "error", message };
      }
    } finally {
      this.reloading = false;
      this.invalidate();
      this.requestRender();
    }
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, Key.ctrl("c"))) {
      this.onClose();
      return;
    }
    if (matchesKey(data, "r")) {
      void this.reload();
    }
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const theme = this.theme;
    const lines: string[] = [];
    // Nothing in the meter spans the terminal. The windows live in a bounded
    // focus band; the eye scans within it vertically (label column, bar column,
    // % column all line up) instead of sweeping the full width.
    const METER_WIDTH = 72;
    const LABEL_COL = 9;
    const BAR_WIDTH = 30;
    const panelWidth = Math.max(10, Math.min(width, METER_WIDTH));
    const contentWidth = Math.max(10, panelWidth - 2);
    const pad = " ";

    const addBorder = () => {
      lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));
    };
    const addLine = (value = "") => {
      lines.push(`${pad}${truncateToWidth(value, contentWidth, "")}`);
    };
    const addBlank = () => lines.push(pad);
    const addWrapped = (value: string, indent = "") => {
      const availableWidth = Math.max(1, contentWidth - indent.length);
      for (const wrapped of wrapTextWithAnsi(value, availableWidth)) {
        addLine(`${indent}${wrapped}`);
      }
    };
    const addWindowRow = (usageWindow: UsageWindow, usedPercent: number, money?: string, moneyIsError = false) => {
      const barWidth = Math.max(12, Math.min(BAR_WIDTH, contentWidth - LABEL_COL - 12));
      const labelText = truncateToWidth(usageWindow.label, LABEL_COL, "…").padEnd(LABEL_COL);
      const pctText = formatUsedPercent(usedPercent).padStart(9);
      const bar = renderProgressBar(theme, {
        width: barWidth,
        usedPercent,
        filledColor: usedPercent >= 90 ? "error" : usedPercent >= 75 ? "warning" : "accent",
        emptyColor: "dim",
      });
      addLine(`${theme.fg("text", theme.bold(labelText))} ${bar}  ${theme.fg("muted", pctText)}`);

      const moneyText = moneyIsError ? "limited" : money;
      if (moneyText) {
        const parts = [theme.fg(moneyIsError ? "error" : "accent", moneyText)];
        if (usageWindow.resetAt instanceof Date) {
          parts.push(theme.fg("dim", `resets ${formatAbsoluteResetTime(usageWindow.resetAt)}`));
        }
        addLine(`${" ".repeat(LABEL_COL + 1)}${parts.join(" · ")}`);
      } else if (usageWindow.resetAt instanceof Date) {
        addLine(`${" ".repeat(LABEL_COL + 1)}${theme.fg("dim", `resets ${formatAbsoluteResetTime(usageWindow.resetAt)}`)}`);
      }
    };

    // Header
    addBorder();
    addLine(theme.fg("accent", theme.bold(PROVIDER_LABEL)));
    addBlank();

    // Body
    if (this.phase === "loading") {
      addWrapped(theme.fg("warning", "Fetching usage…"));
      addBlank();
    } else if (this.phase === "error") {
      const errorState = this.state && this.state.state === "error" ? this.state : undefined;
      addWrapped(theme.fg("error", errorState?.message ?? "Go usage is unavailable right now."));
      if (errorState?.authHint) {
        addWrapped(theme.fg("dim", errorState.authHint));
      }
      addBlank();
    } else {
      const readyState = this.state && this.state.state === "ready" ? this.state : undefined;
      const windows = readyState?.windows ?? [];
      for (const usageWindow of windows) {
        const usedPercent = usageWindow.usedPercent ?? 0;
        const limited = usageWindow.statusLabel === "limited";
        addWindowRow(usageWindow, usedPercent, usageWindow.statusLabel, limited);
        addBlank();
      }

      // Failure-path language: what does a red window actually mean?
      if (windows.some((w) => w.statusLabel === "limited")) {
        addLine(theme.fg("dim", "at limit — free models still work; Zen credits if fallback is enabled"));
      }
      // Resilience: a failed refresh keeps the last-good data and says so.
      if (this.refreshError) {
        const when = this.updatedAt instanceof Date ? `from ${this.updatedAt.toLocaleTimeString()}` : "from earlier";
        const why = this.refreshError.length > 48 ? `${this.refreshError.slice(0, 48)}…` : this.refreshError;
        addLine(theme.fg("warning", `refresh failed (${why}) — showing data ${when}`));
      }
    }

    // Provenance and hints, dim and out of the way.
    const provenance = [
      this.keySource ? `key: ${this.keySource}` : undefined,
      this.updatedAt instanceof Date ? `updated ${this.updatedAt.toLocaleTimeString()}` : undefined,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" ");
    if (provenance) {
      addLine(theme.fg("dim", provenance));
    }
    if (this.state?.state === "ready" && this.state.note) {
      addLine(theme.fg("dim", this.state.note));
    }
    addLine(theme.fg("dim", "r refresh · q / Esc close"));
    addBorder();

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// ─── Command wiring ──────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  let meterOpen = false;
  let closeMeter: (() => void) | null = null;

  const showMeter = async (args: string, ctx: ExtensionCommandContext) => {
    if (ctx.mode !== "tui") {
      ctx.ui.notify("The usage meter requires TUI mode", "error");
      return;
    }

    if (args.trim().toLowerCase() === "close") {
      closeMeter?.();
      return;
    }

    if (meterOpen) {
      ctx.ui.notify("OpenCode Go meter is already open. Press q or Esc to close it.", "info");
      return;
    }

    let meter: GoUsageMeter | undefined;

    void ctx.ui
      .custom<void>((tui, theme, _keybindings, done) => {
        meterOpen = true;
        closeMeter = () => done(undefined);

        // Inline, in place of the editor — the same slot pi's built-in
        // selectors (like the model picker) render into.
        meter = new GoUsageMeter({
          theme,
          onClose: () => done(undefined),
          requestRender: () => tui.requestRender(),
        });

        return {
          render(width: number) {
            return meter?.render(width) ?? [];
          },
          invalidate() {
            meter?.invalidate();
          },
          handleInput(data: string) {
            meter?.handleInput(data);
            tui.requestRender();
          },
        };
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Failed to open the OpenCode Go meter: ${message}`, "error");
      })
      .finally(() => {
        meter?.dispose();
        meterOpen = false;
        closeMeter = null;
      });
  };

  pi.registerCommand("usage", {
    description: "Show OpenCode Go usage (5h / weekly / monthly) inline. /usage close to dismiss.",
    handler: showMeter,
  });
}