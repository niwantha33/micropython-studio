/**
 * extension.js
 * main entry point 
 * @license MIT
 * @version 1.0
 * @author  Niwantha Meepage 
 */

const vscode = require('vscode');
const path = require('path');
const { setupVirtualEnv } = require('./setupEnv');
const { creatNewProject } = require('./createNewProject');
const { getValidDevicePort } = require('./refreshSettings')
const { passCommandMpremoteTerminal } = require('./runCommand')
const { getVenvPythonPathFolder, getVenvPythonPath } = require('./commonFxn')

/***********************************Global Variables**********************************************************************/
const outputChannel = vscode.window.createOutputChannel("MicroPython IDE");

let gMpremoteTerminal = null;
let gRemoteDevicePort = null;
let gdeviceCodeDir = null;
/***********************************Global Variables -  END***************************************************************/
function getMpremoteTerminal() {

    if (!gMpremoteTerminal || gMpremoteTerminal.exitStatus) {
        gMpremoteTerminal = vscode.window.createTerminal({
            name: "MicroPython-Studio",
            hideFromUser: false  // Changed to false to make it visible to users
        });
    }
    return gMpremoteTerminal;
}

function activate(context) {
    console.log('MicroPython IDE extension activated');
    checkPythonAvailability();
    showButtonsInTaskbar(context);

    let commandObject = new Object();
    commandObject.repl = false;


    const setupEnvCommand = vscode.commands.registerCommand('micropython-ide.setupEnvironment', async () => {
        await setupVirtualEnv(context, getOutputChannel());
    });
    context.subscriptions.push(setupEnvCommand);

    const createNewProjectCommand = vscode.commands.registerCommand('micropython-ide.createNewProject', async () => {
        await creatNewProject(context);
    });
    context.subscriptions.push(createNewProjectCommand);

    let launchIdeCommand = vscode.commands.registerCommand('micropython-ide.launchIde', async () => {
        try {
            await vscode.commands.executeCommand('micropython-ide.refreshMcuFolder');

        } catch {
            vscode.window.showErrorMessage('Micropython Studio Launching Error!');
        }
    });
    context.subscriptions.push(launchIdeCommand);

    let refreshMcuFolderCommand = vscode.commands.registerCommand('micropython-ide.refreshMcuFolder', async (resource) => {
        vscode.window.showInformationMessage("Refresh MicroPython Communication Settings...");
        const comValues = await getValidDevicePort(resource);
        gRemoteDevicePort = comValues[0];
        gdeviceCodeDir = comValues[1];
        console.log(gRemoteDevicePort, gdeviceCodeDir);
    });
    context.subscriptions.push(refreshMcuFolderCommand);

    let openShellCommand = vscode.commands.registerCommand('micropython-ide.openShell', async () => {
        const venvFolder = getVenvPythonPathFolder();
        const venvPython = getVenvPythonPath(venvFolder);

        const terminal = getMpremoteTerminal();

        terminal.sendText(`"${venvPython}" -m mpremote connect ${gRemoteDevicePort} resume repl`);
        terminal.show();

    });
    context.subscriptions.push(openShellCommand);

    let mountMainFolderCommand = vscode.commands.registerCommand('micropython-ide.mountMainFolder', async () => {

        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showWarningMessage('No file open to run.');
            return;
        }

        const filePath = editor.document.fileName;
        const fileName = path.basename(filePath);

        // ✅ Define your allowed folder (e.g., gdeviceCodeDir or workspace root)
        const projectFolder = gdeviceCodeDir; // e.g., "c:\\My-Projects\\test7\\test7\\main"

        // 🔍 Check if file is inside the allowed folder
        if (!isFileInProjectFolder(filePath, projectFolder)) {
            const choice = await vscode.window.showWarningMessage(
                `File "${fileName}" is not in the main project folder.`,
                'Allow Anyway', 'Cancel'
            );
            if (choice !== 'Allow Anyway') {
                return;
            }
        }


        const venvFolder = getVenvPythonPathFolder();
        const venvPython = getVenvPythonPath(venvFolder);

        const terminal = getMpremoteTerminal();
       
        const scriptPath = path.join(context.extensionPath, 'src', 'mpremotesubpro.py');
         
        const activeFile = editor.document.fileName; // e.g., main.py

        const cmd = [
            `"${venvPython}"`,
            `"${scriptPath}"`,
            `--python "${venvPython}"`,
            `run`,
            `--port "${gRemoteDevicePort}"`,
            `--folder "${gdeviceCodeDir}"`,
            `--file "${activeFile}"`
        ].join(' ');

        terminal.sendText(cmd);




        // // Build the full command with --python FIRST
        // const cmd = `--python "${venvPython}" mount --port "${gRemoteDevicePort}" --folder "${gdeviceCodeDir}"`;

        // // Send: "python.exe" "mpremotesubpro.py" --python "..." mount ...
        // terminal.sendText(`"${venvPython}" "${scriptPath}" ${cmd}`);
        terminal.show();

    });
    context.subscriptions.push(mountMainFolderCommand);

    let umountMainFolderCommand = vscode.commands.registerCommand('micropython-ide.unmoutFolder', async () => {
        const venvFolder = getVenvPythonPathFolder();
        const venvPython = getVenvPythonPath(venvFolder); // e.g. ...\.venv\Scripts\python.exe



        const scriptPath = path.join(context.extensionPath, 'src', 'mpremotesubpro.py');

        const terminal = getMpremoteTerminal();
        terminal.sendText(`"${venvPython}" "${scriptPath}"`);

    });
    context.subscriptions.push(umountMainFolderCommand);
}




