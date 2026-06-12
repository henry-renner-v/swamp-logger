# swamp-logger

A tiny, dependency-free [Deno](https://deno.com) tool that **captures, persists, and forwards the
telemetry the [`swamp`](https://swamp.club) CLI emits** — so you can see exactly what your tooling
phones home, keep an auditable record, and (optionally) still let it through.

It is tool-agnostic: it understands the swamp telemetry shape but has no swamp dependency, and it
changes nothing about how swamp authenticates or talks to the registry. See
[PROTOCOL.md](PROTOCOL.md) for the observed event schema.

## How it works

`swamp` lets you override its telemetry endpoint per-repo via `.swamp.yaml`. Point it at this
listener, which writes one immutable file per event and forwards the original batch upstream:

```yaml
# .swamp.yaml
telemetryEndpoint: http://127.0.0.1:8099
```

```
swamp CLI ──POST /ingest──▶ swamp-logger ──┬──▶ events/YYYY/MM/DD/<ts>__<id8>.json  (one file per event)
                                           └──▶ https://telemetry.swamp-club.com    (forwarded, unchanged)
```

## Run

```bash
deno run --allow-net --allow-read --allow-write --allow-env \
  jsr:swamp-logger            # or: deno task start   (from a clone)
```

Then add the `telemetryEndpoint` line above to the `.swamp.yaml` of any repo you want to observe,
and use `swamp` normally.

### Configuration

All optional; flags take precedence over env vars.

| Flag           | Env                      | Default                            | Meaning                              |
| -------------- | ------------------------ | ---------------------------------- | ------------------------------------ |
| `--port`       | `SWAMP_LOGGER_PORT`      | `8099`                             | Listen port                          |
| `--host`       | `SWAMP_LOGGER_HOST`      | `127.0.0.1`                        | Listen address                       |
| `--out`        | `SWAMP_LOGGER_OUT`       | `./events`                         | Output directory (when files on)     |
| `--no-files`   | `SWAMP_LOGGER_FILES=0`   | files on                           | Don't write local per-event files    |
| `--sink`       | `SWAMP_LOGGER_SINK`      | _(off)_                            | POST each event record to this URL   |
| `--upstream`   | `SWAMP_LOGGER_UPSTREAM`  | `https://telemetry.swamp-club.com` | Forward target                       |
| `--no-forward` | `SWAMP_LOGGER_FORWARD=0` | forward on                         | Capture only; don't forward upstream |

### Persistence is pluggable — the logger stays generic

The logger itself knows nothing about any storage backend. It writes local files (handy, and the
zero-config default) and/or **POSTs each event record to a `--sink` URL**. To persist into a git
repo, a database, object storage, or anything in your cluster, run a small **receiver** at that sink
URL that does the backend-specific work. Swap the receiver without touching the logger.

```
swamp-logger --sink http://my-receiver.example/ingest --no-files
                                  │
                                  ▼  (your receiver: commit to git / write to DB / …)
```

The listener always responds `200` and forwards fire-and-forget, so it can never block or break
swamp's own telemetry sender.

## Audit what you captured

The capture store is just files, so consumers of it are separate and swappable — an audit is the
first one. [`audit.ts`](audit.ts) reads `events/**` (per [PROTOCOL.md](PROTOCOL.md)) and summarizes
what the CLI phoned home: commands run, the stable identifiers that fingerprint you (`distinct_id`)
and your repos (`$repo_id`), environment, whether an AI agent was driving, and any failed
invocations.

```bash
deno run --allow-read audit.ts ./events          # human-readable markdown (default)
deno run --allow-read audit.ts ./events --json    # machine-readable JSON
```

It has no swamp dependency and no swamp-logger _runtime_ dependency — only the on-disk schema. It is
also importable, so other surfaces (e.g. a swamp report) can reuse the exact same logic:

```ts
import { auditDir } from "./audit.ts";
const { markdown, json } = await auditDir("./events");
```

## What it is not

- It does **not** capture from _inside_ swamp (a swamp extension can't intercept the CLI's own
  egress). Capture is a network-layer concern, which is why this is a standalone process.
- It does **not** decrypt anything — it relies on swamp's official `.swamp.yaml` endpoint override,
  so traffic to it is plain HTTP on localhost. No proxy, no CA, no root.

To turn telemetry off entirely instead of logging it, use swamp's own switch: `--no-telemetry` or
`SWAMP_NO_TELEMETRY=1`.

## License

MIT — see [LICENSE](LICENSE).
