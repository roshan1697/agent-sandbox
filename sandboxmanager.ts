import { Sandbox } from "./sandbox";

export class SandboxManager {
    private static instance: SandboxManager
    private sandboxes = new Map<string, Sandbox>();

    constructor() {

    }

    public static getInstance() {
        if (!this.instance) {
            this.instance = new SandboxManager()
        }
        return this.instance
    }
    async getOrCreate(id: string, image?: string): Promise<Sandbox> {
        let sandbox = this.sandboxes.get(id);
        if (!sandbox) {
            sandbox = new Sandbox(id, image);
            await sandbox.initialize();
            this.sandboxes.set(id, sandbox);
        }
        return sandbox;
    }

    get(id: string): Sandbox | undefined {
        return this.sandboxes.get(id);
    }

    list(): string[] {
        return [...this.sandboxes.keys()];
    }

    async destroy(id: string): Promise<void> {
        const sandbox = this.sandboxes.get(id);
        if (sandbox) {
            await sandbox.destroy();
            this.sandboxes.delete(id);
        }
    }

    async destroyAll(): Promise<void> {
        await Promise.all([...this.sandboxes.values()].map((s) => s.destroy()));
        this.sandboxes.clear();
    }
}