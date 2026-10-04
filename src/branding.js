
const vscode = require('vscode');
function activateBranding(context) {
    const BRAND_KEY = 'niwantha.brand.lastShown';
    const DONT_SHOW_KEY = 'niwantha.brand.dontShow';
    const brandStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
    brandStatus.text = "$(person) niwantha meepage";
    brandStatus.tooltip = "MicroPython Studio by niwantha meepage | All Picos & ESP32 | Buy me a beer? 🍺";
    brandStatus.command = "micropythonStudio.showSupport";
    brandStatus.show();
    context.subscriptions.push(brandStatus);
    const supportCmd = vscode.commands.registerCommand('micropythonStudio.showSupport', () => {
        showSupportPanel(context);
    });
    context.subscriptions.push(supportCmd);
    const dontShow = context.globalState.get(DONT_SHOW_KEY, false);
    if (dontShow) return;
    const lastShown = context.globalState.get(BRAND_KEY, 0);
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    if (now - lastShown > oneDay) {
        setTimeout(() => {
            vscode.window.showInformationMessage(
                "MicroPython Studio by niwantha meepage — Free & Open • Buy me a beer? 🍺",
                "⭐ Star on GitHub",
                "☕ Buy me a beer",
                "Don't show again"
            ).then(selection => {
                if (selection === "⭐ Star on GitHub") {
                    vscode.env.openExternal(vscode.Uri.parse('https://github.com/niwantha33/micropython-studio'));
                } else if (selection === "☕ Buy me a beer") {
                    showSupportPanel(context);
                } else if (selection === "Don't show again") {
                    context.globalState.update(DONT_SHOW_KEY, true);
                }
                context.globalState.update(BRAND_KEY, now);
            });
        }, 3000);
    }
}
function showSupportPanel(context) {
    const panel = vscode.window.createWebviewPanel('niwanthaBranding','MicroPython Studio — by niwantha meepage',vscode.ViewColumn.One,{enableScripts:true});
    panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    body{background:#1e1e1e;color:#cccccc;font-family:sans-serif;padding:40px;max-width:700px;margin:0 auto}
    h1{color:white;font-size:28px} .sub{color:#858585;font-size:14px;margin-bottom:30px}
    .card{background:#252526;border:1px solid #3c3c3c;border-radius:12px;padding:24px;margin-bottom:16px}
    .brand{display:flex;align-items:center;gap:16px;margin-bottom:24px}
    .avatar{width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#007ACC,#FF6B35);display:flex;align-items:center;justify-content:center;font-weight:bold;font-size:20px;color:white}
    .name{font-size:20px;font-weight:600;color:white} .loc{font-size:13px;color:#858585}
    .links{display:flex;gap:12px;flex-wrap:wrap;margin-top:20px}
    .btn{padding:10px 20px;border-radius:20px;text-decoration:none;font-size:13px;font-weight:500;display:inline-flex;align-items:center;gap:8px}
    .btn-primary{background:white;color:black} .btn-secondary{background:#3c3c3c;color:white;border:1px solid #5a5a5a}
    .small{font-size:11px;color:#6a6a6a;margin-top:30px;text-align:center}
    </style></head><body>
    <div class="brand"><div class="avatar">nm</div><div><div class="name">niwantha meepage</div><div class="loc">Titchfield, UK • All Picos & ESP32 • RP2040/RP2350</div><div class="loc">Builder of MicroPython Studio - Async-aware bytecode debugger</div></div></div>
    <h1>Free & Open. Built with passion.</h1>
    <p class="sub">Supports All Raspberry Pi Picos (RP2040, RP2350, Pico, Pico W, Pico 2, Pico 2 W) & ESP32. Free & Open Source.</p>
    <div class="card"><h3 style="margin-top:0;color:white">Features</h3><p style="font-size:13px;line-height:1.8">• Device Dashboard: System Info, RAM 12%, Flash 6%, CPU 150MHz<br>• Pinout: Live Raspberry Pi Pico 2 W RP2350 visualization<br>• Package Manager: Search & install MicroPython libs<br>• WiFi Manager & Remote Upload<br>• Bytecode Debugger: PAUSED at 0x0032, RTA, Task Map</p></div>
    <div class="card"><h3 style="margin-top:0;color:white">Support (optional) - Buy me a beer?</h3><p style="font-size:13px;color:#858585;margin-bottom:16px">If this saves you time, buy me a beer to keep this project alive.</p><div class="links"><a class="btn btn-primary" href="https://github.com/niwantha33/micropython-studio" target="_blank">⭐ Star on GitHub</a><a class="btn btn-secondary" href="https://github.com/sponsors/niwantha33" target="_blank">❤️ GitHub Sponsors</a><a class="btn btn-secondary" href="https://www.buymeacoffee.com/niwantha" target="_blank">🍺 Buy me a beer</a></div></div>
    <p class="small">By niwantha meepage • Free & Open • MIT • All Picos & ESP32 Supported</p>
    </body></html>`;
}
module.exports = { activateBranding, showSupportPanel };
