import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
    Sandbox,
    SandboxTimeoutError,
    SandboxOutputLimitError,
} from "../sandbox/sandbox";
import { SandboxManager } from "../sandbox/sandboxmanager";

// These are integration tests — they spin up real Docker containers, so
// they're slower than unit tests and require a running local Docker daemon.
//
//   bun test sandbox.test.ts

describe("Sandbox", () => {
    let sandbox: Sandbox;

    beforeAll(async () => {
        sandbox = new Sandbox("test-sandbox");
        await sandbox.initialize();
    }, 60_000);

    afterAll(async () => {
        await sandbox.destroy();
    }, 15_000);

    test("executes a command and captures stdout/exit code", async () => {
        const result = await sandbox.executeCode(["echo", "hello"]);
        expect(result.stdout).toBe("hello");
        expect(result.exitCode).toBe(0);
        expect(result.success).toBe(true);
        expect(result.truncated).toBe(false);
    }, 15_000);

    test("separates stdout and stderr, and reports non-zero exit codes", async () => {
        const result = await sandbox.executeCode([
            "sh",
            "-c",
            "echo out; echo err 1>&2; exit 3",
        ]);
        expect(result.stdout).toBe("out");
        expect(result.stderr).toBe("err");
        expect(result.exitCode).toBe(3);
        expect(result.success).toBe(false);
    }, 15_000);

    test("times out a command that runs too long", async () => {
        await expect(
            sandbox.executeCode(["sleep", "5"], { timeoutMs: 500 })
        ).rejects.toBeInstanceOf(SandboxTimeoutError);
    }, 15_000);

    test("cuts off a command that produces too much output", async () => {
        await expect(
            sandbox.executeCode(["sh", "-c", "yes | head -c 5000000"], {
                maxOutputBytes: 1_000,
            })
        ).rejects.toBeInstanceOf(SandboxOutputLimitError);
    }, 15_000);

    test("writes and reads a file", async () => {
        await sandbox.writeFile("notes/hello.txt", "hi from the test suite");
        const content = await sandbox.readFile("notes/hello.txt");
        expect(content).toBe("hi from the test suite");
    }, 15_000);

    test("lists directory contents", async () => {
        const files = await sandbox.listFiles("notes");
        expect(files).toContain("hello.txt");
    }, 15_000);

    test("deletes a file", async () => {
        await sandbox.deleteFile("notes/hello.txt");
        expect(await sandbox.exists("notes/hello.txt")).toBe(false);
    }, 15_000);
});

describe("SandboxManager", () => {
    test("keeps separate sandboxes isolated from each other", async () => {
        const manager = new SandboxManager();
        const a = await manager.getOrCreate("agent-a");
        const b = await manager.getOrCreate("agent-b");

        await a.writeFile("marker.txt", "A");
        await b.writeFile("marker.txt", "B");

        expect(await a.readFile("marker.txt")).toBe("A");
        expect(await b.readFile("marker.txt")).toBe("B");

        await manager.destroyAll();
        expect(manager.list()).toEqual([]);
    }, 60_000);
});


describe("Sandbox (restricted network)", () => {
    test("can clone a public repo", async () => {
        const sandbox = new Sandbox("test-network-sandbox", { network: "restricted" });
        await sandbox.initialize();
        try {
            const result = await sandbox.cloneRepo(
                "https://github.com/octocat/Hello-World.git",
                "repo"
            );
            expect(result.success).toBe(true);
            expect(await sandbox.exists("repo/README")).toBe(true);
        } finally {
            await sandbox.destroy();
        }
    }, 120_000);
});