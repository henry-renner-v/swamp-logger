#!/usr/bin/env -S deno run --allow-read
/**
 * swamp-logger audit — summarize the telemetry swamp-logger has captured.
 *
 * A standalone CONSUMER of the swamp-logger event store: it reads the immutable per-event
 * files written by `swamp_logger.ts` (see PROTOCOL.md) and produces an audit — what the
 * `swamp` CLI phoned home: which commands ran, the stable identifiers that fingerprint you
 * and your repos, environment, and whether an AI agent was driving.
 *
 * It has no swamp dependency and no swamp-logger runtime dependency: it depends only on the
 * documented on-disk schema (PROTOCOL.md). Other consumers (a DB sink, a dashboard) are
 * separate in exactly the same way — this is just the first one.
 *
 * Library use (e.g. a thin swamp model/report wrapper):
 *     import { auditDir, auditRecords, renderMarkdown } from "./audit.ts";
 *     const { markdown, json } = await auditDir("./events");
 *
 * CLI use:
 *     deno run --allow-read audit.ts ./events           # markdown (default)
 *     deno run --allow-read audit.ts ./events --json     # machine-readable JSON
 */

/** One persisted record, as written by swamp_logger.ts. See PROTOCOL.md "On-disk layout". */
interface EventRecord {
  receivedAt?: string;
  endpointPath?: string;
  userAgent?: string;
  event?: {
    event?: string;
    distinct_id?: string;
    properties?: {
      id?: string;
      invocation?: { command?: string; args?: unknown[]; optionKeys?: string[] };
      result?: { status?: string; exitCode?: number };
      startedAt?: string;
      completedAt?: string;
      durationMs?: number;
      swampVersion?: string;
      denoVersion?: string;
      platform?: string;
      invocationContext?: {
        agentSessionDetected?: boolean;
        isInteractive?: boolean;
        externalDatastoreConfigured?: boolean;
        configuredAiTools?: string[];
        detectedAiTool?: string | null;
      };
      [k: string]: unknown;
    };
  };
  /** Present instead of `event` for payloads swamp-logger could not parse (events/raw/). */
  raw?: string;
}

/** Structured audit result — the machine-readable half (also the report JSON). */
export interface Audit {
  eventCount: number;
  rawCount: number;
  timeRange: { first: string | null; last: string | null };
  commands: Record<string, number>;
  results: Record<string, number>;
  optionKeys: string[];
  fingerprint: { distinctIds: string[]; repoIds: string[] };
  environment: { swampVersions: string[]; denoVersions: string[]; platforms: string[] };
  context: {
    agentSessionDetected: Record<string, number>;
    isInteractive: Record<string, number>;
    detectedAiTools: string[];
    configuredAiTools: string[];
    externalDatastoreConfigured: Record<string, number>;
  };
  failures: Array<{ command: string; status: string; exitCode: number; at: string | null }>;
  findings: string[];
}

const uniq = <T>(xs: T[]): T[] => [...new Set(xs)].sort();
const tally = (xs: string[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const x of xs) out[x] = (out[x] ?? 0) + 1;
  return out;
};
const when = (r: EventRecord): string | null =>
  r.event?.properties?.completedAt ?? r.event?.properties?.startedAt ?? r.receivedAt ?? null;

/** Aggregate already-loaded records into an audit. Pure — no I/O. */
export function auditRecords(records: EventRecord[]): Audit {
  const events = records.filter((r) => r.event?.properties);
  const props = events.map((r) => r.event!.properties!);
  const ctx = props.map((p) => p.invocationContext).filter((c): c is NonNullable<typeof c> => !!c);

  const stamps = events.map(when).filter((s): s is string => !!s).sort();
  const distinctIds = uniq(events.map((r) => r.event!.distinct_id).filter((x): x is string => !!x));
  const repoIds = uniq(props.map((p) => p["$repo_id"] as string).filter((x) => !!x));
  const aiTools = uniq(ctx.flatMap((c) => c.configuredAiTools ?? []));
  const agentRuns = ctx.filter((c) => c.agentSessionDetected === true).length;

  const findings: string[] = [];
  if (distinctIds.length) {
    findings.push(
      `Stable user identifier present: ${distinctIds.length} distinct \`distinct_id\` across ` +
        `${events.length} event(s) — links every captured command back to you.`,
    );
  }
  if (repoIds.length) {
    findings.push(`${repoIds.length} repository fingerprinted via \`$repo_id\`.`);
  }
  findings.push(
    `Every command name is recorded: ${
      Object.keys(tally(props.map((p) => p.invocation?.command ?? "?"))).length
    } ` +
      `distinct command(s) over ${events.length} invocation(s).`,
  );
  if (ctx.length) {
    findings.push(
      `AI-agent driving detected in ${agentRuns}/${ctx.length} invocation(s)` +
        (aiTools.length ? ` (configured tools: ${aiTools.join(", ")}).` : "."),
    );
  }
  const rawCount = records.filter((r) => r.raw !== undefined).length;
  if (rawCount) findings.push(`${rawCount} unparsed payload(s) captured under events/raw/.`);

  return {
    eventCount: events.length,
    rawCount,
    timeRange: { first: stamps[0] ?? null, last: stamps[stamps.length - 1] ?? null },
    commands: tally(props.map((p) => p.invocation?.command ?? "?")),
    results: tally(props.map((p) => p.result?.status ?? "?")),
    optionKeys: uniq(props.flatMap((p) => p.invocation?.optionKeys ?? [])),
    fingerprint: { distinctIds, repoIds },
    environment: {
      swampVersions: uniq(props.map((p) => p.swampVersion).filter((x): x is string => !!x)),
      denoVersions: uniq(props.map((p) => p.denoVersion).filter((x): x is string => !!x)),
      platforms: uniq(props.map((p) => p.platform).filter((x): x is string => !!x)),
    },
    context: {
      agentSessionDetected: tally(ctx.map((c) => String(c.agentSessionDetected))),
      isInteractive: tally(ctx.map((c) => String(c.isInteractive))),
      detectedAiTools: uniq(ctx.map((c) => c.detectedAiTool ?? "").filter((x) => !!x)),
      configuredAiTools: aiTools,
      externalDatastoreConfigured: tally(ctx.map((c) => String(c.externalDatastoreConfigured))),
    },
    failures: props
      .filter((p) => p.result && p.result.status !== "success")
      .map((p) => ({
        command: p.invocation?.command ?? "?",
        status: p.result?.status ?? "?",
        exitCode: p.result?.exitCode ?? -1,
        at: p.completedAt ?? p.startedAt ?? null,
      })),
    findings,
  };
}

