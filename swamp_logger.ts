#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env
/**
 * swamp-logger — capture, persist, and forward the telemetry the `swamp` CLI emits.
 *
 * The `swamp` CLI sends product analytics (PostHog-style `cli_invocation` events) to its
 * telemetry endpoint by default. swamp lets you override that endpoint per-repo via the
 * `telemetryEndpoint:` field in `.swamp.yaml`. Point it at this listener:
 *
 *     # .swamp.yaml
 *     telemetryEndpoint: http://127.0.0.1:8099
 *
 * On each telemetry batch (`POST /ingest`) this process:
 *   1. splits the batch into individual events,
 *   2. (default) writes ONE immutable file per event
 *      (events/YYYY/MM/DD/<timestamp>__<id8>.json) — write-once, git-friendly,
 *   3. (optional) POSTs each event record to a `--sink` URL — a generic "send a message per
 *      captured event" hook, so persistence backends (a git repo, a database, the cluster…)
 *      live in a separate receiver, not in this tool,
 *   4. forwards the original batch upstream unchanged (so nothing changes for swamp-club).
 *
 * It is tool-agnostic: it knows the swamp telemetry shape but has no swamp dependency, and it
 * knows nothing about any particular persistence backend. Zero third-party dependencies.
 *
 * See PROTOCOL.md for the event schema.
 */

interface Config {
  host: string;
  port: number;
  /** Directory under which per-event files are written (when `files` is true). */
  outDir: string;
  /** Write one immutable file per event to `outDir`. */
  files: boolean;
  /** Optional URL to POST each event record to (empty = disabled). */
  sink: string;
  /** Upstream base URL to forward batches to (path/query are preserved). */
  upstream: string;
  /** When false, capture only — do not forward upstream. */
  forward: boolean;
}

const DEFAULT_UPSTREAM = "https://telemetry.swamp-club.com";

function parseConfig(): Config {
  const flags = new Map<string, string>();
  const argv = Deno.args;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) flags.set(a.slice(2, eq), a.slice(eq + 1));
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) {
        flags.set(a.slice(2), argv[++i]);
      } else flags.set(a.slice(2), "true");
    }
  }
  const env = (k: string) => Deno.env.get(k);
  const off = (v: string | undefined) => v === "false" || v === "0";
  const forwardRaw = flags.get("forward") ?? env("SWAMP_LOGGER_FORWARD");
  const filesRaw = flags.get("files") ?? env("SWAMP_LOGGER_FILES");
  return {
    host: flags.get("host") ?? env("SWAMP_LOGGER_HOST") ?? "127.0.0.1",
    port: Number(flags.get("port") ?? env("SWAMP_LOGGER_PORT") ?? "8099"),
    outDir: flags.get("out") ?? env("SWAMP_LOGGER_OUT") ?? "./events",
    files: !(flags.has("no-files") || off(filesRaw)),
    sink: flags.get("sink") ?? env("SWAMP_LOGGER_SINK") ?? "",
    upstream: (flags.get("upstream") ?? env("SWAMP_LOGGER_UPSTREAM") ?? DEFAULT_UPSTREAM).replace(
      /\/+$/,
      "",
    ),
    forward: !(flags.has("no-forward") || off(forwardRaw)),
  };
}

/** ISO timestamp → filesystem-safe (`:` is illegal/awkward on many filesystems). */
function safeStamp(iso: string): string {
  return iso.replace(/:/g, "-");
}

