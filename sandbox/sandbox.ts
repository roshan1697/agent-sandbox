import Docker from "dockerode";
import { Writable } from 'stream'

const docker = new Docker({ socketPath: '//./pipe/docker_engine', protocol: 'http', port: '2375', host: '127.0.0.1' })

export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    success: boolean;
    truncated: boolean
}

export class SandboxTimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SandboxTimeoutError";
    }
}

export class SandboxOutputLimitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SandboxOutputLimitError";
    }
}

export interface ExecOptions {
    onStream?: (chunk: string, stream: "stdout" | "stderr") => void;
    timeoutMs?: number;
    maxOutputBytes?: number
}

export type NetworkAccess = "none" | "restricted";

export interface SandboxOptions {
    image?: string;
    network?: NetworkAccess;
    memoryMB?: number;
    cpus?: number;
    pidsLimit?: number;

}

const INTERNAL_NETWORK_NAME = "sandbox-restricted-net";
const PROXY_CONTAINER_NAME = "sandbox-egress-proxy";
const PROXY_ALIAS = "sandbox-proxy";
const PROXY_PORT = 3128;

const ALLOWED_DOMAINS = [
    ".pypi.org",
    ".files.pythonhosted.org",
    ".github.com",
    ".githubusercontent.com",
    ".alpinelinux.org",
    ".dl-cdn.alpinelinux.org"
];

const buildSquidConfig = (): string => {
    return [
        `http_port ${PROXY_PORT}`,
        `visible_hostname ${PROXY_ALIAS}`,
        `acl allowed_dst dstdomain ${ALLOWED_DOMAINS.join(" ")}`,
        `http_access allow allowed_dst`,
        `http_access deny all`,
        `cache deny all`,
    ].join("\n");
}

const ensureInternalNetwork = async (): Promise<void> => {
    const networks = await docker.listNetworks({
        filters: JSON.stringify({ name: [INTERNAL_NETWORK_NAME] }),
    });
    if (networks.some((n) => n.Name === INTERNAL_NETWORK_NAME)) return;

    await docker.createNetwork({
        Name: INTERNAL_NETWORK_NAME,
        Internal: true, // <- no route out; this is what actually enforces isolation
    });
}

const ensureEgressProxy = async (): Promise<void> => {
    await ensureInternalNetwork();

    const existing = docker.getContainer(PROXY_CONTAINER_NAME);
    try {
        const info = await existing.inspect();
        if (!info.State.Running) await existing.start();
        return;
    } catch {
        // Container doesn't exist yet — fall through and create it.
    }

    console.log("[EgressProxy] Pulling base image...");
    await new Promise((resolve, reject) => {
        docker.pull("alpine:3.19", (err: Error, stream: NodeJS.ReadableStream) => {
            if (err) return reject(err);
            docker.modem.followProgress(stream, resolve, () => { });
        });
    });

    const config = buildSquidConfig();
    const startCmd = [
        "apk add --no-cache squid >/dev/null 2>&1",
        "cat > /etc/squid/squid.conf <<'EOF'",
        config,
        "EOF",
        "exec squid -N -f /etc/squid/squid.conf",
    ].join("\n");

    console.log("[EgressProxy] Creating proxy container...");
    const proxy = await docker.createContainer({
        name: PROXY_CONTAINER_NAME,
        Image: "alpine:3.19",
        Entrypoint: ["sh", "-c"],
        Cmd: [startCmd],
        HostConfig: {
            NetworkMode: "bridge", // gives the proxy itself real internet access
            RestartPolicy: { Name: "unless-stopped" },
        },
    });

    await proxy.start();

    // Also attach it to the internal (no-egress) network under a known name,
    // so restricted sandboxes can reach it as `sandbox-proxy:3128`.
    await docker.getNetwork(INTERNAL_NETWORK_NAME).connect({
        Container: proxy.id,
        EndpointConfig: { Aliases: [PROXY_ALIAS] },
    });

    console.log(
        `[EgressProxy] Ready — allowlisted domains: ${ALLOWED_DOMAINS.join(", ")}`
    );
}

export class Sandbox {
    private container: Docker.Container | null = null;
    private image: string;
    private networkMode: NetworkAccess;
    private memoryMB: number;
    private cpus: number;
    private pidsLimit: number;
    public readonly id: string;


