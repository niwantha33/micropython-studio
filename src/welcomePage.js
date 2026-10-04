
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
function activateWelcome(context) {
    const hasShown = context.globalState.get('hasShownWelcome', false);
    if (!hasShown) {
        setTimeout(() => showWelcomePage(context), 1500);
        context.globalState.update('hasShownWelcome', true);
    }
    const disposable = vscode.commands.registerCommand('micropythonStudio.showWelcome', () => {
        showWelcomePage(context);
    });
    context.subscriptions.push(disposable);
}
function showWelcomePage(context) {
    const panel = vscode.window.createWebviewPanel('micropythonStudioWelcome','MicroPython Studio — by niwantha meepage',vscode.ViewColumn.One,{enableScripts:true, localResourceRoots:[vscode.Uri.file(path.join(context.extensionPath,'resource'))]});
    const htmlPath = path.join(context.extensionPath, 'docs', 'index.html');
    let htmlContent = '';
    try {
        if (fs.existsSync(htmlPath)) {
            htmlContent = fs.readFileSync(htmlPath, 'utf8');
        } else {
            htmlContent = '<html><body style="background:#0A0A0B;color:white;padding:40px">MicroPython Studio by niwantha meepage - Free & Open Source</body></html>';
        }
    } catch (e) {
        htmlContent = '<html><body>Welcome to MicroPython Studio by niwantha meepage</body></html>';
    }
    panel.webview.html = htmlContent;
}
module.exports = { activateWelcome, showWelcomePage };
