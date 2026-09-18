import { InferenceClient } from "@huggingface/inference"
import type { ChatCompletionInputMessage } from "@huggingface/tasks";
import { SandboxManager } from "./sandboxmanager";


const client = new InferenceClient(process.env.HUGGINGFACE)
const SESSION_ID = "default-session";


const tools = [{
    type: 'function' as const,
    function: {
        name: 'run_python',
        description: 'Executes Python code in a secure sandbox. Returns the console output.',
        parameters: {
            type: 'object',
            properties: {
                code: {
                    type: 'string',
                    description: "The raw Python code to execute."
                }
            },
            required: ['code']
        }
    }
}]

const runTool = async (tool: any): Promise<string> => {
    if (tool.function.name === 'run_python') {
        const sandbox = await SandboxManager.getInstance().getOrCreate(SESSION_ID)
        const args = JSON.parse(tool.function.arguments);
        console.log(`\n[Agent is writing code]:\n${args.code}\n`);

        // 1. Write the LLM's code safely into the sandbox workspace
        await sandbox.writeFile('agent_script.py', args.code);

        // 2. Execute it inside the isolated container
        const result = await sandbox.executeCode(['python', 'agent_script.py'], {
            timeoutMs: 15_000,
            onStream: (chunk, stream) => {
                process.stdout.write(`[${stream}] ${chunk}`);
            }
    });

        if (!result.success) {
            return `Code failed (exit ${result.exitCode}):\n${result.stderr || result.stdout}`;
        }
        return result.stdout || "Code executed successfully with no output.";


    }
    return 'no tool available'
}

const messages: ChatCompletionInputMessage[] = [{ role: 'system', content: 'You are an autonomous coding agent. Use the run_python tool to execute code and solve the user\'s problem.' }]

const Agent = async (query: string) => {
    messages.push({ role: 'user', content: query })
    const MAX_ITER = 4                  //max iteration 

    let content = ''

    try {
        for (let i = 0; i <= MAX_ITER; i++) {

            const stream = client.chatCompletionStream({
                model: 'deepseek-ai/DeepSeek-V4.1-Flash',
                messages: messages,
                tools: tools,
                tool_choice: "auto"

            })
            let toolCalls = []
            let toolId = ''
            let toolName = ''
            let toolArgs = ''
            for await (const chunk of stream) {
                if (chunk.choices[0]?.delta.tool_calls) {

                    const tool = chunk.choices[0].delta.tool_calls
                    if (tool.length > 0) {
                        const tool_call = tool[0]
                        if (tool_call?.id) {
                            toolId = tool_call.id;
                        }
                        if (tool_call?.function?.name) {
                            toolName = tool_call.function.name;
                        }

                        if (tool_call?.function?.arguments) {

                            toolArgs += tool_call.function.arguments
                        }
                    }

                }
                if (chunk.choices[0]?.delta.content) {
                    content += chunk.choices[0].delta.content
                    process.stdout.write(`${chunk.choices[0]?.delta.content || ''}`);
                }

            }
            if (toolId && toolName) {
                toolCalls.push({ id: toolId, function: { name: toolName, arguments: toolArgs } })

            }
            if (content || toolCalls.length) {
                messages.push({ role: 'assistant', content, tool_call: toolCalls })
            }
            if (!toolCalls.length) {
                return
            }
            for (const call of toolCalls) {
                
                
                messages.push({ role: 'tool', tool_call_id: call.id, name: call.function.name, content: await runTool(call) })
            }
        }
    } catch (error) {
        console.error("Agent Loop Error:", error);
    } finally {
        await SandboxManager.getInstance().destroy(SESSION_ID);
    }


}

Agent('Calculate the 20th Fibonacci number by writing a Python script.')