function checkPythonAvailability() {
    const { exec } = require('child_process');
    exec('python --version', (err) => {
        if (err) {
            vscode.window.showWarningMessage('Python not found in PATH');
        }
    });
}

function isFileInProjectFolder(filePath, projectFolder) {
    const relative = path.relative(projectFolder, filePath);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
}


/**********************************************************USER-CODE**********************************************************/
function getOutputChannel() {
    outputChannel.show(true); // Opens the channel so the user sees output
    return outputChannel;
}

function showButtonsInTaskbar(context) {
    // Create Activity Bar icon
    const activeBaronMcuButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    activeBaronMcuButton.text = `$(folder) Open Project`;
    activeBaronMcuButton.tooltip = `Open Existing Workspace`;
    activeBaronMcuButton.command = 'micropython-ide.openExistingProjectFolder';
    context.subscriptions.push(activeBaronMcuButton);
    activeBaronMcuButton.show();

    const syncRTC_OnMcuButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    syncRTC_OnMcuButton.text = `$(terminal) Shell`;
    syncRTC_OnMcuButton.tooltip = `Open shell on MicroPython device`;
    syncRTC_OnMcuButton.command = 'micropython-ide.openShell';
    context.subscriptions.push(syncRTC_OnMcuButton);
    syncRTC_OnMcuButton.show();

    const autoSyncMcuButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    autoSyncMcuButton.text = `$(sync) Enable Auto Sync`;
    autoSyncMcuButton.tooltip = `Enable Auto Sync Device Folder & MicroPython device`;
    autoSyncMcuButton.command = 'micropython-ide.mountMainFolder';
    context.subscriptions.push(autoSyncMcuButton);
    autoSyncMcuButton.show();
    // Create a green "Run on MCU" button in status bar
    const runOnMcuButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    runOnMcuButton.text = `$(play) Run on MCU`;
    // runOnMcuButton.backgroundColor='blue'
    // runOnMcuButton.color = 'green'
    runOnMcuButton.tooltip = `Run current script on MicroPython device`;
    runOnMcuButton.command = 'micropython-ide.runThisScriptOnMcuConsole';
    context.subscriptions.push(runOnMcuButton);
    runOnMcuButton.show();

    // Create a green "Run on MCU" button in status bar
    const stopOnMcuButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    stopOnMcuButton.text = `$(stop) Stop Run`;
    stopOnMcuButton.color = 'red'
    stopOnMcuButton.tooltip = `Stop current running script on MicroPython device`;
    stopOnMcuButton.command = 'micropython-ide.stopRun';
    context.subscriptions.push(stopOnMcuButton);
    stopOnMcuButton.show();

    // Create a green "Run on MCU" button in status bar
    const unmountMcuButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    unmountMcuButton.text = `$(stop) Unmont`;
    unmountMcuButton.color = 'yellow'
    unmountMcuButton.tooltip = `Unmount current running script on MicroPython device`;
    unmountMcuButton.command = 'micropython-ide.unmoutFolder';
    context.subscriptions.push(unmountMcuButton);
    unmountMcuButton.show();
}

// Dispose of the terminal cleanly
function disposeMpremoteTerminal() {
    if (gMpremoteTerminal) {
        gMpremoteTerminal = null;
    }
}

function hasMpremoteTerminal() {
    return gMpremoteTerminal !== null &&
        gMpremoteTerminal.exitStatus === undefined;
}
module.exports = { activate };