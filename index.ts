import { Sandbox } from './sandbox';

async function main() {
    const sandbox = new Sandbox();

    try {
        await sandbox.initialize();

        const scriptContent = `
import time
import sys

print("Starting long process...")
sys.stdout.flush() # Force output to flush immediately

for i in range(1, 6):
    print(f"Processing chunk {i}/5...")
    sys.stdout.flush()
    time.sleep(1)

print("Process complete!")
    `.trim()

        const errorScript = `import time
import sys

print("Starting risky process...")
sys.stdout.flush()
time.sleep(1)

print("Triggering intentional error...")
sys.stdout.flush()
time.sleep(1)

# This will throw a ZeroDivisionError and print a stack trace to stderr
result = 1 / 0

print("This line will never be reached.")`.trim()

        await sandbox.writeFile('math_tools.py', errorScript);

        // const readBack = await sandbox.readFile('math_tools.py');
        // console.log(`\n--- File Contents ---\n${readBack}\n---------------------\n`);

        const result = await sandbox.executeCode(['python', 'math_tools.py'],
            (chunk) => {
                process.stdout.write(`[Live Stream] ${chunk}`)
            }
        );
        console.log(`\n[Host] Execution finished. Full captured output length: ${result.length} characters.`);
        

    } catch (error) {
        console.error("Sandbox error:", error);
    } finally {
        await sandbox.destroy();
    }
}

main()