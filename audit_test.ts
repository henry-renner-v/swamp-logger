/**
 * Unit tests for the audit core. Schema fixtures mirror PROTOCOL.md; if these drift from the
 * real event shape, the audit is wrong — so they double as a schema-conformance check.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";
import { auditRecords, renderMarkdown } from "./audit.ts";

// deno-lint-ignore no-explicit-any
const rec = (props: Record<string, unknown>, distinct = "user-1"): any => ({
  receivedAt: "2026-06-12T01:00:00.000Z",
  endpointPath: "/ingest",
  userAgent: "swamp-cli/test",
  event: { event: "cli_invocation", distinct_id: distinct, properties: props },
});

Deno.test("aggregates commands, results, and the failure list", () => {
  const a = auditRecords([
    rec({ invocation: { command: "model" }, result: { status: "success", exitCode: 0 } }),
    rec({ invocation: { command: "doctor" }, result: { status: "success", exitCode: 0 } }),
    rec({ invocation: { command: "doctor" }, result: { status: "user_error", exitCode: 1 } }),
  ]);
  assertEquals(a.eventCount, 3);
  assertEquals(a.commands, { model: 1, doctor: 2 });
  assertEquals(a.results, { success: 2, user_error: 1 });
  assertEquals(a.failures.length, 1);
  assertEquals(a.failures[0], { command: "doctor", status: "user_error", exitCode: 1, at: null });
});

Deno.test("collects the fingerprint across events", () => {
  const a = auditRecords([
    rec({ invocation: { command: "a" }, $repo_id: "repo-1" }, "user-1"),
    rec({ invocation: { command: "b" }, $repo_id: "repo-2" }, "user-1"),
  ]);
  assertEquals(a.fingerprint.distinctIds, ["user-1"]);
  assertEquals(a.fingerprint.repoIds, ["repo-1", "repo-2"]);
});

Deno.test("tallies invocationContext signals and AI tools", () => {
  const a = auditRecords([
    rec({
      invocation: { command: "x" },
      invocationContext: { agentSessionDetected: true, configuredAiTools: ["claude"] },
    }),
    rec({
      invocation: { command: "y" },
      invocationContext: { agentSessionDetected: false, configuredAiTools: ["claude"] },
    }),
  ]);
  assertEquals(a.context.agentSessionDetected, { "true": 1, "false": 1 });
  assertEquals(a.context.configuredAiTools, ["claude"]);
});

Deno.test("counts unparsed raw records separately from events", () => {
  const a = auditRecords([
    rec({ invocation: { command: "model" }, result: { status: "success", exitCode: 0 } }),
    // deno-lint-ignore no-explicit-any
    { receivedAt: "2026-06-12T01:00:00.000Z", endpointPath: "/", raw: "" } as any,
  ]);
  assertEquals(a.eventCount, 1);
  assertEquals(a.rawCount, 1);
});

Deno.test("documented schema yields no untracked fields (forward-compat canary)", () => {
  const a = auditRecords([
    rec({
      id: "e1",
      invocation: {
        command: "extension",
        subcommand: "version",
        args: ["<REDACTED>"],
        optionKeys: ["--json"],
        globalOptions: ["--verbose"],
      },
      result: { status: "success", exitCode: 0 },
      startedAt: "2026-06-12T01:00:00.000Z",
      completedAt: "2026-06-12T01:00:00.010Z",
      durationMs: 10,
      swampVersion: "1",
      denoVersion: "1",
      platform: "linux",
      invocationContext: {
        agentSessionDetected: true,
        isInteractive: false,
        externalDatastoreConfigured: false,
        configuredAiTools: ["claude"],
        detectedAiTool: "claude",
      },
      $repo_id: "repo-1",
    }),
  ]);
  assertEquals(a.unknownFields, []);
  assertStringIncludes(renderMarkdown(a), "_(none — every captured field is accounted for)_");
});

Deno.test("surfaces a newly-added telemetry field swamp starts sending", () => {
  const a = auditRecords([
    rec({
      invocation: { command: "model", gitRemoteUrl: "https://example.com/x.git" },
      geoCountry: "US",
      invocationContext: { agentSessionDetected: true, sessionId: "abc" },
    }),
  ]);
  assertEquals(a.unknownFields, [
    "geoCountry",
    "invocation.gitRemoteUrl",
    "invocationContext.sessionId",
  ]);
  const md = renderMarkdown(a);
  assertStringIncludes(md, "## Untracked fields");
  assertStringIncludes(md, "`geoCountry`");
  assertStringIncludes(md, "not accounted for by this audit");
});

Deno.test("renders an older audit resource that predates unknownFields", () => {
  // A resource written by a version before the unknownFields canary — the field is absent.
  const legacy = auditRecords([]);
  delete (legacy as { unknownFields?: string[] }).unknownFields;
  const md = renderMarkdown(legacy);
  assertStringIncludes(md, "## Untracked fields");
  assertStringIncludes(md, "_(none — every captured field is accounted for)_");
});

Deno.test("empty input produces a valid, empty audit", () => {
  const a = auditRecords([]);
  assertEquals(a.eventCount, 0);
  assertEquals(a.timeRange, { first: null, last: null });
  assertStringIncludes(renderMarkdown(a), "# swamp telemetry audit");
});

Deno.test("markdown renders the key sections", () => {
  const md = renderMarkdown(auditRecords([
    rec({ invocation: { command: "model", optionKeys: ["--json"] }, $repo_id: "r1" }),
  ]));
  assertStringIncludes(md, "## Commands run");
  assertStringIncludes(md, "## Fingerprint");
  assertStringIncludes(md, "`--json`");
});
