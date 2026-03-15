/**
 * extension.js
 * Main entry point for MicroPython Studio VS Code extension
 * @license MIT
 * @version 2.0
 * @author  Niwantha Meepage
 */

const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');
const { setupVirtualEnv } = require('./setupEnv');
const { createNewProject } = require('./createNewProject');
const { getValidDevicePort } = require('./refreshSettings');
const { getVenvPythonPathFolder, getVenvPythonPath } = require('./commonFxn');
const { DeviceFileExplorerProvider, readDeviceFile, deleteDeviceFile } = require('./deviceFileExplorer');

// ─── Global State ────────────────────────────────────────────────────────────

const outputChannel = vscode.window.createOutputChannel('MicroPython IDE');

let gMpremoteTerminal = null;
let gRemoteDevicePort = null;
let gDeviceCodeDir = null;
let currentTarget = 'Host';

// ─── Status Bar Items (stored for cleanup) ───────────────────────────────────

let deviceStatusBarItem = null;
let deviceFileExplorer = null;

// ─── Terminal Management ─────────────────────────────────────────────────────

/**
 * Get or create the MicroPython terminal.
 * Reuses existing terminal if it's still alive.
 */
function getMpremoteTerminal() {
    if (!gMpremoteTerminal || gMpremoteTerminal.exitStatus) {
        gMpremoteTerminal = vscode.window.createTerminal({
            name: 'MicroPython Studio',
            hideFromUser: false
        });
    }
    return gMpremoteTerminal;
}

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Check if a file path is inside the given project folder.
 */
