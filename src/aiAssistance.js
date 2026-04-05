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

        const deviceContext = await this._getContext();
        let systemContext = `[Device Environment]\n- Port: ${deviceContext.port}\n- Firmware: ${deviceContext.firmware}\n`;
        if (deviceContext.config) systemContext += `- Config: ${deviceContext.config}\n`;
        if (deviceContext.stubsPath) systemContext += `- Target Stubs: ${deviceContext.stubsPath}\n`;

        const fullMessageWithContext = `${systemContext}\n${fileContext}\n\nUSER MESSAGE: ${message}`;

        // Add user message to history
        this._history.push({ role: 'user', content: fullMessageWithContext });
        
        // Limit history size
        if (this._history.length > 30) {
            this._history = this._history.slice(-30);
        }

        const messagesJson = JSON.stringify(this._history);
        
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
            case 'insert':
                const editor = vscode.window.activeTextEditor;
                if (editor) {
                    editor.edit(editBuilder => {
                        editBuilder.insert(editor.selection.active, code);
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

        // Replace any relative paths with webview URIs if needed
        // For simple html-only components this is enough.
        return html;
    }
}

module.exports = { AiAssistanceProvider };