interface SwampEvent {
  event?: string;
  distinct_id?: string;
  properties?: {
    id?: string;
    completedAt?: string;
    startedAt?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

interface Meta {
  receivedAt: string;
  endpointPath: string;
  userAgent: string;
}

/** The unit we persist/emit: provenance metadata wrapping the verbatim event. */
function buildRecord(ev: SwampEvent, meta: Meta) {
  return { ...meta, event: ev };
}

async function writeEventFile(cfg: Config, ev: SwampEvent, meta: Meta): Promise<void> {
  const stampIso = ev.properties?.completedAt ?? ev.properties?.startedAt ?? meta.receivedAt;
  const parsed = new Date(stampIso);
  const day = isNaN(parsed.getTime()) ? new Date(meta.receivedAt) : parsed;
  const yyyy = String(day.getUTCFullYear());
  const mm = String(day.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(day.getUTCDate()).padStart(2, "0");
  const id = ev.properties?.id ?? ev.distinct_id ?? crypto.randomUUID();
  const id8 = id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 8);
  const dir = `${cfg.outDir}/${yyyy}/${mm}/${dd}`;
  await Deno.mkdir(dir, { recursive: true });
  const path = `${dir}/${safeStamp(stampIso)}__${id8}.json`;
  await Deno.writeTextFile(path, JSON.stringify(buildRecord(ev, meta), null, 2) + "\n");
}

/** Fire-and-forget POST of a JSON body; never throws into the request path. */
function postJson(target: string, body: string, label: string): void {
  fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body })
    .then((r) => r.body?.cancel())
    .catch((e) => console.error(`[swamp-logger] ${label} to ${target} failed:`, e.message));
}

async function persist(cfg: Config, bytes: Uint8Array, req: Request, url: URL): Promise<number> {
  const text = new TextDecoder().decode(bytes);
  const meta: Meta = {
    receivedAt: new Date().toISOString(),
    endpointPath: url.pathname,
    userAgent: req.headers.get("user-agent") ?? "",
  };
  let events: SwampEvent[] | null = null;
  try {
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.events)) events = parsed.events as SwampEvent[];
  } catch { /* not JSON / unexpected shape — fall through to raw */ }

  if (events) {
    for (const ev of events) {
      if (cfg.files) await writeEventFile(cfg, ev, meta);
      if (cfg.sink) postJson(cfg.sink, JSON.stringify(buildRecord(ev, meta)), "sink");
    }
    return events.length;
  }
  // Fallback: never lose a payload we couldn't parse into events.
  const rawRecord = JSON.stringify({ ...meta, raw: text }, null, 2);
  if (cfg.files) {
    const dir = `${cfg.outDir}/raw`;
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(`${dir}/${safeStamp(meta.receivedAt)}.json`, rawRecord + "\n");
  }
  if (cfg.sink) postJson(cfg.sink, rawRecord, "sink");
  return 0;
}

function forward(cfg: Config, body: ArrayBuffer, req: Request, url: URL): void {
  if (!cfg.forward) return;
  const target = `${cfg.upstream}${url.pathname}${url.search}`;
  fetch(target, {
    method: req.method,
    headers: {
      "content-type": req.headers.get("content-type") ?? "application/json",
      "user-agent": req.headers.get("user-agent") ?? "swamp-logger",
    },
    body,
  })
    .then((r) => r.body?.cancel())
    .catch((e) => console.error(`[swamp-logger] forward to ${target} failed:`, e.message));
}

function main() {
  const cfg = parseConfig();
  console.error(
    `[swamp-logger] listening on http://${cfg.host}:${cfg.port} → ` +
      `files=${cfg.files ? cfg.outDir : "off"} sink=${cfg.sink || "off"} ` +
      `forward=${cfg.forward ? cfg.upstream : "off"}`,
  );
  Deno.serve({ hostname: cfg.host, port: cfg.port }, async (req) => {
    const url = new URL(req.url);
    const ab = await req.arrayBuffer();
    try {
      const n = await persist(cfg, new Uint8Array(ab), req, url);
      console.error(`[swamp-logger] ${req.method} ${url.pathname} → ${n} event(s)`);
    } catch (e) {
      console.error(`[swamp-logger] persist failed:`, (e as Error).message);
    }
    // Fire-and-forget so swamp's telemetry sender is never blocked or made to fail.
    forward(cfg, ab, req, url);
    return new Response(null, { status: 200, headers: { "content-length": "0" } });
  });
}

if (import.meta.main) main();