function isFileInProjectFolder(filePath, projectFolder) {
    if (!projectFolder) return false;
    const relative = path.relative(projectFolder, filePath);
    return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Check if Python is available on the system.
 */
function checkPythonAvailability() {
    exec('python --version', (err) => {
        if (err) {
            exec('python3 --version', (err2) => {
                if (err2) {
                    vscode.window.showWarningMessage(
                        'Python not found in PATH. MicroPython Studio requires Python 3.7+.'
                    );
                }
            });
        }
    });
}

/**
 * Show the output channel to the user and return it.
 */
function getOutputChannel() {
    outputChannel.show(true);
    return outputChannel;
}

/**
 * Update the device status bar indicator.
 */
function updateDeviceStatusBar() {
    if (!deviceStatusBarItem) return;

    if (gRemoteDevicePort) {
        deviceStatusBarItem.text = `$(plug) ${gRemoteDevicePort}`;
        deviceStatusBarItem.tooltip = `Connected to ${gRemoteDevicePort}`;
        deviceStatusBarItem.backgroundColor = undefined;
    } else {
        deviceStatusBarItem.text = '$(plug) No Device';
        deviceStatusBarItem.tooltip = 'No device connected — click Refresh Device Files';
        deviceStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    }
}

// ─── Extension Activation ────────────────────────────────────────────────────

function activate(context) {
    console.log('MicroPython Studio extension activated');
    checkPythonAvailability();

    // ── Create Status Bar ────────────────────────────────────────────────

    createStatusBar(context);

    // ── Register Commands ────────────────────────────────────────────────

    // Setup Environment (with progress indicator)
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.setupEnvironment', async () => {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'MicroPython Studio',
                    cancellable: false
                },
                async (progress) => {
                    progress.report({ message: 'Setting up virtual environment...' });
                    await setupVirtualEnv(context, getOutputChannel());
                    progress.report({ message: 'Done!' });
                }
            );
        })
    );

    // Create New Project
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.createNewProject', async () => {
            await createNewProject(context);
        })
    );

    // Open Existing Project Folder
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.openExistingProjectFolder', async () => {
            const folderUri = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                openLabel: 'Open MicroPython Project'
            });
            if (folderUri && folderUri.length > 0) {
                await vscode.commands.executeCommand('vscode.openFolder', folderUri[0], false);
            }
        })
    );

    // Refresh MCU Folder / Device Settings (with progress)
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.refreshMcuFolder', async (resource) => {
            await vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: 'MicroPython Studio',
                    cancellable: false
                },
                async (progress) => {
                    progress.report({ message: 'Detecting devices...' });
                    const comValues = await getValidDevicePort(resource);
                    gRemoteDevicePort = comValues[0];
                    gDeviceCodeDir = comValues[1];
                    updateDeviceStatusBar();

                    // Update the device file explorer with the new port
                    if (deviceFileExplorer) {
                        deviceFileExplorer.setPort(gRemoteDevicePort);
                    }

                    console.log('Device port:', gRemoteDevicePort, 'Code dir:', gDeviceCodeDir);
                }
            );
        })
    );

    // Open Shell (REPL on device)
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.openShell', async () => {
            if (!gRemoteDevicePort) {
                vscode.window.showWarningMessage('No device port set. Run "Refresh Device Files" first.');
                return;
            }

            const venvFolder = getVenvPythonPathFolder();
            const venvPython = getVenvPythonPath(venvFolder);

            const terminal = getMpremoteTerminal();
            terminal.sendText(`"${venvPython}" -m mpremote connect ${gRemoteDevicePort} resume repl`);
            terminal.show();
        })
    );

    // Run on Host (mpremote mount) or Run on MCU (mpremote run)
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.mountMainFolder', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No file open to run.');
                return;
            }

            const filePath = editor.document.fileName;
            const fileName = path.basename(filePath);

            const venvFolder = getVenvPythonPathFolder();
            const venvPython = getVenvPythonPath(venvFolder);
            const terminal = getMpremoteTerminal();

            // Both modes require a connected device
            if (!gRemoteDevicePort) {
                vscode.window.showWarningMessage(
                    'No device port set. Run "Refresh Device Files" first.'
                );
                return;
            }

            const scriptPath = path.join(context.extensionPath, 'src', 'mpremotesubpro.py');
            let cmd;
            if (currentTarget === 'Host') {
                // Run on Host — mount project folder to device via USB, then run from host FS
                // (mpremote connect <port> mount <folder> run <file>)
                if (gDeviceCodeDir && !isFileInProjectFolder(filePath, gDeviceCodeDir)) {
                    const choice = await vscode.window.showWarningMessage(
                        `File "${fileName}" is not in the main project folder.`,
                        'Run Anyway', 'Cancel'
                    );
                    if (choice !== 'Run Anyway') return;
                }
                cmd = [
                    `"${venvPython}"`,
                    `"${scriptPath}"`,
                    `--python "${venvPython}"`,
                    `run`,
                    `--port "${gRemoteDevicePort}"`,
                    `--folder "${gDeviceCodeDir}"`,
                    `--file "${filePath}"`
                ].join(' ');
            } else {
                // Run on MCU — send file directly to device and run it (mpremote run <file>)
                cmd = [
                    `"${venvPython}"`,
                    `"${scriptPath}"`,
                    `--python "${venvPython}"`,
                    `run_mcu`,
                    `--port "${gRemoteDevicePort}"`,
                    `--file "${filePath}"`
                ].join(' ');
            }

            terminal.show();
            terminal.sendText(cmd);
        })
    );

    // Run This Script on MCU Console (alias for mountMainFolder)
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.runThisScriptOnMcuConsole', async () => {
            await vscode.commands.executeCommand('micropython-ide.mountMainFolder');
        })
    );

    // Stop Running Script — send Ctrl+C to the active terminal session
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.stopRun', () => {
            const terminal = getMpremoteTerminal();
            terminal.sendText('\x03', false); // Ctrl+C — interrupts the running script
            terminal.show();
            vscode.window.showInformationMessage('Interrupt sent to device (Ctrl+C).');
        })
    );

    // Upload current file to device root
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.uploadFileToDevice', async () => {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
                vscode.window.showWarningMessage('No file open to upload.');
                return;
            }
            if (!gRemoteDevicePort) {
                vscode.window.showWarningMessage('No device port set. Run "Refresh Device Files" first.');
                return;
            }

            const filePath = editor.document.fileName;
            const venvFolder = getVenvPythonPathFolder();
            const venvPython = getVenvPythonPath(venvFolder);
            const scriptPath = path.join(context.extensionPath, 'src', 'mpremotesubpro.py');

            const cmd = [
                `"${venvPython}"`,
                `"${scriptPath}"`,
                `--python "${venvPython}"`,
                `upload`,
                `--port "${gRemoteDevicePort}"`,
                `--source "${filePath}"`,
                `--dest /`
            ].join(' ');

            const terminal = getMpremoteTerminal();
            terminal.show();
            terminal.sendText(cmd);

            // Refresh device file tree after a short delay
            setTimeout(() => { if (deviceFileExplorer) deviceFileExplorer.refresh(); }, 4000);
        })
    );

    // Upload entire project code folder to device
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.uploadProjectToDevice', async () => {
            if (!gRemoteDevicePort) {
                vscode.window.showWarningMessage('No device port set. Run "Refresh Device Files" first.');
                return;
            }
            if (!gDeviceCodeDir) {
                vscode.window.showWarningMessage('No project detected. Run "Refresh Device Files" first.');
                return;
            }

            const venvFolder = getVenvPythonPathFolder();
            const venvPython = getVenvPythonPath(venvFolder);
            const scriptPath = path.join(context.extensionPath, 'src', 'mpremotesubpro.py');

            const cmd = [
                `"${venvPython}"`,
                `"${scriptPath}"`,
                `--python "${venvPython}"`,
                `upload`,
                `--port "${gRemoteDevicePort}"`,
                `--source "${gDeviceCodeDir}"`,
                `--dest /`
            ].join(' ');

            const terminal = getMpremoteTerminal();
            terminal.show();
            terminal.sendText(cmd);

            // Refresh device file tree after upload finishes
            setTimeout(() => { if (deviceFileExplorer) deviceFileExplorer.refresh(); }, 8000);
        })
    );

    // Choose Run Target (Host / MCU)
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.chooseRunTarget', () => {
            const options = [
                { label: '$(device-desktop) Run on Host', target: 'Host' },
                { label: '$(circuit-board) Run on MCU', target: 'MCU' }
            ];

            const qp = vscode.window.createQuickPick();
            qp.items = options;
            qp.placeholder = `Current: Run on ${currentTarget}`;

            qp.onDidChangeSelection(selection => {
                if (!selection[0]) return;
                currentTarget = selection[0].target;
                updateRunTargetButton();
                console.log(`Run target changed to: ${currentTarget}`);
                qp.hide();
            });

            qp.onDidHide(() => qp.dispose());
            qp.show();
        })
    );

    // Start Debug (placeholder — coming soon)
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.startDebug', () => {
            vscode.window.showInformationMessage(
                'Debug support is coming soon! Stay tuned for future updates.'
            );
        })
    );

    // Update Device Port (placeholder — coming soon)
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.updateDevicePort', async () => {
            const port = await vscode.window.showInputBox({
                prompt: 'Enter the device port manually',
                placeHolder: 'e.g. COM3, /dev/ttyUSB0',
                value: gRemoteDevicePort || ''
            });
            if (port) {
                gRemoteDevicePort = port;
                updateDeviceStatusBar();
                vscode.window.showInformationMessage(`Device port set to: ${port}`);
            }
        })
    );

    // ── Device File Explorer ─────────────────────────────────────────────

    deviceFileExplorer = new DeviceFileExplorerProvider();
    const treeView = vscode.window.createTreeView('micropython-ide-device-files', {
        treeDataProvider: deviceFileExplorer,
        showCollapseAll: true
    });
    context.subscriptions.push(treeView);

    // Refresh device files tree
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.refreshDeviceFiles', () => {
            if (!gRemoteDevicePort) {
                vscode.window.showWarningMessage('No device connected. Run "Refresh Device Files" first.');
                return;
            }
            deviceFileExplorer.refresh();
        })
    );

    // Read a file from the device (triggered by clicking a file in tree)
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.readDeviceFile', async (deviceFilePath) => {
            await readDeviceFile(gRemoteDevicePort, deviceFilePath);
        })
    );

    // Delete a file from the device (right-click context menu)
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.deleteDeviceFile', async (item) => {
            if (item && item.devicePath) {
                await deleteDeviceFile(gRemoteDevicePort, item.devicePath, deviceFileExplorer);
            }
        })
    );

    // ── Listen for terminal close events ─────────────────────────────────

    context.subscriptions.push(
        vscode.window.onDidCloseTerminal(terminal => {
            if (terminal === gMpremoteTerminal) {
                gMpremoteTerminal = null;
            }
        })
    );
}

