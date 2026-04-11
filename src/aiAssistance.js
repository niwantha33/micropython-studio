const path = require('path');
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const vscode = require('vscode');
const os = require('os');

const OLLAMA_HOST = '127.0.0.1';
const OLLAMA_PORT = 11434;

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
                    break;
            }
        });

        // initial check
        this._checkOllamaStatus();
    }

    // ─── Ollama HTTP Helper (used only for chat streaming) ─────

    /**
     * Make a streaming HTTP request to the Ollama API.
     * Parses NDJSON and calls onChunk(parsedJson) for each line.
     */
    _ollamaStream(apiPath, body, onChunk) {
        return new Promise((resolve, reject) => {
            const options = {
                hostname: OLLAMA_HOST,
                port: OLLAMA_PORT,
                path: apiPath,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            };

            const req = http.request(options, (res) => {
                if (res.statusCode !== 200) {
                    let errData = '';
                    res.on('data', chunk => errData += chunk);
                    res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${errData}`)));
                    return;
                }

                let buffer = '';
                res.on('data', chunk => {
                    buffer += chunk.toString();
                    const lines = buffer.split('\n');
                    buffer = lines.pop(); // keep incomplete line in buffer
                    for (const line of lines) {
                        if (!line.trim()) continue;
                        try {
                            onChunk(JSON.parse(line));
                        } catch { /* skip malformed JSON */ }
                    }
                });
                res.on('end', () => {
                    // Process any remaining data in buffer
                    if (buffer.trim()) {
                        try { onChunk(JSON.parse(buffer)); } catch { /* ignore */ }
                    }
                    resolve();
                });
            });

            req.on('error', reject);
            req.write(JSON.stringify(body));
            req.end();
        });
    }

    // ─── Status Check (via Python — reliable across firewalls) ──

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

                // ── Auto-reinstall if models are outdated ──────────
                if (status.connected && status.installed) {
                    const savedVersion = this._context.globalState.get('aiModelVersion', '0.0.0');
                    if (savedVersion < AiAssistanceProvider.MODEL_VERSION) {
                        console.log(`[AI] Models outdated (${savedVersion} < ${AiAssistanceProvider.MODEL_VERSION}), auto-reinstalling...`);
                        this._installModel(true); // force reinstall
                    }
                }
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

    // ─── Model Installation (via Python — terminal speed) ───────

    // Version that requires model rebuild (bump this when Modelfiles change)
    static MODEL_VERSION = '0.8.4';

    async _installModel(forceReinstall = false) {
        const pythonPath = this._getPythonPath();
        const scriptPath = path.join(this._extensionUri.fsPath, 'src', 'ollama_helper.py');
        const modelfilePath = path.join(this._extensionUri.fsPath, 'resource', 'Modelfile-mpy');

        let command, args;
        if (forceReinstall) {
            this._view.webview.postMessage({ type: 'installProgress', value: 'Updating AI models (fixing code generation)...' });
            command = 'reinstall';
            args = [scriptPath, command, modelfilePath];
        } else {
            this._view.webview.postMessage({ type: 'installProgress', value: 'Pulling base model (2.3GB)...' });
            command = 'setup';
            args = [scriptPath, command, modelfilePath];
        }

        const proc = spawn(pythonPath, args);

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
                // Save the model version so we don't reinstall again
                this._context.globalState.update('aiModelVersion', AiAssistanceProvider.MODEL_VERSION);
                this._view.webview.postMessage({ type: 'installSuccess' });
                this._checkOllamaStatus();
            } else {
                this._view.webview.postMessage({ type: 'error', value: 'Model installation failed.' });
            }
        });
    }

    // ─── Chat (direct HTTP streaming — no Python, no CLI) ───────

    async _handleChat(message) {
        // -------------------------------
        // 1. FILE CONTEXT (current editor)
        // -------------------------------
        let fileContext = '';
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            const fileName = path.basename(editor.document.fileName);
            const fileContent = editor.document.getText();
            fileContext = `[Current File: ${fileName}]\n\`\`\`python\n${fileContent}\n\`\`\``;
        }
        const truncatedFileContext = fileContext.length > 2500
            ? fileContext.substring(0, 2500) + '\n... [truncated]'
            : fileContext;

        // -------------------------------
        // 2. CONTEXT + PLATFORM DETECTION
        // -------------------------------
        const contextData = await this._getContext();
        const firmware = this._firmwareOverride || contextData.firmware;
        const isCircuitPython = typeof firmware === 'string' && firmware.toLowerCase().includes('circuitpython');
        const modelName = isCircuitPython ? 'micro_ai-cpy' : 'micro_ai-mpy';
        // const aiFooter = isCircuitPython ? '[CircuitPython Studio AI]' : '[MicroPython Studio AI]';

        // -------------------------------
        // 3. DEVICE OUTPUT (read fresh each call)
        // -------------------------------
        let deviceOutput = '';
        const tmpFile = path.join(os.tmpdir(), 'mpremote-output.txt');
        try {
            if (fs.existsSync(tmpFile)) {
                deviceOutput = fs.readFileSync(tmpFile, 'utf-8').trim();
                fs.unlinkSync(tmpFile);
            }
        } catch { /* ignore read errors */ }

        // -------------------------------
        // 4. HISTORY MANAGEMENT (keep light for speed)
        // -------------------------------
        this._history.push({ role: 'user', content: message });
        if (this._history.length > 6) {
            this._history = this._history.slice(-6);
        }

        // -------------------------------
        // 5. SYSTEM CONTEXT
        // -------------------------------
        const systemContext = `[device]
port = ${contextData.port}
mcu = ${contextData.mcu}
device_firmware = ${firmware}
[filePath]
projectDir = "${contextData.projectDir}"
`;

        // -------------------------------
        // 6. FINAL PROMPT (ephemeral — not saved to history)
        // -------------------------------
        const latestPrompt = deviceOutput
            ? `${message}\n\n<device_output>\n${deviceOutput}\n</device_output>`
            : message + systemContext;

        // Replace last history entry with context-rich prompt for the API call
        const messagesToSend = [...this._history];
        messagesToSend[messagesToSend.length - 1] = { role: 'user', content: latestPrompt };

        // Signal UI to start loading
        this._view.webview.postMessage({ type: 'chatStart' });
        this._view.webview.postMessage({ type: 'chatStatus', value: `Connecting to ${modelName}...` });

        // -------------------------------
        // 7. STREAM via Ollama HTTP API
        // -------------------------------
        let fullResponse = '';
        let insideThinking = false;   // Track thinking block state
        let firstTokenReceived = false;

        try {
            this._view.webview.postMessage({ type: 'chatStatus', value: `Waiting for Micro AI to respond...` });

            await this._ollamaStream('/api/chat', {
                model: modelName,
                messages: messagesToSend,
                stream: true,
                options: {
                    temperature: 1,
                    top_p: 0.96,
                    top_k: 60,
                    num_ctx: 4096
                }
            }, (chunk) => {
                // Handle Ollama-level error inside stream
                if (chunk.error) {
                    this._view.webview.postMessage({
                        type: 'chatResponse',
                        value: `\n❌ ${chunk.error}`
                    });
                    return;
                }

                // Stream token to webview (filter out thinking blocks)
                if (chunk.message && chunk.message.content) {
                    let token = chunk.message.content;

                    // Detect thinking block boundaries
                    if (token.includes('Thinking...') || token.includes('Thinking Process:') || token.includes('<think>')) {
                        insideThinking = true;
                        this._view.webview.postMessage({ type: 'chatStatus', value: 'AI is thinking...' });
                        return;
                    }
                    if (token.includes('...done thinking.') || token.includes('</think>')) {
                        insideThinking = false;
                        this._view.webview.postMessage({ type: 'chatStatus', value: 'Generating response...' });
                        return;
                    }
                    // Skip tokens while inside thinking block
                    if (insideThinking) return;

                    // Signal first real token
                    if (!firstTokenReceived) {
                        firstTokenReceived = true;
                        this._view.webview.postMessage({ type: 'chatStatus', value: 'Generating response...' });
                    }

                    fullResponse += token;
                    this._view.webview.postMessage({ type: 'chatStream', value: token });
                }
            });

            // Post-process: clean up & save to history
            if (fullResponse.trim()) {
                let clean = fullResponse
                    .replace(/\n{4,}/g, '\n\n\n')               // Fix excessive blank lines
                    .replace(/\s*\[.*Studio AI\].*$/i, '')      // Remove old footer if present
                    .trim();

                if (fullResponse) {
                    // const finalResponse = `${clean}\n\n${aiFooter}`;
                    const finalResponse = `${fullResponse}\n\n`;
                    this._history.push({ role: 'assistant', content: finalResponse });
                    this._context.workspaceState.update('aiChatHistory', this._history);
                }
            }
            this._view.webview.postMessage({ type: 'chatDone' });

        } catch (err) {
            console.error('❌ Chat failed:', err);
            this._view.webview.postMessage({
                type: 'chatResponse',
                value: `\n❌ AI Error: ${err.message}`
            });
            this._view.webview.postMessage({ type: 'chatDone' });
        }
    }

    // ─── Code Actions ───────────────────────────────────────────

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

    /**
     * Automatically send a device error to the AI chat for investigation.
     * Called by extension.js when mpremote output contains a traceback/error.
     * @param {string} errorOutput - Raw error text captured from mpremote subprocess
     * @param {{port?:string, firmware?:string, file?:string}} deviceCtx
     */
    async autoInvestigateError(errorOutput, deviceCtx = {}) {
        if (!this._view) return;

        const contextData = await this._getContext();
        const firmware = this._firmwareOverride || deviceCtx.firmware || contextData.firmware || 'MicroPython';
        const port = deviceCtx.port || contextData.port || 'unknown';
        const file = deviceCtx.file || '';

        const message = `Device error detected${file ? ` in \`${file}\`` : ''} on ${port}. Investigate and suggest a fix:\n\n\`\`\`\n${errorOutput.trim()}\n\`\`\``;

        // Show the AI panel and inject the message as if the user sent it
        await vscode.commands.executeCommand('micropython-ide-ai-chat.focus');
        this._view.webview.postMessage({ type: 'autoError', value: message });

        await this._handleChat(message);
    }
}

module.exports = { AiAssistanceProvider };