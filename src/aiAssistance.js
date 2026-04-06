const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const vscode = require('vscode'); // Added vscode import

class AiAssistanceProvider {
    constructor(_extensionUri, _context, _getContext) {
        this._extensionUri = _extensionUri;
        this._context = _context;
        this._getContext = _getContext;
        this._view = undefined;
        // Load history from state if available
        this._history = this._context.workspaceState.get('aiChatHistory', []);
        this._firmwareOverride = null;
    }

    resolveWebviewView(webviewView) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview();

        webviewView.webview.onDidReceiveMessage(async (data) => {
            switch (data.type) {
                case 'sendMessage':
                    await this._handleChat(data.value);
                    break;
                case 'checkStatus':
                    await this._checkOllamaStatus();
                    break;
                case 'installModel':
                    await this._installModel();
                    break;
                case 'clearHistory':
                    this._history = [];
                    this._context.workspaceState.update('aiChatHistory', []);
                    break;
                case 'getHistory':
                    // If UI reloads, give it the history back
                    this._view.webview.postMessage({ type: 'historySync', value: this._history });
                    break;
                case 'codeAction':
                    await this._handleCodeAction(data.action, data.value);
                    break;
                case 'setFirmware':
                    this._firmwareOverride = data.value;
                    // Notify webview to update UI if needed (though it likely already updated from click)
                    break;
            }
        });