// ─── Status Bar Creation ─────────────────────────────────────────────────────

/** Reference to the Run Target button for updates */
let runTargetButton = null;

function updateRunTargetButton() {
    if (runTargetButton) {
        const icon = currentTarget === 'Host' ? '$(device-desktop)' : '$(circuit-board)';
        runTargetButton.text = `${icon} ${currentTarget}`;
        runTargetButton.tooltip = `Run target: ${currentTarget}. Click to switch.`;
    }
}

function createStatusBar(context) {
    // Priority determines ordering: higher = more to the left

    // 1. Device connection indicator
    deviceStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 105);
    deviceStatusBarItem.command = 'micropython-ide.refreshMcuFolder';
    updateDeviceStatusBar();
    deviceStatusBarItem.show();
    context.subscriptions.push(deviceStatusBarItem);

    // 2. Open Shell button
    const shellButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 104);
    shellButton.text = '$(terminal) Shell';
    shellButton.tooltip = 'Open MicroPython shell (REPL)';
    shellButton.command = 'micropython-ide.openShell';
    shellButton.show();
    context.subscriptions.push(shellButton);

    // 3. Run Target selector
    runTargetButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 103);
    runTargetButton.command = 'micropython-ide.chooseRunTarget';
    updateRunTargetButton();
    runTargetButton.show();
    context.subscriptions.push(runTargetButton);

    // 4. Run button (green accent)
    const runButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 102);
    runButton.text = '$(play) Run';
    runButton.tooltip = 'Run current script';
    runButton.command = 'micropython-ide.mountMainFolder';
    runButton.backgroundColor = new vscode.ThemeColor('statusBarItem.prominentBackground');
    runButton.show();
    context.subscriptions.push(runButton);

    // 5. Stop button (warning accent)
    const stopButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 101);
    stopButton.text = '$(debug-stop) Stop';
    stopButton.tooltip = 'Stop running script (soft reset)';
    stopButton.command = 'micropython-ide.stopRun';
    stopButton.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
    stopButton.show();
    context.subscriptions.push(stopButton);
}

// ─── Extension Deactivation ──────────────────────────────────────────────────

function deactivate() {
    console.log('MicroPython Studio extension deactivated');

    // Clean up the terminal
    if (gMpremoteTerminal) {
        gMpremoteTerminal.dispose();
        gMpremoteTerminal = null;
    }

    // Dispose output channel
    outputChannel.dispose();
}

module.exports = { activate, deactivate };