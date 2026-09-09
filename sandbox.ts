import Docker from "dockerode";
import { Writable } from 'stream'

const docker = new Docker({ socketPath: '//./pipe/docker_engine', protocol: 'http', port: '2375', host: '127.0.0.1' })

export class Sandbox {
    private container: Docker.Container | null = null;
    private image: string;

    constructor(image: string = 'python:3.9-alpine') {
        this.image = image;
    }


    async initialize() {
        console.log(`[Sandbox] Pulling image ${this.image}...`);
        // Ensure the image exists locally
        await new Promise((resolve, reject) => {
            docker.pull(this.image, (err: Error, stream: NodeJS.ReadableStream) => {
                if (err) return reject(err);
                docker.modem.followProgress(stream, resolve, (event) => { });
            });
        });

        console.log(`[Sandbox] Starting container...`);
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
        console.log(`[Sandbox] Container ready: ${this.container.id.substring(0, 8)}`);
    }


    async executeCode(command: string[], onSteam?: (chunk: string) => void): Promise<string> {
        if (!this.container) throw new Error("Sandbox not initialized");

        const exec = await this.container.exec({
            Cmd: command,
            AttachStdout: true,
            AttachStderr: true,
        });

        const stream = await exec.start({ Detach: false });
        // Capture the output
        let output = '';
        const outStream = new Writable({
            write(chunk, encoding, next) {
                // Docker multiplexes stdout/stderr, we strip the 8-byte header

                const textChunk = chunk.toString('utf8');
                output += textChunk

                if(onSteam){
                    onSteam(textChunk)
                }
                next();
            }
        });

        this.container.modem.demuxStream(stream, outStream, outStream);

        return new Promise((resolve) => {
            stream.on('end', () => resolve(output.trim()));
        });
    }


    async writeFile(filePath: string, content: string): Promise<void> {
        const base64Content = Buffer.from(content).toString('base64');

        // Create the directory if it doesn't exist, then decode the base64 into the file
        const command = [
            'sh', '-c',
            `mkdir -p $(dirname ${filePath}) && echo "${base64Content}" | base64 -d > ${filePath}`
        ];

        await this.executeCode(command);
        console.log(`[Sandbox] Wrote file: ${filePath}`);
    }

    
    async readFile(filePath: string): Promise<string> {
        // Read the file as base64 to preserve all formatting and special characters
        const base64Output = await this.executeCode(['sh', '-c', `base64 ${filePath}`]);

        if (base64Output.includes('can\'t open')) {
            throw new Error(`File not found: ${filePath}`);
        }

        return Buffer.from(base64Output.trim(), 'base64').toString('utf-8');
    }

    async destroy() {
        if (this.container) {
            console.log(`[Sandbox] Tearing down...`);
            await this.container.stop(); // AutoRemove will delete it
            this.container = null;
        }
    }
}