        // initial check
        this._checkOllamaStatus();
    }

    async _checkOllamaStatus() {
        const pythonPath = this._getPythonPath();
        const scriptPath = path.join(this._extensionUri.fsPath, 'src', 'ollama_helper.py');

        const proc = spawn(pythonPath, [scriptPath, 'check']);
        
        let result = '';
        let errorOutput = '';

        proc.stdout.on('data', (d) => result += d.toString());
        proc.stderr.on('data', (d) => errorOutput += d.toString());

        const timeout = setTimeout(() => {
            proc.kill();
            this._view.webview.postMessage({ type: 'status', value: { connected: false, installed: false } });
        }, 8000);

        proc.on('close', (code) => {
            clearTimeout(timeout);
            try {
                if (code !== 0 || !result.trim()) {
                    throw new Error(errorOutput || 'No output from check script');
                }
                const status = JSON.parse(result.trim());
                this._view.webview.postMessage({ type: 'status', value: status });
            } catch (e) {
                console.error(`Ollama check failed: ${e.message}`);
                this._view.webview.postMessage({ type: 'status', value: { connected: false, installed: false } });
            }
        });

        proc.on('error', (err) => {
            clearTimeout(timeout);
            console.error(`Spawn error: ${err.message}`);
            this._view.webview.postMessage({ type: 'status', value: { connected: false, installed: false } });
        });
    }

    async _installModel() {
        this._view.webview.postMessage({ type: 'installProgress', value: 'Pulling base model (2.3GB)...' });
        
        const pythonPath = this._getPythonPath();
        const scriptPath = path.join(this._extensionUri.fsPath, 'src', 'ollama_helper.py');
        const modelfilePath = path.join(this._extensionUri.fsPath, 'resource', 'Modelfile');

        const proc = spawn(pythonPath, [scriptPath, 'setup', modelfilePath]);
        
        let buffer = '';
        proc.stdout.on('data', (d) => {
            buffer += d.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                try {
                    const status = JSON.parse(line.trim());
                    if (status.status) {
                        let msg = status.status;
                        if (status.total && status.completed) {
                            const percent = Math.round((status.completed / status.total) * 100);
                            msg += `: ${percent}%`;
                        }
                        this._view.webview.postMessage({ type: 'installProgress', value: msg });
                    }
                } catch (e) {
                    // Not JSON or partial, ignore
                }
            }
        });

        proc.on('close', (code) => {
            if (code === 0) {
                this._view.webview.postMessage({ type: 'installSuccess' });
                this._checkOllamaStatus();
            } else {
                this._view.webview.postMessage({ type: 'error', value: 'Model installation failed.' });
            }
        });
    }

    async _handleChat(message) {
        const pythonPath = this._getPythonPath();
        const scriptPath = path.join(this._extensionUri.fsPath, 'src', 'ollama_helper.py');

        // --- Context Gathering ---
        const editor = vscode.window.activeTextEditor;
        let fileContext = "";
        if (editor) {
            const doc = editor.document;
            const content = doc.getText();
            const fileName = path.basename(doc.fileName);
            // Limit context size
            const truncatedContent = content.length > 5000 ? content.substring(0, 5000) + "... [truncated]" : content;
            fileContext = `[Current File: ${fileName}]\n\`\`\`python\n${truncatedContent}\n\`\`\``;
        }


        // --- Add only RAW message to history to keep it clean ---
        this._history.push({ role: 'user', content: message });
        
        // Limit history size
        if (this._history.length > 30) {
            this._history = this._history.slice(-30);
        }

        // --- Construct the Ephemeral Prompt (with context tags) for the LATEST turn ---
        const contextData = await this._getContext();
        const systemContext = `[device]
port = ${contextData.port}
mcu = ${contextData.mcu}
sync_folder = ${contextData.sync_folder}
root_folder = ${contextData.root_folder}
project_created = ${contextData.project_created}
last_sync = ${contextData.last_sync}
device_firmware = ${this._firmwareOverride || contextData.firmware}
deviceId = ${contextData.deviceId}

[filePath]
projectDir = "${contextData.projectDir}"
ProjectFolder = "${contextData.ProjectFolder}"
deviceCodeDir = "${contextData.deviceCodeDir}"
virtualEnv = "${contextData.virtualEnv}"
virtualPython = "${contextData.virtualPython}"

${contextData.vscodeSettings ? '[settings.json]\n' + contextData.vscodeSettings : ''}`;
        
        // Truncate file content to prevent context overflow (max 2500 chars)
        const truncatedFileContext = fileContext.length > 2500 ? fileContext.substring(0, 2500) + "\n... [truncated]" : fileContext;

        const latestPrompt = `
<contaxt>
${systemContext}
${truncatedFileContext}
</contaxt>
<task>
${message}
</task>
<format>
You are the MicroPython Studio Private AI Assistant. Respond as a MicroPython/CircuitPython expert in MicroPython Studio. Use professional markdown. Be concise.
Provide high-quality code snippets when asked. 

LIBRARY INSTALLATION:
- If a library is needed, DO NOT recommend using 'pip' or 'sh' from a terminal.
- Instead, instruct the user to install the library using the built-in "Package Manager" (MicroPython) or "CircuitPython Package Manager" available in MicroPython Studio.
CRITICAL: Always wrap code in triple backticks with the language specified (e.g. \`\`\`python).

CONTEXT GUIDANCE:
- If 'port' is 'Not Connected', 'deviceId' is 'Unknown', or 'projectDir' is 'Not set', you lack specific project context.
- In such cases, politely inform the user that you don't know which device they are using yet.
- Suggest they open a MicroPython project folder and click the "Refresh Device Files" button in the status bar or explorer to provide this context.
- Avoid guessing or using hardcoded paths like 'E:\' if you don't see them in the [filePath] section.
</format>
<refrence>
${contextData.stubsPath ? 'IDE Stubs Path: ' + contextData.stubsPath : 'Standard MicroPython libs.'}
</refrence>
`;

        // Create the message list for Ollama
        const messagesToSend = [...this._history];
        // Replace the last (raw) message with the context-rich prompt
        messagesToSend[messagesToSend.length - 1] = { role: 'user', content: latestPrompt };

        const messagesJson = JSON.stringify(messagesToSend);
        
        const proc = spawn(pythonPath, [scriptPath, 'chat']);
        
        let fullResponse = '';
        proc.stdout.on('data', (d) => {
            const chunk = d.toString();
            fullResponse += chunk;
            this._view.webview.postMessage({ type: 'chatResponse', value: chunk });
        });

        proc.stderr.on('data', (d) => {
            console.error(`AI Error: ${d}`);
        });

        proc.on('close', () => {
            const trimmedResponse = fullResponse.trim();
            if (trimmedResponse) {
                this._history.push({ role: 'assistant', content: trimmedResponse });
                this._context.workspaceState.update('aiChatHistory', this._history);
            }
            this._view.webview.postMessage({ type: 'chatDone' });
        });

        proc.stdin.write(messagesJson);
        proc.stdin.end();
    }

    async _handleCodeAction(action, code) {
        switch (action) {
            case 'copy':
                await vscode.env.clipboard.writeText(code);
                break;
            case 'insert':
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    editor.edit(editBuilder => {
                        // Use replace on current selection (if empty, it acts as insert)
                        editBuilder.replace(editor.selection, code);
                    });
                } else {
                    vscode.window.showInformationMessage('No active editor to insert code.');
                }
                break;
            case 'new':
                const doc = await vscode.workspace.openTextDocument({
                    content: code,
                    language: 'python'
                });
                await vscode.window.showTextDocument(doc);
                break;
            case 'run':
                // Send to extension command to handle execution on device
                vscode.commands.executeCommand('micropython-ide.runCodeSnippet', code);
                break;
        }
    }

    _getPythonPath() {
        const config = vscode.workspace.getConfiguration('micropython-studio');
        return config.get('pythonPath') || 'python';
    }

    _getHtmlForWebview() {
        const htmlPath = path.join(this._extensionUri.fsPath, 'resource', 'aiAssistant.html');
        let html = fs.readFileSync(htmlPath, 'utf8');

        return html;
    }

    updateViewContext(data) {
        if (this._view) {
            this._view.webview.postMessage({ type: 'contextUpdate', value: data });
        }
    }
}

module.exports = { AiAssistanceProvider };