/** Recursively load every `*.json` event record under `dir`. */
export async function loadRecords(dir: string): Promise<EventRecord[]> {
  const out: EventRecord[] = [];
  const walk = async (d: string): Promise<void> => {
    let entries: Deno.DirEntry[];
    try {
      entries = [...Deno.readDirSync(d)];
    } catch {
      return; // missing/inaccessible dir → no records
    }
    for (const e of entries) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory) await walk(p);
      else if (e.isFile && e.name.endsWith(".json")) {
        try {
          out.push(JSON.parse(await Deno.readTextFile(p)) as EventRecord);
        } catch { /* skip a corrupt/partial file rather than abort the whole audit */ }
      }
    }
  };
  await walk(dir);
  return out;
}

const table = (header: [string, string], rows: [string, string | number][]): string =>
  rows.length === 0 ? "_(none)_" : [
    `| ${header[0]} | ${header[1]} |`,
    `| --- | --- |`,
    ...rows.map(([k, v]) => `| ${k} | ${v} |`),
  ].join("\n");

/** Render an audit as human-readable markdown (the report markdown half). */
export function renderMarkdown(a: Audit): string {
  const sortedCounts = (m: Record<string, number>): [string, number][] =>
    Object.entries(m).sort((x, y) => y[1] - x[1]);
  const range = a.timeRange.first ? `${a.timeRange.first} → ${a.timeRange.last}` : "—";
  return [
    `# swamp telemetry audit`,
    ``,
    `**${a.eventCount}** event(s) captured${a.rawCount ? ` (+${a.rawCount} unparsed)` : ""} · ` +
    `window ${range}`,
    ``,
    `## What it phones home`,
    ``,
    a.findings.length ? a.findings.map((f) => `- ${f}`).join("\n") : "_(nothing captured)_",
    ``,
    `## Commands run`,
    ``,
    table(["command", "count"], sortedCounts(a.commands)),
    ``,
    `## Results`,
    ``,
    table(["status", "count"], sortedCounts(a.results)),
    ``,
    `## Fingerprint (stable identifiers)`,
    ``,
    table(["identifier", "distinct values"], [
      ["distinct_id (user)", a.fingerprint.distinctIds.length],
      ["$repo_id (repository)", a.fingerprint.repoIds.length],
    ]),
    ``,
    `## Environment`,
    ``,
    table(["field", "values"], [
      ["swampVersion", a.environment.swampVersions.join(", ") || "—"],
      ["denoVersion", a.environment.denoVersions.join(", ") || "—"],
      ["platform", a.environment.platforms.join(", ") || "—"],
    ]),
    ``,
    `## Session context`,
    ``,
    table(["signal", "values"], [
      ["agentSessionDetected", JSON.stringify(a.context.agentSessionDetected)],
      ["isInteractive", JSON.stringify(a.context.isInteractive)],
      ["configuredAiTools", a.context.configuredAiTools.join(", ") || "—"],
      ["detectedAiTool", a.context.detectedAiTools.join(", ") || "—"],
      ["externalDatastoreConfigured", JSON.stringify(a.context.externalDatastoreConfigured)],
    ]),
    ``,
    `## Option keys seen`,
    ``,
    a.optionKeys.length ? a.optionKeys.map((k) => `\`${k}\``).join(" · ") : "_(none)_",
    ``,
    ...(a.failures.length
      ? [
        `## Failed invocations`,
        ``,
        table(
          ["command", "status / exit"],
          a.failures.map((f) => [
            f.command,
            `${f.status} (${f.exitCode})`,
          ]),
        ),
        ``,
      ]
      : []),
  ].join("\n");
}

/** Load + audit a directory, returning both report halves. */
export async function auditDir(dir: string): Promise<{ markdown: string; json: Audit }> {
  const json = auditRecords(await loadRecords(dir));
  return { markdown: renderMarkdown(json), json };
}

async function main(): Promise<void> {
  const args = Deno.args.filter((a) => a !== "--json");
  const asJson = Deno.args.includes("--json");
  const dir = args[0] ?? "./events";
  const { markdown, json } = await auditDir(dir);
  console.log(asJson ? JSON.stringify(json, null, 2) : markdown);
}

if (import.meta.main) await main();