    constructor(id: string, options: SandboxOptions = {}) {
        this.image = options.image ?? "python:3.9-alpine";
        this.id = id
        this.networkMode = options.network ?? "none";
        this.memoryMB = options.memoryMB ?? 256;
        this.cpus = options.cpus ?? 1;
        this.pidsLimit = options.pidsLimit ?? 128;

    }


    async initialize() {
        console.log(`[Sandbox: ${this.id}] Pulling image ${this.image}...`);
        // Ensure the image exists locally
        await new Promise((resolve, reject) => {
            docker.pull(this.image, (err: Error, stream: NodeJS.ReadableStream) => {
                if (err) return reject(err);
                docker.modem.followProgress(stream, resolve, (event) => { });
            });
        });

        const env: string[] = [];
        const hostConfig: Docker.ContainerCreateOptions["HostConfig"] = {
            Memory: this.memoryMB * 1024 * 1024,
            NanoCpus: Math.round(this.cpus * 1e9), // CPU cap, e.g. 0.5 cores
            PidsLimit: this.pidsLimit, // caps total processes/threads — blocks fork bombs
            AutoRemove: true,
        };
        if (this.networkMode === "restricted") {
            await ensureEgressProxy();
            hostConfig.NetworkMode = INTERNAL_NETWORK_NAME;
            const proxyUrl = `http://${PROXY_ALIAS}:${PROXY_PORT}`;
            env.push(
                `HTTP_PROXY=${proxyUrl}`,
                `HTTPS_PROXY=${proxyUrl}`,
                `http_proxy=${proxyUrl}`,
                `https_proxy=${proxyUrl}`,
                "NO_PROXY=localhost,127.0.0.1"
            );
        } else {
            hostConfig.NetworkMode = "none"; // Security: no network at all
        }
        console.log(
            `[Sandbox:${this.id}] Starting container (network: ${this.networkMode}, ` +
            `cpus: ${this.cpus}, memory: ${this.memoryMB}MB, pidsLimit: ${this.pidsLimit})...`
        );
        this.container = await docker.createContainer({
            Image: this.image,
            Cmd: ["tail", "-f", "/dev/null"], // Keep the container running in the background
            WorkingDir: "/workspace",
            Env: env,
            HostConfig: hostConfig,
        });

        await this.container.start();
        console.log(`[Sandbox: ${this.id}] Container ready: ${this.container.id.substring(0, 8)}`);
    }


