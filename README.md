# agent-sandbox

A Docker-based sandbox for letting AI agents safely execute code, manage files, and (optionally) reach the internet — built as a learning project inspired by [Cloudflare's `sandbox-sdk`](https://github.com/cloudflare/sandbox-sdk), scaled down to run against a local Docker daemon instead of Cloudflare's edge network.

An agent (`agent.ts`) talks to a Hugging Face model, which can call a `run_python` tool. That tool writes the model's code into an isolated container and runs it — the model never touches your host machine directly.

## Features

- **Isolated execution** — each sandbox is its own Docker container with no access to your host filesystem or network by default.
- **Structured exec results** — every command returns `{ stdout, stderr, exitCode, success, truncated }` instead of one merged blob of text.
- **Timeouts** — a command that hangs is killed automatically instead of blocking forever (`ExecOptions.timeoutMs`, default 30s).
- **Output size limits** — a runaway process (e.g. an infinite print loop) is killed once combined stdout/stderr crosses a byte limit (`ExecOptions.maxOutputBytes`, default 2MB), so it can't blow up your Node process's memory.
- **Resource limits** — per-sandbox caps on CPU (`cpus`), memory (`memoryMB`), and process/thread count (`pidsLimit`, blocks fork bombs).
- **File operations** — `writeFile`, `readFile`, `mkdir`, `listFiles`, `deleteFile`, `exists`.
- **Multiple named sandboxes** — `SandboxManager` keys sandboxes by id, so several isolated sessions can run concurrently instead of sharing one global container.
- **Selective network access** — sandboxes are offline by default; opting into `{ network: 'restricted' }` routes them through a shared egress proxy that only allows a specific domain allowlist (PyPI, GitHub, Alpine's package mirror), enforced at the Docker network layer, not just by convention.
- **Git clone support** — `cloneRepo()` for restricted-network sandboxes, with git auto-installed on demand.
- **Local HTTP API** — `server.ts` exposes the whole thing over HTTP with `Bun.serve()`, so a sandbox can be created, run, inspected, and destroyed by id from any client (or a future frontend).
- **Test suite** — integration tests in `sandbox.test.ts` covering exec, timeouts, output limits, file ops, and sandbox isolation.

## Requirements

- [Bun](https://bun.sh)
- Docker Desktop (or another local Docker daemon) — running, with its API reachable at the socket configured in `sandbox.ts`
- A Hugging Face API token, if you're running `agent.ts` (set as the `HUGGINGFACE` environment variable)

## Getting started

```bash
bun install
```

**Run the demo agent** (writes and executes a small Python script via the LLM):

```bash
HUGGINGFACE=your_token_here bun run agent.ts
```

**Run the HTTP server** instead, to drive sandboxes directly:

```bash
bun run server.ts
# Sandbox HTTP server listening on http://127.0.0.1:8787
```

**Run the tests:**

```bash
bun test sandbox.test.ts
```

Tests spin up real containers, so they're slower than unit tests and need Docker running. One `describe` block (cloning over a restricted network) is skipped by default since it needs real internet and a slower image pull — remove `.skip` in `sandbox.test.ts` to include it.

## Using the `Sandbox` class directly

```ts
import { sandboxManager } from "./sandbox";

const sandbox = await sandboxManager.getOrCreate("session-1");

const result = await sandbox.executeCode(["python", "-c", "print(2 + 2)"]);
console.log(result); // { stdout: "4", stderr: "", exitCode: 0, success: true, truncated: false }

await sandbox.writeFile("script.py", "print('hello')");
console.log(await sandbox.readFile("script.py"));

await sandboxManager.destroy("session-1");
```

**With network access and a git clone:**

```ts
const networked = await sandboxManager.getOrCreate("session-2", { network: "restricted" });
await networked.cloneRepo("https://github.com/octocat/Hello-World.git", "repo");
```

**With tighter resource limits:**

```ts
const tight = await sandboxManager.getOrCreate("session-3", {
  cpus: 0.5,
  memoryMB: 128,
  pidsLimit: 32,
});
```

## HTTP API (`server.ts`)

Runs on `http://127.0.0.1:8787` by default (override with `PORT`). Bound to localhost only — there's no authentication, so don't expose this beyond your own machine as-is.

| Method | Path                          | Body / Query                     | Description                          |
|--------|-------------------------------|-----------------------------------|---------------------------------------|
| POST   | `/sandboxes`                  | `{ id?, image?, network? }`       | Create or reuse a sandbox             |
| GET    | `/sandboxes`                  | —                                  | List sandbox ids                      |
| DELETE | `/sandboxes/:id`              | —                                  | Destroy a sandbox                     |
| POST   | `/sandboxes/:id/exec`         | `{ command, timeoutMs? }`         | Run a command (`?stream=1` for SSE)   |
| POST   | `/sandboxes/:id/files`        | `{ path, content }`               | Write a file                          |
| GET    | `/sandboxes/:id/files`        | `?path=`                          | Read a file                           |
| DELETE | `/sandboxes/:id/files`        | `?path=`                          | Delete a file                         |
| GET    | `/sandboxes/:id/files/list`   | `?path=`                          | List a directory                      |
| POST   | `/sandboxes/:id/clone`        | `{ repoUrl, destPath? }`          | Clone a git repo (needs `network: "restricted"`) |

```bash
curl -X POST localhost:8787/sandboxes -d '{"network":"restricted"}'
curl -X POST localhost:8787/sandboxes/<id>/exec -d '{"command":["python","-c","print(1+1)"]}'
curl -X DELETE localhost:8787/sandboxes/<id>
```

## Architecture notes

- **Network isolation**: restricted sandboxes join an `Internal: true` Docker network, which has no route out at all — this is enforced by Docker itself, not by hoping the code inside respects `HTTP_PROXY`. The only thing reachable from that network is a shared Squid proxy container, also attached to the normal bridge network, which forwards only allowlisted domains.
- **Resource limits**: CPU (`NanoCpus`), memory (`Memory`), and process count (`PidsLimit`) are all set at container creation via Docker's `HostConfig` — the same primitives Docker itself uses for `docker run --cpus`, `--memory`, `--pids-limit`.
- **Timeouts / output limits**: enforced in application code (`executeCode`) by racing the exec's completion against a timer and a byte counter, then sending `SIGKILL` to the process inside the container via a follow-up `exec` if either trips.

## Known limitations

This is a learning project, not a production SDK — some gaps compared to `sandbox-sdk`:

- No edge/cloud deployment — everything assumes a local Docker daemon.
- No preview URLs or public tunnels for services running inside a sandbox.
- No persistence — sandbox state lives in memory and is lost if the process restarts.
- The egress allowlist is domain-based (Squid ACLs), not a full security boundary against a determined adversary.

## Possible next steps

- Persist sandbox metadata (id, image, container id) to SQLite so sessions survive a server restart.
- Expose a sandbox's port publicly via `cloudflared tunnel`, mirroring `sandbox-sdk`'s quick tunnels.
- Package `Sandbox`/`SandboxManager` as an installable module with proper `exports` and types.