/**
 * extension.js
 * Main entry point for MicroPython Studio VS Code extension
 * @license MIT
 * @version 2.0
 * @author  Niwantha Meepage
 */

const vscode = require('vscode');
const { exec, spawn } = require('child_process');
const path = require('path');
const { setupVirtualEnv } = require('./setupEnv');
const { createNewProject } = require('./createNewProject');
const { getValidDevicePort } = require('./refreshSettings');
const { getVenvPythonPathFolder, getVenvPythonPath, getVenvToolPath, getConfigValue } = require('./commonFxn');
const { DeviceFileExplorerProvider, readDeviceFile, deleteDeviceFile, deleteDeviceFolder } = require('./deviceFileExplorer');
const { openPackageManager } = require('./packageManager');
const { flashFirmware, downloadFirmware } = require('./flashFirmware');
const { updateCfgComponent } = require('./commonFxn');
const { openDeviceDashboard } = require('./deviceDashboard');
const { openWebReplTerminal } = require('./webReplTerminal');

// ─── Global State ────────────────────────────────────────────────────────────

const outputChannel = vscode.window.createOutputChannel('MicroPython IDE');

let gMpremoteTerminal = null;
let gRemoteDevicePort = null;
let gDeviceCodeDir = null;
let currentTarget = 'Host';

// ─── Status Bar Items (stored for cleanup) ───────────────────────────────────

let deviceStatusBarItem = null;
let deviceFileExplorer = null;

// ─── Port picker (COM vs WebREPL) ────────────────────────────────────────────

/**
 * Build the list of selectable port options from device.cfg.
 * Always includes the USB COM port (if we have one) plus Wi-Fi if webrepl_enabled=true.
 * Returns null when there is no choice to offer (WebREPL not configured).
 */
async function _buildRunPortOptions() {
    if (!gDeviceCodeDir) return null;

    const cfgPath = path.join(path.dirname(gDeviceCodeDir), 'device.cfg');
    const savedCom = await getConfigValue(cfgPath, 'device', 'port');
    const enabled  = await getConfigValue(cfgPath, 'remote', 'webrepl_enabled');
    const ip       = await getConfigValue(cfgPath, 'remote', 'webrepl_ip');
    const password = await getConfigValue(cfgPath, 'remote', 'webrepl_password');

    if (enabled !== 'true' || !ip) return null;

    const items = [];
    if (savedCom) {
        items.push({ label: `$(plug) USB — ${savedCom}`, port: savedCom });
    }
    items.push({ label: `$(remote) Wi-Fi — ${ip}`, port: `ws:${ip},${password || ''}` });
    return items;
}

// ─── Terminal Management ─────────────────────────────────────────────────────

/**
 * Get or create the MicroPython terminal.
 * Reuses existing terminal if it's still alive.
 */
/**
 * Run a Python subprocess (no shell) and show output in an OutputChannel.
 * Avoids Git Bash / MSYS2 shell quoting issues entirely.
 * @param {string} exe - Absolute path to python.exe
 * @param {string[]} args - Arguments (no quoting needed)
 * @param {((code:number|null)=>void)} [onComplete] - Called when process exits
 */
