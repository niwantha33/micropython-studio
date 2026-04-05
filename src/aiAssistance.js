const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');

class AiAssistanceProvider {
    constructor(_extensionUri, _context) {
        this._extensionUri = _extensionUri;
        this._context = _context;
        this._view = undefined;
        this._history = []; // Initialize history
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
                    break;
            }
        });

        // initial check
        this._checkOllamaStatus();
    }

    async _checkOllamaStatus() {
        const pythonPath = this._getPythonPath();
        const scriptPath = path.join(this._extensionUri.fsPath, 'src', 'ollama_helper.py');

        // 🔥 Use spawn but with early notification
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

        // Add user message to history
        this._history.push({ role: 'user', content: message });
        
        // Limit history to last 10 exchanges to keep prompt size reasonable
        if (this._history.length > 20) {
            this._history = this._history.slice(-20);
        }

        const messagesJson = JSON.stringify(this._history);
        const proc = spawn(pythonPath, [scriptPath, 'chat', messagesJson]);
        
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
            // Add AI response to history
            this._history.push({ role: 'assistant', content: fullResponse });
            this._view.webview.postMessage({ type: 'chatDone' });
        });
    }

    _getPythonPath() {
        // Attempt to use the venv python if available
        const venvPythonPath = path.join(process.env.USERPROFILE, '.micropython-studio', '.venv', 'Scripts', 'python.exe');
        return fs.existsSync(venvPythonPath) ? venvPythonPath : 'python';
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
