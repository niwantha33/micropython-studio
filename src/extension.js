const vscode = require('vscode');
const UARTDebugger = require('./debugProb');
const { setupVirtualEnv } = require('./setupEnv');
const { creatNewProject } = require('./createNewProject');

const outputChannel = vscode.window.createOutputChannel("MicroPython IDE");
let debuggerInstance = null;

function activate(context) {
    console.log('MicroPython IDE extension activated');
    checkPythonAvailability();   

    const setupEnvCommand = vscode.commands.registerCommand('micropython-ide.setupEnvironment', async () => {
        await setupVirtualEnv(context, outputChannel);
    });
    context.subscriptions.push(setupEnvCommand);

    const createNewProjectCommand = vscode.commands.registerCommand('micropython-ide.createNewProject', async () => {
        await creatNewProject(context, outputChannel);
    });
    context.subscriptions.push(createNewProjectCommand);  
}

function checkPythonAvailability() {
    const { exec } = require('child_process');
    exec('python --version', (err) => {
        if (err) {
            vscode.window.showWarningMessage('Python not found in PATH');
        }
    });
}

function deactivate() {
    if (debuggerInstance) debuggerInstance.dispose();
}

module.exports = { activate, deactivate };