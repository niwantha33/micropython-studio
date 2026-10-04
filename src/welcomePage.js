
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

function activateWelcome(context) {
    const hasShown = context.globalState.get('hasShownWelcome', false);
    if (!hasShown) {
        setTimeout(() => showWelcomePage(context), 1000);
        context.globalState.update('hasShownWelcome', true);
    }
    const disposable = vscode.commands.registerCommand('micropythonStudio.showWelcome', () => {
        showWelcomePage(context);
    });
    context.subscriptions.push(disposable);
}

function showWelcomePage(context) {
    const panel = vscode.window.createWebviewPanel(
        'micropythonStudioWelcome',
        'MicroPython Studio Pro - Welcome',
        vscode.ViewColumn.One,
        { enableScripts: true, localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'resource'))] }
    );
    const htmlPath = path.join(context.extensionPath, 'index.html');
    let htmlContent = '';
    try {
        if (fs.existsSync(htmlPath)) {
            htmlContent = fs.readFileSync(htmlPath, 'utf8');
        } else {
            htmlContent = getFallbackWelcomeHtml();
        }
    } catch (e) {
        htmlContent = getFallbackWelcomeHtml();
    }
    panel.webview.html = htmlContent;
    panel.webview.onDidReceiveMessage(message => {
        switch (message.command) {
            case 'install':
                vscode.commands.executeCommand('workbench.extensions.search', 'niwantha33.micropython-studio');
                break;
            case 'openDebugger':
                vscode.commands.executeCommand('micropythonStudio.startDebug');
                break;
        }
    });
}

function getFallbackWelcomeHtml() {
    return `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    body{background:#0A0A0B;color:#e4e4e7;font-family:sans-serif;margin:0;padding:40px}
    .badge{display:inline-flex;padding:6px 12px;border-radius:20px;background:rgba(0,122,204,0.1);border:1px solid rgba(0,122,204,0.2);font-size:11px;color:#7DD3FF;margin-bottom:20px}
    h1{font-size:48px;line-height:0.9}h1 span{color:#71717a}
    .btn{display:inline-flex;padding:12px 24px;border-radius:20px;background:white;color:black;text-decoration:none;font-weight:600;margin-top:20px}
    .features{display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:16px;margin-top:40px}
    .card{background:#111113;border:1px solid rgba(255,255,255,0.06);border-radius:16px;padding:20px}
    </style></head><body><div style="max-width:800px;margin:0 auto">
    <div class="badge">PAUSED at 0x0032 | ONLY BYTECODE DEBUGGER WITH ASYNC</div>
    <h1>The debugger<br><span>MicroPython</span><br>deserved.</h1>
    <p>Async-aware bytecode debugger for Pico 2 W, ESP32, RP2350. Your screenshots show real debug with Task Map and RTA.</p>
    <a class="btn" href="#" onclick="vscode.postMessage({command:'openDebugger'})">Start Debugging</a>
    <div class="features"><div class="card"><h3>Bytecode Debugger</h3><p>IP 0x0032, Continue, Step Over/In/Out</p></div><div class="card"><h3>Task Map</h3><p>Visualize asyncio tasks</p></div><div class="card"><h3>Live Pinout</h3><p>RP2350 real-time pin states</p></div><div class="card"><h3>Device Dashboard</h3><p>Telemetry, file explorer</p></div></div>
    <p style="margin-top:40px;font-size:12px;color:#52525b;">Made in Titchfield, UK by Niwantha - FREE for testing now</p></div><script>const vscode=acquireVsCodeApi();</script></body></html>`;
}

module.exports = { activateWelcome, showWelcomePage };
