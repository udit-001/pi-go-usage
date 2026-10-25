// OpenCode Go usage provider — auth resolution, the official usage API call,
// and the DeepSeek peak-pricing rule. Everything about *where a Go key comes
// from* and *what the API says* lives here; the meter (meter.ts) only renders.

import type { UsageProvider, UsageState, UsageWindow } from "./usage-providers.ts";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";

const GO_USAGE_URL = "https://opencode.ai/zen/go/v1/usage";
const REQUEST_TIMEOUT_MS = 15_000;

/** Official OpenCode Go spend caps, per window. @see https://opencode.ai/docs/go/ */
const GO_WINDOW_LIMITS_USD = { rolling: 12, weekly: 30, monthly: 60 } as const;

const GO_WINDOW_META = [
  { key: "rolling", label: "5h", limitUsd: GO_WINDOW_LIMITS_USD.rolling },
  { key: "weekly", label: "Weekly", limitUsd: GO_WINDOW_LIMITS_USD.weekly },
  { key: "monthly", label: "Monthly", limitUsd: GO_WINDOW_LIMITS_USD.monthly },
] as const;

const GO_API_KEY_ENV = ["OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"] as const;

/** Footer-status short labels: "5h" stays, "Weekly" → "wk", "Monthly" → "mo". */
const GO_STATUS_TAGS: Record<string, string> = { "5h": "5h", Weekly: "wk", Monthly: "mo" };

export const OPENCODE_GO_LIMITED_HINT =
  "at limit — free models still work; Zen credits if fallback is enabled";

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

