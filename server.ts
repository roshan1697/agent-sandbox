import {
    
    SandboxTimeoutError,
    type Sandbox,
    type NetworkAccess,
} from "./sandbox";
import { SandboxManager } from "./sandboxmanager";
const PORT = Number(process.env.PORT ?? 8787);
const HOST = "127.0.0.1"; // local-only 

// ---- helpers -------------------------------------------------------------

const json = (data: unknown, status = 200): Response => {
    return new Response(JSON.stringify(data), {
        status,
        headers: { "content-type": "application/json" },
    });
}

const errorResponse = (err: unknown): Response => {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof SandboxTimeoutError ? 504 : 500;
    return json({ error: message }, status);
}

const safeJson = async(req: Request): Promise<any> => {
    try {
        return await req.json();
    } catch {
        return {};
    }
}

/** Streams live stdout/stderr as Server-Sent Events, finishing with a `done` event. */
const  streamExec = (
    sandbox: Sandbox,
    command: string[],
    timeoutMs?: number
): Response => {
    const encoder = new TextEncoder();
    let controllerRef!: ReadableStreamDefaultController<Uint8Array>;

    const body = new ReadableStream({
        start(controller) {
            controllerRef = controller;
        },
    });

    const sse = (event: string, data: unknown) =>
        controllerRef.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );

    (async () => {
        try {
            const result = await sandbox.executeCode(command, {
                timeoutMs,
                onStream: (chunk, stream) => sse(stream, chunk),
            });
            sse("done", result);
        } catch (err) {
            sse("error", { error: err instanceof Error ? err.message : String(err) });
        } finally {
            controllerRef.close();
        }
    })();

    return new Response(body, {
        headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            connection: "keep-alive",
        },
    });
}

// ---- routes ----------------------------------------------------------------
//
//  POST   /sandboxes                  { id?, image?, network? }  -> create/reuse
//  GET    /sandboxes                                             -> list ids
//  DELETE /sandboxes/:id                                         -> destroy
//  POST   /sandboxes/:id/exec         { command, timeoutMs? }    -> run (add ?stream=1 for SSE)
//  POST   /sandboxes/:id/files        { path, content }          -> write
//  GET    /sandboxes/:id/files?path=                             -> read
//  DELETE /sandboxes/:id/files?path=                             -> delete
//  GET    /sandboxes/:id/files/list?path=                        -> list dir
//  POST   /sandboxes/:id/clone        { repoUrl, destPath? }     -> git clone

Bun.serve({
    port: PORT,
    hostname: HOST,
    async fetch(req) {
        const url = new URL(req.url);
        const parts = url.pathname.split("/").filter(Boolean);

        try {
            if (parts[0] !== "sandboxes") return json({ error: "Not found" }, 404);

            // POST /sandboxes
            if (req.method === "POST" && parts.length === 1) {
                const body = await safeJson(req);
                const id = body.id ?? crypto.randomUUID();
                const network: NetworkAccess = body.network === "restricted" ? "restricted" : "none";
                await SandboxManager.getInstance().getOrCreate(id, { image: body.image, network });
                return json({ id, network }, 201);
            }

            // GET /sandboxes
            if (req.method === "GET" && parts.length === 1) {
                return json({ sandboxes: SandboxManager.getInstance().list() });
            }

            // DELETE /sandboxes/:id
            if (req.method === "DELETE" && parts.length === 2) {
                await SandboxManager.getInstance().destroy(parts[1]!);
                return json({ id: parts[1], destroyed: true });
            }

            // Everything else operates on an existing sandbox
            const id = parts[1];
            const sandbox = id ? SandboxManager.getInstance().get(id) : undefined;
            if (!sandbox) return json({ error: `Sandbox '${id}' not found` }, 404);

            // POST /sandboxes/:id/exec
            if (req.method === "POST" && parts[2] === "exec") {
                const body = await safeJson(req);
                if (!Array.isArray(body.command)) {
                    return json({ error: "command must be a string[]" }, 400);
                }
                if (url.searchParams.get("stream") === "1") {
                    return streamExec(sandbox, body.command, body.timeoutMs);
                }
                const result = await sandbox.executeCode(body.command, {
                    timeoutMs: body.timeoutMs,
                });
                return json(result);
            }

            // GET /sandboxes/:id/files/list
            if (req.method === "GET" && parts[2] === "files" && parts[3] === "list") {
                const path = url.searchParams.get("path") ?? ".";
                return json({ path, files: await sandbox.listFiles(path) });
            }

            // GET /sandboxes/:id/files
            if (req.method === "GET" && parts[2] === "files") {
                const path = url.searchParams.get("path");
                if (!path) return json({ error: "path query param required" }, 400);
                return json({ path, content: await sandbox.readFile(path) });
            }

            // POST /sandboxes/:id/files
            if (req.method === "POST" && parts[2] === "files") {
                const body = await safeJson(req);
                if (!body.path || typeof body.content !== "string") {
                    return json({ error: "path and content are required" }, 400);
                }
                await sandbox.writeFile(body.path, body.content);
                return json({ path: body.path, written: true });
            }

            // DELETE /sandboxes/:id/files
            if (req.method === "DELETE" && parts[2] === "files") {
                const path = url.searchParams.get("path");
                if (!path) return json({ error: "path query param required" }, 400);
                await sandbox.deleteFile(path);
                return json({ path, deleted: true });
            }

            // POST /sandboxes/:id/clone
            if (req.method === "POST" && parts[2] === "clone") {
                const body = await safeJson(req);
                if (!body.repoUrl) return json({ error: "repoUrl is required" }, 400);
                const result = await sandbox.cloneRepo(body.repoUrl, body.destPath);
                return json(result);
            }

            return json({ error: "Not found" }, 404);
        } catch (err) {
            return errorResponse(err);
        }
    },
});

process.on("SIGINT", async () => {
    console.log("\nShutting down — cleaning up sandboxes...");
    await SandboxManager.getInstance().destroyAll();
    process.exit(0);
});

console.log(`Sandbox HTTP server listening on http://${HOST}:${PORT}`);