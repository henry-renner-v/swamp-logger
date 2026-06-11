# swamp telemetry protocol (observed)

What the `swamp` CLI sends, and how `swamp-logger` persists it. Observed against
`swamp 20260609.232501.0`; treat as descriptive, not a contract — swamp may change it.

## Transport

- **Default endpoint:** `https://telemetry.swamp-club.com`
- **Override (per repo):** the `telemetryEndpoint:` field in `.swamp.yaml`. Resolution order in the
  CLI is: `.swamp.yaml telemetryEndpoint` > localhost auto-detect from the auth server URL >
  default. Setting it affects **telemetry only** — not the API, auth, or registry.
- **Disable entirely:** the `--no-telemetry` flag or the `SWAMP_NO_TELEMETRY=1` env var (with
  either, the CLI makes no outbound telemetry connection at all).
- **Request:** `POST /ingest`, `content-type: application/json`, `user-agent: swamp-cli/<version>`.
  Body is a batch:

```json
{ "events": [{ "...": "one or more events" }] }
```

## Event shape

```jsonc
{
  "event": "cli_invocation",
  "distinct_id": "<stable anonymous user UUID>",
  "properties": {
    "id": "<per-event UUID>",
    "invocation": {
      "command": "version",
      "args": [], // positional args
      "optionKeys": [], // option NAMES only — not their values
      "globalOptions": []
    },
    "result": { "status": "success", "exitCode": 0 },
    "startedAt": "2026-06-10T11:20:07.782Z",
    "completedAt": "2026-06-10T11:20:07.796Z",
    "durationMs": 14,
    "swampVersion": "<version>",
    "denoVersion": "<version>",
    "platform": "linux",
    "invocationContext": {
      "agentSessionDetected": true,
      "isInteractive": false,
      "externalDatastoreConfigured": false,
      "configuredAiTools": ["claude"],
      "detectedAiTool": "claude"
    },
    "$repo_id": "<repo UUID>"
  }
}
```

### Privacy notes

- Records **every command run**, success/failure, timing, versions, platform, and whether an AI
  agent (and which) is driving the session.
- `optionKeys` are option **names**, not values — flag _values_ (e.g. an IP passed to a
  `--global-arg`) are not included in this version.
- Identifiers present: `distinct_id` (stable, anonymous) and `$repo_id`.

## On-disk layout (what swamp-logger writes)

One **immutable file per event** (the batch is split):

```
events/YYYY/MM/DD/<completedAt|startedAt|receivedAt>__<id8>.json
```

Each file:

```jsonc
{
  "receivedAt": "<when swamp-logger received it>",
  "endpointPath": "/ingest",
  "userAgent": "swamp-cli/<version>",
  "event": {/* the verbatim event */}
}
```

Unparseable payloads are never dropped — they land in `events/raw/<receivedAt>.json`. Write-once
files mean clean git history (pure additions) and per-entry redaction by deletion.