function formatCurrency(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
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
    // Strip a UTF-8 BOM — Windows editors may add one and JSON.parse would choke.
    const text = readFileSync(path, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(text) as unknown;
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

/**
 * opencode's auth.json lives at xdgData() + /opencode, where xdgData is
 * $XDG_DATA_HOME else ~/.local/share — on every platform (the CLI uses the
 * xdg-basedir package, which has no platform branching: no ~/Library on macOS,
 * no %APPDATA% on Windows).
 */
function openCodeAuthCandidates(): string[] {
  const candidates: string[] = [];

  // Explicit escape hatch: point at the file directly.
  const override = process.env.OPENCODE_AUTH_FILE?.trim();
  if (override) {
    candidates.push(override);
  }

  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) {
    candidates.push(join(xdg, "opencode", "auth.json"));
  }
  candidates.push(join(homedir(), ".local", "share", "opencode", "auth.json"));
  return candidates;
}

function readOpenCodeAuthFile(): Record<string, unknown> | undefined {
  for (const path of openCodeAuthCandidates()) {
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

/**
 * pi's own auth store, Go entry first. `opencode-go` is the credential that
 * carries a Go subscription; `opencode` may be a web OAuth token whose account
 * has no Go (which would surface as a 403 "no subscription").
 */
async function piStoredKey(): Promise<{ key?: string; source: string } | undefined> {
  const storage = createPiAuthStorage();
  for (const entry of ["opencode-go", "opencode"]) {
    if (storage) {
      try {
        const key = (await storage.getApiKey(entry, { includeFallback: true }))?.trim();
        if (key) {
          return { key, source: `pi-auth#${entry}` };
        }
      } catch {
        // Storage may not recognise this provider name; try the next entry.
      }
    } else {
      const record = readPiAuthFile();
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
  }
  return undefined;
}

export interface GoAuthResolution {
  key?: string;
  source?: string;
}

/** Resolve a Go API key. First hit wins: env → pi auth → opencode CLI auth file. */
export async function resolveGoApiKey(): Promise<GoAuthResolution> {
  const goEnv = firstEnv(GO_API_KEY_ENV);
  if (goEnv) {
    return { key: goEnv.value, source: `env:${goEnv.name}` };
  }

  const stored = await piStoredKey();
  if (stored?.key) {
    return { key: stored.key, source: stored.source };
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

  return {};
}

// ─── Usage fetch + normalization ─────────────────────────────────────────────

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

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
): Promise<UsageState> {
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
    if (status === 401) {
      // Credential present but no longer accepted — lapsed or rotated.
      return {
        state: "expired",
        message: `OpenCode Go rejected the stored credential.${detail ? ` ${detail}` : ""}`,
        reauthHint: "Re-authenticate: run /login opencode inside pi, or refresh OPENCODE_GO_API_KEY.",
      };
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

// ─── DeepSeek peak pricing notice ───────────────────────────────────────────
//
// Four Go models bill at peak/off-peak rates: peak = 01:00–04:00 and
// 06:00–10:00 UTC, Monday–Friday; off-peak is exactly half price. Both the
// model list and the windows are server-side pricing terms that drift —
// check them against https://opencode.ai/docs/go/#usage-limits when this
// misfires. The whole rule hides behind one pure function so callers (and
// tests) never learn the windows, the weekday math, or the wording.

/** DeepSeek Go models billed at peak/off-peak rates. @see https://opencode.ai/docs/go/ */
const DEEPSEEK_PEAK_MODEL_IDS = new Set([
  "deepseek-v4.1-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "deepseek-v4-flash-vision-exp",
]);

/** Peak windows as [startHour, endHour) UTC, Monday–Friday only. */
const DEEPSEEK_PEAK_WINDOWS_UTC: ReadonlyArray<readonly [number, number]> = [
  [1, 4],
  [6, 10],
];

const PEAK_END_FORMAT = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

export interface PeakNotice {
  text: string;
  level: "info" | "warning" | "error";
}

/**
 * Peak-pricing toast for a model switch, or undefined when there is nothing
 * worth saying — non-Go models, non-peak-priced models, off-peak hours, and
 * weekends all stay silent.
 */
export function deepseekPeakNotice(
  model: { provider?: string; id?: string } | undefined,
  now: Date = new Date(),
): PeakNotice | undefined {
  if (model?.provider !== "opencode-go" || typeof model.id !== "string") {
    return undefined;
  }
  if (!DEEPSEEK_PEAK_MODEL_IDS.has(model.id)) {
    return undefined;
  }

  const day = now.getUTCDay();
  if (day === 0 || day === 6) {
    return undefined;
  }
  const hour = now.getUTCHours() + now.getUTCMinutes() / 60;
  for (const [start, end] of DEEPSEEK_PEAK_WINDOWS_UTC) {
    if (hour >= start && hour < end) {
      const endsAt = new Date(now);
      endsAt.setUTCHours(end, 0, 0, 0);
      return {
        text: `DeepSeek peak: 2x until ${PEAK_END_FORMAT.format(endsAt)}. Half price after.`,
        level: "warning",
      };
    }
  }
  return undefined;
}

// ─── Provider ────────────────────────────────────────────────────────────────

/** The OpenCode Go provider as a pluggable UsageProvider. */
export function createOpenCodeGoProvider(): UsageProvider {
  return {
    id: "opencode-go",
    label: "OpenCode Go",
    statusTag: "GO",
    shortWindowLabel: (label) => GO_STATUS_TAGS[label] ?? label,
    limitedHint: OPENCODE_GO_LIMITED_HINT,
    matchesModel: (model) => model?.provider === "opencode-go",
    fetchUsage: async () => {
      const auth = await resolveGoApiKey();
      if (!auth.key) {
        return {
          state: "unconfigured",
          message: "OpenCode Go is not configured on this machine.",
          setupHint:
            "Set OPENCODE_GO_API_KEY (or OPENCODE_API_KEY), sign in with the opencode CLI " +
            "(~/.local/share/opencode/auth.json), or run /login opencode inside pi.",
        };
      }
      const state = await fetchGoUsageState(auth.key);
      if (state.state === "ready") {
        return { ...state, source: auth.source };
      }
      return state;
    },
  };
}
