import Docker from "dockerode";
import { Writable } from 'stream'

const docker = new Docker({ socketPath: '//./pipe/docker_engine', protocol: 'http', port: '2375', host: '127.0.0.1' })

export interface ExecResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    success: boolean;
}

export class SandboxTimeoutError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SandboxTimeoutError";
    }
}

export interface ExecOptions {
    onStream?: (chunk: string, stream: "stdout" | "stderr") => void;
    timeoutMs?: number;
}





export class Sandbox {
    private container: Docker.Container | null = null;
    private image: string;
    public readonly id: string;


    constructor(id: string, image: string = 'python:3.9-alpine') {
        this.image = image;
        this.id = id
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

        console.log(`[Sandbox: ${this.id}] Starting container...`);
        this.container = await docker.createContainer({
            Image: this.image,
            Cmd: ['tail', '-f', '/dev/null'], // Keep the container running in the background
            WorkingDir: '/workspace',
            HostConfig: {
                Memory: 256 * 1024 * 1024, // Hard limit: 256MB RAM
                NetworkMode: 'none',       // Security: Disconnect from the internet
                AutoRemove: true,          // Cleanup: Delete container when stopped
            },
        });

        await this.container.start();
        console.log(`[Sandbox: ${this.id}] Container ready: ${this.container.id.substring(0, 8)}`);
    }


    async executeCode(command: string[], options: ExecOptions = {}
    ): Promise<ExecResult> {
        if (!this.container) throw new Error("Sandbox not initialized");
        const { onStream, timeoutMs = 30_000 } = options;

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

        const stdoutSink = new Writable({
            write(chunk, encoding, next) {

                const textChunk = chunk
                stdout += textChunk

                onStream?.(textChunk, "stdout");

                next();
            }
        })

        const stderrSink = new Writable({
            write(chunk, encoding, next) {
                const textChunk = chunk
                stderr += textChunk
                onStream?.(textChunk, "stderr");

                next()
            }
        })

        this.container.modem.demuxStream(stream, stdoutSink, stderrSink);

        let settled = false;
        const waitForEnd = new Promise<void>((resolve) => {
            stream.on("end", () => {
                settled = true;
                resolve();
            });
        });

        const timedOut = await Promise.race([
            waitForEnd.then(() => false),
            new Promise<boolean>((resolve) =>
                setTimeout(() => resolve(!settled), timeoutMs)
            ),
        ]);

        if (timedOut) {
            throw new SandboxTimeoutError(
                `Command timed out after ${timeoutMs}ms: ${command.join(" ")}`
            );
        }

        const inspectResult = await exec.inspect();
        const exitCode = inspectResult.ExitCode ?? -1;

        return {
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exitCode,
            success: exitCode === 0,
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

    async destroy() {
        if (this.container) {
            console.log(`[Sandbox] Tearing down...`);
            await this.container.stop(); // AutoRemove will delete it
            this.container = null;
        }
    }
}