// vsce package
// code --install-extension my-extension-0.0.1.vsix
const vscode = require('vscode');
const { exec } = require('child_process');
 
// user defined functions 
const { setupVirtualEnv } = require('./setupEnv');

// At the top-level (module scope)
const outputChannel = vscode.window.createOutputChannel("MicroPython IDE");

// Main activation function
function activate(context) {
    checkPythonAvailability();
    let setupEnvCommand = vscode.commands.registerCommand('micropython-ide.setupEnvironment', async () => {
        await setupVirtualEnv(context, outputChannel);
    });
    context.subscriptions.push(setupEnvCommand);       
}

// Function 1: Python availability check
function checkPythonAvailability() { // 👈 Accept vscode as an argument
    exec('python --version', (err) => {
        if (err) {
            vscode.window.showWarningMessage(
                'Python not found in PATH. Try installing Python or using python3.'
            );
            return 
        }
    });
}


module.exports = { activate};