function runPythonProcess(exe, args, onComplete) {
    const channel = vscode.window.createOutputChannel('MicroPython Studio');
    channel.show(true);
    channel.appendLine('─'.repeat(50));

    const proc = spawn(exe, args);
    proc.stdout.on('data', d => channel.append(d.toString()));
    proc.stderr.on('data', d => channel.append(d.toString()));
    proc.on('close', code => {
        if (onComplete) onComplete(code);
    });
    proc.on('error', err => {
        channel.appendLine(`❌ Failed to start process: ${err.message}`);
    });
}

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
        const wsMatch = gRemoteDevicePort.match(/^ws:([^,]+)/);
        const portLabel = wsMatch ? `📡 ${wsMatch[1]}` : gRemoteDevicePort;
        deviceStatusBarItem.text = `$(plug) ${portLabel}`;
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
        vscode.commands.registerCommand('micropython-ide.mountMainFolder', async (uri) => {
            const filePath = uri ? uri.fsPath : vscode.window.activeTextEditor?.document.fileName;
            if (!filePath) {
                vscode.window.showWarningMessage('No file selected to run.');
                return;
            }

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

            const runPort = gRemoteDevicePort;
            if (!runPort) return;

            const scriptPath = path.join(context.extensionPath, 'src', 'mpremotesubpro.py');
            const isMpy = filePath.endsWith('.mpy');
            const isWireless = runPort.startsWith('ws:');
            let cmd;

            if (!isMpy && !isWireless && currentTarget === 'Host') {
                // Run on Host — mount project folder to device via USB, then run from host FS
                // .mpy files and wireless (ws:) connections cannot use mount+run; always run_mcu
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
                    `--port "${runPort}"`,
                    `--folder "${gDeviceCodeDir}"`,
                    `--file "${filePath}"`
                ].join(' ');
            } else {
                // Run on MCU — send file directly to device and run it (mpremote run <file>)
                // Always used for: .mpy bytecode, wireless (ws:) connections, MCU target mode
                cmd = [
                    `"${venvPython}"`,
                    `"${scriptPath}"`,
                    `--python "${venvPython}"`,
                    `run_mcu`,
                    `--port "${runPort}"`,
                    `--file "${filePath}"`
                ].join(' ');
            }

            terminal.show();
            terminal.sendText(cmd);
        })
    );

    // Run This Script on MCU Console (alias for mountMainFolder)
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.runThisScriptOnMcuConsole', async (uri) => {
            await vscode.commands.executeCommand('micropython-ide.mountMainFolder', uri);
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
        vscode.commands.registerCommand('micropython-ide.uploadFileToDevice', async (uri) => {
            const filePath = uri ? uri.fsPath : vscode.window.activeTextEditor?.document.fileName;
            if (!filePath) {
                vscode.window.showWarningMessage('No file selected to upload.');
                return;
            }
            if (!gRemoteDevicePort) {
                vscode.window.showWarningMessage('No device port set. Run "Refresh Device Files" first.');
                return;
            }
            const venvFolder = getVenvPythonPathFolder();
            const venvPython = getVenvPythonPath(venvFolder);
            const scriptPath = path.join(context.extensionPath, 'src', 'mpremotesubpro.py');

            runPythonProcess(venvPython, [
                scriptPath, '--python', venvPython,
                'upload', '--port', gRemoteDevicePort,
                '--source', filePath, '--dest', ''
            ], () => { if (deviceFileExplorer) deviceFileExplorer.refresh(); });
        })
    );

    // Upload a folder (with all subfolders/files) to the device — right-click in explorer
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.uploadFolderToDevice', async (uri) => {
            const folderPath = uri ? uri.fsPath : null;
            if (!folderPath) {
                vscode.window.showWarningMessage('No folder selected.');
                return;
            }
            if (!gRemoteDevicePort) {
                vscode.window.showWarningMessage('No device port set. Run "Refresh Device Files" first.');
                return;
            }

            // Use folder name as dest — no leading slash to avoid MSYS2/Git Bash
            // path conversion (which turns /foo into C:/Program Files/Git/foo).
            // _normalize_dest() in mpremotesubpro.py adds the leading slash.
            const dest = path.basename(folderPath);

            const venvFolder = getVenvPythonPathFolder();
            const venvPython = getVenvPythonPath(venvFolder);
            const scriptPath = path.join(context.extensionPath, 'src', 'mpremotesubpro.py');

            runPythonProcess(venvPython, [
                scriptPath, '--python', venvPython,
                'upload', '--port', gRemoteDevicePort,
                '--source', folderPath, '--dest', dest
            ], () => { if (deviceFileExplorer) deviceFileExplorer.refresh(); });
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

            runPythonProcess(venvPython, [
                scriptPath, '--python', venvPython,
                'upload', '--port', gRemoteDevicePort,
                '--source', gDeviceCodeDir, '--dest', ''
            ], () => { if (deviceFileExplorer) deviceFileExplorer.refresh(); });
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
                currentTarget = /** @type {any} */ (selection[0]).target;
                updateRunTargetButton();
                console.log(`Run target changed to: ${currentTarget}`);
                qp.hide();
            });

            qp.onDidHide(() => qp.dispose());
            qp.show();
        })
    );

    // Choose Run Transport (USB / Wi-Fi)
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.chooseRunPort', async () => {
            if (!gRemoteDevicePort) {
                vscode.window.showWarningMessage('No device connected. Refresh first.');
                return;
            }
            const items = await _buildRunPortOptions();
            if (!items) {
                vscode.window.showInformationMessage(
                    'WebREPL is not enabled. Only USB is available.'
                );
                return;
            }
            const pick = await vscode.window.showQuickPick(items, {
                placeHolder: 'Choose run transport'
            });
            if (!pick) return;
            gRemoteDevicePort = /** @type {any} */ (pick).port;
            updateDeviceStatusBar();
            if (deviceFileExplorer) deviceFileExplorer.setPort(gRemoteDevicePort);
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

    // Compile .py to .mpy bytecode using mpy_cross
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.compileToBytecode', async (uri) => {
            // Accept file from right-click (uri) or from the active editor
            const filePath = uri ? uri.fsPath : vscode.window.activeTextEditor?.document.fileName;
            if (!filePath) {
                vscode.window.showWarningMessage('No Python file selected.');
                return;
            }
            if (!filePath.endsWith('.py')) {
                vscode.window.showWarningMessage('Only .py files can be compiled to bytecode.');
                return;
            }

            const venvFolder = getVenvPythonPathFolder();
            const venvPython = getVenvPythonPath(venvFolder);
            const outputFile = filePath.replace(/\.py$/, '.mpy');

            outputChannel.show(true);
            outputChannel.appendLine(`Compiling: ${path.basename(filePath)} → ${path.basename(outputFile)}`);

            exec(`"${venvPython}" -m mpy_cross "${filePath}"`, (error, stdout, stderr) => {
                if (error) {
                    outputChannel.appendLine(`[ERROR] ${stderr || error.message}`);
                    vscode.window.showErrorMessage(`Compile failed: ${stderr || error.message}`);
                } else {
                    if (stdout) outputChannel.appendLine(stdout);
                    outputChannel.appendLine(`Done: ${outputFile}`);
                    vscode.window.showInformationMessage(`Compiled → ${path.basename(outputFile)}`);
                }
            });
        })
    );

    // Install package from micropython-lib via mip
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.installPackage', async () => {
            const terminal = getMpremoteTerminal();
            await openPackageManager(context, gRemoteDevicePort, terminal);
            
            // Auto refresh the tree view after 5 seconds to show the newly installed /lib folder
            setTimeout(() => { if (deviceFileExplorer) deviceFileExplorer.refresh(); }, 5000);
        })
    );

    // Flash firmware to device via mpflash
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.flashFirmware', async () => {
            const terminal = getMpremoteTerminal();
            const result = await flashFirmware(outputChannel, terminal);
            if (result && gDeviceCodeDir) {
                // Record the flashed version in device.cfg
                const cfgPath = path.join(path.dirname(gDeviceCodeDir), 'device.cfg');
                await updateCfgComponent(cfgPath, 'device', 'last_flashed_version', result.version);
                await updateCfgComponent(cfgPath, 'device', 'last_flashed_board', result.board);
                // Update status bar tooltip to show firmware version
                if (deviceStatusBarItem) {
                    deviceStatusBarItem.tooltip = `Connected to ${result.port} — firmware ${result.version}`;
                }
            }
        })
    );

    // Download firmware only (no flash)
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.downloadFirmware', async () => {
            const terminal = getMpremoteTerminal();
            await downloadFirmware(outputChannel, terminal);
        })
    );

    // Open Device Dashboard Webview Panel
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.openDeviceDashboard', async () => {
            await openDeviceDashboard(context, outputChannel, gRemoteDevicePort, (newPort) => {
                gRemoteDevicePort = newPort;
                updateDeviceStatusBar();
                if (deviceFileExplorer) deviceFileExplorer.setPort(newPort);
            });
        })
    );

    // Open WebREPL Terminal (browser-based terminal for ws: connections)
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.openWebReplTerminal', async () => {
            await openWebReplTerminal(context, gRemoteDevicePort);
        })
    );

    // Generate flowchart from .py file using code2flow
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.generateFlowchart', async (uri) => {
            const filePath = uri ? uri.fsPath : vscode.window.activeTextEditor?.document.fileName;
            if (!filePath) {
                vscode.window.showWarningMessage('No Python file selected.');
                return;
            }
            if (!filePath.endsWith('.py')) {
                vscode.window.showWarningMessage('Only .py files can be used to generate a flowchart.');
                return;
            }

            const venvFolder = getVenvPythonPathFolder();
            const code2flowExe = getVenvToolPath(venvFolder, 'code2flow');
            const outputFile = filePath.replace(/\.py$/, '.png');

            outputChannel.show(true);
            outputChannel.appendLine(`Generating flowchart: ${path.basename(filePath)} → ${path.basename(outputFile)}`);

            exec(`"${code2flowExe}" "${filePath}" --output "${outputFile}"`, (error, stdout, stderr) => {
                if (error) {
                    outputChannel.appendLine(`[ERROR] ${stderr || error.message}`);
                    vscode.window.showErrorMessage(`Flowchart generation failed: ${stderr || error.message}`);
                } else {
                    if (stdout) outputChannel.appendLine(stdout);
                    outputChannel.appendLine(`Done: ${outputFile}`);
                    vscode.window.showInformationMessage(
                        `Flowchart saved → ${path.basename(outputFile)}`,
                        'Open'
                    ).then(choice => {
                        if (choice === 'Open') {
                            vscode.commands.executeCommand('vscode.open', vscode.Uri.file(outputFile));
                        }
                    });
                }
            });
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

    // Delete a folder (and all contents) from the device
    context.subscriptions.push(
        vscode.commands.registerCommand('micropython-ide.deleteDeviceFolder', async (item) => {
            if (item && item.devicePath) {
                await deleteDeviceFolder(gRemoteDevicePort, item.devicePath, deviceFileExplorer);
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

    // 0. Extension version label
    const version = context.extension.packageJSON.version;
    const versionItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 106);
    versionItem.text = `$(circuit-board) MPS v${version}`;
    versionItem.tooltip = `MicroPython Studio v${version} — Click to create new project`;
    versionItem.command = 'micropython-ide.createNewProject';
    versionItem.show();
    context.subscriptions.push(versionItem);

    // 1. Device connection indicator
    deviceStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 105);
    deviceStatusBarItem.command = 'micropython-ide.chooseRunPort';
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

    // 6. Flash firmware button
    const flashButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    flashButton.text = '$(flame) Flash';
    flashButton.tooltip = 'Flash MicroPython firmware to device';
    flashButton.command = 'micropython-ide.flashFirmware';
    flashButton.show();
    context.subscriptions.push(flashButton);

    // 7. Device Dashboard Button
    const dashboardButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    dashboardButton.text = '$(dashboard) Dashboard';
    dashboardButton.tooltip = 'Open the MicroPython Device Dashboard UI';
    dashboardButton.command = 'micropython-ide.openDeviceDashboard';
    dashboardButton.show();
    context.subscriptions.push(dashboardButton);

    // 8. WebREPL Terminal Button
    const webReplButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 98);
    webReplButton.text = '$(remote) WebREPL';
    webReplButton.tooltip = 'Open WebREPL Terminal (Wi-Fi)';
    webReplButton.command = 'micropython-ide.openWebReplTerminal';
    webReplButton.show();
    context.subscriptions.push(webReplButton);

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