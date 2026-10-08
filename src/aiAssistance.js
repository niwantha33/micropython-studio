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
        this._selectedModel = this._context.workspaceState.get('aiSelectedModel', '');
        this._models = [];
        this._chatBusy = false;
        this._installationBusy = false;
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
                case 'setModel':
                    if (typeof data.value === 'string' && this._models.includes(data.value)) {
                        this._selectedModel = data.value;
                        await this._context.workspaceState.update('aiSelectedModel', data.value);
                    }
                    break;
                case 'openLink':
                    if (data.value === 'https://ollama.com') {
                        await vscode.env.openExternal(vscode.Uri.parse(data.value));
                    }
                    break;
            }
        });

        // initial check
        this._checkOllamaStatus();
    }

    // Ollama is local to the user's machine; no Python process or pip
    // installation is needed for discovery or streamed chat.
    _ollamaStatus() {
        return new Promise((resolve, reject) => {
            const req = http.get({
                hostname: OLLAMA_HOST, port: OLLAMA_PORT, path: '/api/tags'
            }, res => {
                let data = '';
                if (res.statusCode !== 200) {
                    res.resume();
                    reject(new Error(`Ollama model discovery returned HTTP ${res.statusCode}`));
                    return;
                }
                res.on('data', chunk => {
                    data += chunk.toString('utf8');
                    if (data.length > 1024 * 1024) req.destroy(new Error('Ollama model list too large'));
                });
                res.on('end', () => {
                    try {
                        const names = JSON.parse(data).models || [];
                        resolve(names.map(m => m.name).filter(n => typeof n === 'string'));
                    } catch (e) { reject(e); }
                });
                res.on('error', reject);
            });
            req.setTimeout(5000, () => req.destroy(new Error('Ollama status timed out')));
            req.on('error', reject);
        });
    }

    _ollamaStream(apiPath, body, onChunk) {
        return new Promise((resolve, reject) => {
            let finished = false;
            const done = (err) => {
                if (finished) return;
                finished = true;
                if (err) reject(err); else resolve();
            };
            const req = http.request({
                hostname: OLLAMA_HOST, port: OLLAMA_PORT, path: apiPath,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' }
            }, res => {
                if (res.statusCode !== 200) {
                    let reason = '';
                    res.on('data', c => { reason += c.toString(); if (reason.length > 4096) reason = reason.slice(0, 4096); });
                    res.on('end', () => done(new Error(`Ollama HTTP ${res.statusCode}: ${reason}`)));
                    res.on('error', done);
                    return;
                }
                let buffer = '';
                let complete = false;
                const parse = (line) => {
                    if (!line.trim() || finished) return;
                    const chunk = JSON.parse(line);
                    if (chunk.error) throw new Error(String(chunk.error));
                    onChunk(chunk);
                    if (chunk.done === true) complete = true;
                };
                res.on('data', chunk => {
                    if (finished) return;
                    buffer += chunk.toString('utf8');
                    if (buffer.length > 1024 * 1024) {
                        req.destroy(new Error('Ollama response line too large'));
                        return;
                    }
                    let index;
                    try {
                        while ((index = buffer.indexOf('\n')) !== -1) {
                            const line = buffer.slice(0, index);
                            buffer = buffer.slice(index + 1);
                            parse(line);
                        }
                    } catch (err) { req.destroy(err); }
                });
                res.on('end', () => {
                    try {
                        if (buffer.trim()) parse(buffer);
                        done(complete ? null : new Error('Ollama ended before completing the response'));
                    } catch (err) { done(err); }
                });
                res.on('aborted', () => done(new Error('Ollama closed the connection')));
                res.on('error', done);
            });
            req.setTimeout(120000, () => req.destroy(new Error('Ollama stopped responding for 120 seconds')));
            req.on('error', done);
            req.end(JSON.stringify(body));
        });
    }

    async _checkOllamaStatus() {
        try {
            const models = await this._ollamaStatus();
            this._models = models;
            if (this._selectedModel && !models.includes(this._selectedModel)) {
                this._selectedModel = '';
                await this._context.workspaceState.update('aiSelectedModel', '');
            }
            const status = {
                connected: true,
                installed: models.length > 0,
                mpy: models.some(m => m === 'micro_ai-mpy' || m.startsWith('micro_ai-mpy:')),
                cpy: models.some(m => m === 'micro_ai-cpy' || m.startsWith('micro_ai-cpy:')),
                models,
                selectedModel: this._selectedModel
            };
            this._view?.webview.postMessage({ type: 'status', value: status });
        } catch (err) {
            this._models = [];
            this._view?.webview.postMessage({
                type: 'status', value: { connected: false, installed: false, models: [], error: err.message }
            });
        }
    }

    // ─── Model Installation (via Python — terminal speed) ───────

    // Version that requires model rebuild (bump this when Modelfiles change)
    static MODEL_VERSION = '0.8.4';

    async _installModel(forceReinstall = false) {
        if (this._installationBusy) return;
        this._installationBusy = true;
        const pythonPath = this._getPythonPath();
        const scriptPath = path.join(this._extensionUri.fsPath, 'src', 'ollama_helper.py');
        const modelfilePath = path.join(this._extensionUri.fsPath, 'resource', 'Modelfile-mpy');

        let command, args;
        if (forceReinstall) {
            if (this._view) {
                this._view.webview.postMessage({ type: 'installProgress', value: 'Updating AI models (fixing code generation)...' });
            }
            command = 'reinstall';
            args = [scriptPath, command, modelfilePath];
        } else {
            if (this._view) {
                this._view.webview.postMessage({ type: 'installProgress', value: 'Pulling base model (2.3GB)...' });
            }
            command = 'setup';
            args = [scriptPath, command, modelfilePath];
        }

        let proc;
        try { proc = spawn(pythonPath, args); }
        catch (err) {
            this._installationBusy = false;
            this._view?.webview.postMessage({ type: 'error', value: err.message });
            return;
        }
        let buffer = '';
        let installFailed = false;
        let finished = false;
        const fail = message => {
            if (finished) return;
            finished = true;
            this._installationBusy = false;
            this._view?.webview.postMessage({ type: 'error', value: message });
        };
        proc.on('error', err => fail('Cannot run local model installer: ' + err.message));
        const timer = setTimeout(() => { proc.kill(); fail('Model installation timed out (15 minutes)'); }, 15 * 60 * 1000);
        proc.stdout.on('data', (d) => {
            buffer += d.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                try {
                    const status = JSON.parse(line.trim());
                    if (status.error || status.success === false) {
                        installFailed = true;
                        this._view?.webview.postMessage({ type: 'installProgress', value: status.error || 'Model creation failed' });
                    }
                    if (status.status) {
                        let msg = status.status;
                        if (status.total && status.completed) {
                            const percent = Math.round((status.completed / status.total) * 100);
                            msg += `: ${percent}%`;
                        }
                        if (this._view) {
                            this._view.webview.postMessage({ type: 'installProgress', value: msg });
                        }
                    }
                } catch (e) {
                    // Not JSON or partial, ignore
                }
            }
        });

        proc.on('close', (code) => {
            clearTimeout(timer);
            if (finished) return;
            finished = true;
            this._installationBusy = false;
            if (code === 0 && !installFailed) {
                // Save the model version so we don't reinstall again
                this._context.globalState.update('aiModelVersion', AiAssistanceProvider.MODEL_VERSION);
                if (this._view) {
                    this._view.webview.postMessage({ type: 'installSuccess' });
                }
                this._checkOllamaStatus();
            } else {
                if (this._view) {
                    this._view.webview.postMessage({ type: 'error', value: 'Model installation failed.' });
                }
            }
        });
    }

    // ─── Chat (direct HTTP streaming — no Python, no CLI) ───────

    async _handleChat(message) {
        if (this._chatBusy) return;
        const initialHistory = this._history.slice();
        this._chatBusy = true;
        try {
            await this._runChat(message);
        } catch (err) {
            this._history = initialHistory;
            this._view?.webview.postMessage({ type: 'chatResponse', value: '\n❌ AI Error: ' + err.message });
            this._view?.webview.postMessage({ type: 'chatDone' });
        } finally {
            this._chatBusy = false;
        }
    }

    async _runChat(message) {
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
        const preferred = isCircuitPython ? 'micro_ai-cpy' : 'micro_ai-mpy';
        const preferredInstalled = this._models.find(m => m === preferred || m.startsWith(preferred + ':'));
        const modelName = this._models.includes(this._selectedModel) && this._selectedModel
            ? this._selectedModel
            : (preferredInstalled || this._models[0]);
        if (!modelName) throw new Error('No Ollama model installed. Open Local AI setup first.');
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
	${truncatedFileContext}
	`;

        // -------------------------------
        // 6. FINAL PROMPT (ephemeral — not saved to history)
        // -------------------------------
        const latestPrompt = `${message}\n\n${systemContext}` +
            (deviceOutput ? `\n\n<device_output>\n${deviceOutput.slice(0, 4000)}\n</device_output>` : '');

        // Replace last history entry with context-rich prompt for the API call
        const messagesToSend = [...this._history];
        messagesToSend[messagesToSend.length - 1] = { role: 'user', content: latestPrompt };

        // Signal UI to start loading
        this._view.webview.postMessage({ type: 'chatStart' });
        this._view.webview.postMessage({ type: 'chatStatus', value: `Sending context to ${modelName}...` });

        // -------------------------------
        // 7. STREAM via Ollama HTTP API
        // Accumulate-then-diff: collects all tokens (including <think> blocks),
        // strips thinking via regex on the full text, sends only visible deltas.
        // This handles </think> split across tokens correctly.
        // -------------------------------
        let rawAccumulated = '';
        let sentLength = 0;
        let statusState = 'init'; // 'init' | 'thinking' | 'generating'

        try {
            this._view.webview.postMessage({ type: 'chatStatus', value: `AI is thinking...` });

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
                 if (chunk.message && chunk.message.content) {
                    rawAccumulated += chunk.message.content;

                    // Strip completed <think>...</think> blocks from full accumulated text
                    let visible = rawAccumulated.replace(/<think>[\s\S]*?<\/think>/g, '');

                    // Check for unclosed <think> block (model still reasoning)
                    const unclosedIdx = visible.lastIndexOf('<think>');
                    const isThinking = unclosedIdx !== -1;
                    if (isThinking) {
                        visible = visible.substring(0, unclosedIdx);
                    }

                    // Update status on state transitions
                    if (isThinking && statusState !== 'thinking') {
                        statusState = 'thinking';
                        this._view.webview.postMessage({ type: 'chatStatus', value: 'AI is thinking...' });
                    }

                    // Send new visible content to webview
                    if (visible.length > sentLength) {
                        if (statusState !== 'generating') {
                            statusState = 'generating';
                            this._view.webview.postMessage({ type: 'chatStatus', value: 'Generating response...' });
                        }
                        const delta = visible.substring(sentLength);
                        sentLength = visible.length;
                        this._view.webview.postMessage({ type: 'chatStream', value: delta });
                    }
                }
            });

            // Post-process: clean visible response for history
            let fullResponse = rawAccumulated
                .replace(/<think>[\s\S]*?<\/think>/g, '')
                .replace(/<think>[\s\S]*$/, '')
                .replace(/\n{4,}/g, '\n\n\n')
                .replace(/\s*\[.*Studio AI\].*$/i, '')
                .trim();

            if (fullResponse) {
                this._history.push({ role: 'assistant', content: `${fullResponse}\n\n` });
                this._context.workspaceState.update('aiChatHistory', this._history);
            }
            this._view.webview.postMessage({ type: 'chatDone' });
        } catch (err) {
            throw err;
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
            case 'run': {
                // Model-generated code is untrusted and may reset/change hardware.
                const approval = await vscode.window.showWarningMessage(
                    'Run AI-generated code on the connected device? Review pin assignments, peripheral access and file operations first.',
                    { modal: true },
                    'Run on device'
                );
                if (approval === 'Run on device') {
                    await vscode.commands.executeCommand('micropython-ide.runCodeSnippet', code);
                }
                break;
            }
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

        const message = `${firmware} device error detected${file ? ` in \`${file}\`` : ''} on ${port}. Investigate and suggest a fix:\n\n\`\`\`\n${errorOutput.trim()}\n\`\`\``;

        // Show the AI panel and inject the message as if the user sent it
        await vscode.commands.executeCommand('micropython-ide-ai-chat.focus');
        this._view.webview.postMessage({ type: 'autoError', value: message });

        await this._handleChat(message);
    }
}

module.exports = { AiAssistanceProvider };