    async executeCode(command: string[], options: ExecOptions = {}
    ): Promise<ExecResult> {
        if (!this.container) throw new Error("Sandbox not initialized");
        const { onStream, timeoutMs = 30_000, maxOutputBytes = 2 * 1024 * 1024, } = options;

        const exec = await this.container.exec({
            Cmd: command,
            AttachStdout: true,
            AttachStderr: true,
            Tty: false,

        });

        const stream = await exec.start({ Detach: false });
        // Capture the output
        let stdout = "";
        let stderr = "";
        let totalBytes = 0;
        let outputExceeded = false;
        let resolveLimitExceeded: () => void;
        const limitExceeded = new Promise<void>((resolve) => {
            resolveLimitExceeded = resolve;
        });

        const track = (text: string) => {
            totalBytes += Buffer.byteLength(text, "utf8");
            if (totalBytes > maxOutputBytes && !outputExceeded) {
                outputExceeded = true;
                resolveLimitExceeded();
            }
        };

        const stdoutSink = new Writable({
            write(chunk, encoding, next) {

                const textChunk = chunk
                stdout += textChunk

                onStream?.(textChunk, "stdout");
                track(textChunk);

                next();
            }
        })

        const stderrSink = new Writable({
            write(chunk, encoding, next) {
                const textChunk = chunk
                stderr += textChunk
                onStream?.(textChunk, "stderr");
                track(textChunk);

                next()
            }
        })

        this.container.modem.demuxStream(stream, stdoutSink, stderrSink);

        const waitForEnd = new Promise<void>((resolve) => stream.on("end", resolve));

        const outcome = await Promise.race([
            waitForEnd.then(() => "done" as const),
            new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), timeoutMs)),
            limitExceeded.then(() => "limit" as const),
        ]);

        if (outcome !== "done") {
            await this.killExec(exec);
            if (outcome === "timeout") {
                throw new SandboxTimeoutError(
                    `Command timed out after ${timeoutMs}ms: ${command.join(" ")}`
                );
            }
            throw new SandboxOutputLimitError(
                `Command exceeded output limit of ${maxOutputBytes} bytes and was terminated: ${command.join(" ")}`
            );
        }

        const inspectResult = await exec.inspect();
        const exitCode = inspectResult.ExitCode ?? -1;

        return {
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exitCode,
            success: exitCode === 0,
            truncated: outputExceeded,

        }
    }

    private async killExec(exec: Docker.Exec): Promise<void> {
        try {
            const info = await exec.inspect();
            const pid = info.Pid;
            if (pid) {
                await this.executeCode(["kill", "-9", String(pid)], { timeoutMs: 5_000 });
            }
        } catch {
            // Best effort — if this fails there's nothing more we can do from here.
        }
    }

    async writeFile(filePath: string, content: string): Promise<void> {
        const base64Content = Buffer.from(content).toString('base64');

        // Create the directory if it doesn't exist, then decode the base64 into the file
        const command = [
            'sh', '-c',
            `mkdir -p $(dirname ${filePath}) && echo "${base64Content}" | base64 -d > ${filePath}`
        ];

        const result = await this.executeCode(command);
        if (!result.success) {
            throw new Error(`Failed to write file ${filePath}: ${result.stderr}`);
        }
    }


    async readFile(filePath: string): Promise<string> {
        // Read the file as base64 to preserve all formatting and special characters
        const result = await this.executeCode(["sh", "-c", `base64 "${filePath}"`]);
        if (!result.success) {
            throw new Error(`File not found or unreadable: ${filePath} (${result.stderr})`);
        }
        return Buffer.from(result.stdout, "base64").toString("utf-8");
    }

    async mkdir(dirPath: string): Promise<void> {
        const result = await this.executeCode(["mkdir", "-p", dirPath]);
        if (!result.success) {
            throw new Error(`Failed to create dir ${dirPath}: ${result.stderr}`);
        }
    }

    async listFiles(dirPath: string = "."): Promise<string[]> {
        const result = await this.executeCode(["ls", "-1a", dirPath]);
        if (!result.success) {
            throw new Error(`Failed to list ${dirPath}: ${result.stderr}`);
        }
        return result.stdout
            .split("\n")
            .filter((f) => f && f !== "." && f !== "..");
    }

    async deleteFile(filePath: string): Promise<void> {
        const result = await this.executeCode(["rm", "-rf", filePath]);
        if (!result.success) {
            throw new Error(`Failed to delete ${filePath}: ${result.stderr}`);
        }
    }

    async exists(filePath: string): Promise<boolean> {
        const result = await this.executeCode(["sh", "-c", `test -e "${filePath}"`]);
        return result.success;
    }

    private async ensureGitInstalled(): Promise<void> {
        const check = await this.executeCode(["sh", "-c", "command -v git"]);
        if (check.success) return;

        const hasApk = await this.executeCode(["sh", "-c", "command -v apk"]);
        if (hasApk.success) {
            const install = await this.executeCode(
                ["sh", "-c", "apk add --no-cache git"],
                { timeoutMs: 60_000 }
            );
            if (!install.success) {
                throw new Error(`Failed to install git via apk: ${install.stderr}`);
            }
            return;
        }

        const hasApt = await this.executeCode(["sh", "-c", "command -v apt-get"]);
        if (hasApt.success) {
            const install = await this.executeCode(
                ["sh", "-c", "apt-get update && apt-get install -y git"],
                { timeoutMs: 120_000 }
            );
            if (!install.success) {
                throw new Error(`Failed to install git via apt-get: ${install.stderr}`);
            }
            return;
        }

        throw new Error(
            "No supported package manager (apk/apt-get) found to install git in this image"
        );
    }


    async cloneRepo(repoUrl: string, destPath: string = "."): Promise<ExecResult> {
        if (this.networkMode === "none") {
            throw new Error(
                "cloneRepo requires network access — create this Sandbox with { network: 'restricted' }"
            );
        }
        await this.ensureGitInstalled();
        const result = await this.executeCode(
            ["git", "clone", "--depth", "1", repoUrl, destPath],
            { timeoutMs: 60_000 }
        );
        if (!result.success) {
            throw new Error(`git clone failed: ${result.stderr}`);
        }
        return result;
    }

    async destroy() {
        if (this.container) {
            console.log(`[Sandbox:${this.id}] Tearing down...`);
            await this.container.stop(); // AutoRemove will delete it
            this.container = null;
        }
    }
}