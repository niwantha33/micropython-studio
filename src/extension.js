// vsce package
// code --install-extension my-extension-0.0.1.vsix
const vscode = require('vscode');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const WebSocket = require('ws');
const os = require('os');

// user app js files 


// Global variables
let wsClient = null;
let serverProcess = null;
let outputChannel = vscode.window.createOutputChannel("MicroPython IDE");
outputChannel.show(true); // Opens the channel so the user sees output

let mpremoteTerminal = null;

const mcuOptions = [
    "AE722F80F55D5XX",
    "RA6M5",
    "cc3200",
    "esp32",
    "esp32c3",
    "esp32c6",
    "esp32s2",
    "esp32s3",
    "esp8266",
    "mimxrt",
    "nrf51",
    "nrf52",
    "nrf91",
    "ra4m1",
    "ra4w1",
    "ra6m1",
    "ra6m2",
    "ra6m5",
    "rp2040",
    "rp2350",
    "samd21",
    "samd51",
    "stm32f0",
    "stm32f4",
    "stm32f411",
    "stm32f7",
    "stm32g0",
    "stm32g4",
    "stm32h5",
    "stm32h7",
    "stm32l0",
    "stm32l1",
    "stm32l4",
    "stm32wb",
    "stm32wl"
];

let isSyncFunctionActive = false;
let global_mcu_port = null;
let global_syncFolderPath = null;

function getMpremoteTerminal() {
    if (!mpremoteTerminal || mpremoteTerminal.exitStatus) {
        mpremoteTerminal = vscode.window.createTerminal({
            name: "micropython-studio",
            hideFromUser: true
        });
    }
    return mpremoteTerminal;
}

function showButtonsInTaskbar(context) {
    // Create Activity Bar icon
    const activeBaronMcuButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    activeBaronMcuButton.text = `$(folder) Open Project`;
    activeBaronMcuButton.tooltip = `Run current script on MicroPython device`;
    activeBaronMcuButton.command = 'micropython-ide.launchIde';
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
    autoSyncMcuButton.command = 'micropython-ide.syncMcuFolder';
    context.subscriptions.push(autoSyncMcuButton);
    autoSyncMcuButton.show();
    // Create a green "Run on MCU" button in status bar
    const runOnMcuButton = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    runOnMcuButton.text = `$(play) Run on MCU`;
    // runOnMcuButton.backgroundColor='blue'
    // runOnMcuButton.color = 'green'
    runOnMcuButton.tooltip = `Run current script on MicroPython device`;
    runOnMcuButton.command = 'micropython-ide.runOnMcu';
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



}

// Helper function to copy folders recursively
function copyFolderRecursive(src, dest) {
    if (!fsSync.existsSync(dest)) {
        fsSync.mkdirSync(dest, { recursive: true });
    }

    const entries = fsSync.readdirSync(src, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            copyFolderRecursive(srcPath, destPath);
        } else {
            fsSync.copyFileSync(srcPath, destPath);
        }
    }
}


// Main activation function
function activate(context) {
    checkPythonAvailability();
    showButtonsInTaskbar(context);
    //---------------------------------------------------------------------------------------------------------------------------.
    //                                                                                                                           '
    //-------------------------------------*-*Command Activation- Section*-*-----------------------------------------------------'    
    //                                                                                                                           '
    //---------------------------------------------------------------------------------------------------------------------------'

    let openShellCommand = vscode.commands.registerCommand('micropython-ide.openShell', async () => {

        const venvFolder = getVenvPythonPathFolder();
        const venvPython = getVenvPythonPath(venvFolder);
        // const terminal = vscode.window.createTerminal("MicroPython Mount and Sync");
        const terminal = getMpremoteTerminal();
        terminal.show();
        // 2. List files on device
        terminal.sendText(`"${venvPython}" -m mpremote connect ${global_mcu_port} resume repl`);
    });
    context.subscriptions.push(openShellCommand);

    let copyToMcuDeviceCommand = vscode.commands.registerCommand('micropython-ide.copyToMcuDevice', async (folderUri) => {
    });

    context.subscriptions.push(copyToMcuDeviceCommand);

    let copyToLogicFolderCommand = vscode.commands.registerCommand('micropython-ide.copToLogicFolder', async (folderUri) => {
        vscode.window.showInformationMessage('Copying to device...');

        const sourcePath = folderUri.fsPath;
        const stat = fsSync.statSync(sourcePath);

        // 🧭 Locate mcu_ folder two levels up
        const baseDir = path.resolve(sourcePath, '..', '..');
        const entries = fsSync.readdirSync(baseDir, { withFileTypes: true });

        const mcuFolder = entries.find(entry => entry.isDirectory() && entry.name.startsWith('mcu_'));
        if (!mcuFolder) {
            vscode.window.showErrorMessage('No mcu_ folder found.');
            return;
        }

        const targetDir = path.join(baseDir, mcuFolder.name);
        const targetPath = path.join(targetDir, path.basename(sourcePath));

        if (stat.isDirectory()) {
            // Folder case — create and copy recursively
            if (fsSync.existsSync(targetPath)) {
                const overwrite = await vscode.window.showWarningMessage(
                    `Folder "${path.basename(sourcePath)}" already exists in ${mcuFolder.name}. Overwrite?`,
                    { modal: true },
                    'Yes', 'No'
                );
                if (overwrite !== 'Yes') {
                    vscode.window.showInformationMessage('Copy cancelled.');
                    return;
                }
                fsSync.rmSync(targetPath, { recursive: true, force: true });
            }

            copyFolderRecursive(sourcePath, targetPath);
            vscode.window.showInformationMessage(`Folder copied to Logic Device (${mcuFolder.name})`);
        } else {
            // File case
            if (fsSync.existsSync(targetPath)) {
                const overwrite = await vscode.window.showWarningMessage(
                    `File "${path.basename(sourcePath)}" already exists in ${mcuFolder.name}. Overwrite?`,
                    { modal: true },
                    'Yes', 'No'
                );
                if (overwrite !== 'Yes') {
                    vscode.window.showInformationMessage('Copy cancelled.');
                    return;
                }
            }

            fsSync.copyFileSync(sourcePath, targetPath);
            vscode.window.showInformationMessage(`File copied to Logic Device (${mcuFolder.name})`);
        }
    });
    context.subscriptions.push(copyToLogicFolderCommand);

    let copyToProjectFolderCommand = vscode.commands.registerCommand('micropython-ide.copyToMainProject', async (folderUri) => {
        vscode.window.showInformationMessage('Copying to project folder...');

        const sourcePath = folderUri.fsPath;
        const stat = fsSync.statSync(sourcePath);

        // 🧭 Locate the active project folder (first workspace folder)
        const projectFolder = vscode.workspace.workspaceFolders?.[0];
        if (!projectFolder) {
            vscode.window.showErrorMessage('No active project folder found.');
            return;
        }

        const targetDir = projectFolder.uri.fsPath;
        const targetPath = path.join(targetDir, path.basename(sourcePath));

        if (stat.isDirectory()) {
            // Folder case
            if (fsSync.existsSync(targetPath)) {
                const overwrite = await vscode.window.showWarningMessage(
                    `Folder "${path.basename(sourcePath)}" already exists in project. Overwrite?`,
                    { modal: true },
                    'Yes', 'No'
                );
                if (overwrite !== 'Yes') {
                    vscode.window.showInformationMessage('Copy cancelled.');
                    return;
                }
                fsSync.rmSync(targetPath, { recursive: true, force: true });
            }

            copyFolderRecursive(sourcePath, targetPath);
            vscode.window.showInformationMessage(`Folder copied to project: ${targetPath}`);
        } else {
            // File case
            if (fsSync.existsSync(targetPath)) {
                const overwrite = await vscode.window.showWarningMessage(
                    `File "${path.basename(sourcePath)}" already exists in project. Overwrite?`,
                    { modal: true },
                    'Yes', 'No'
                );
                if (overwrite !== 'Yes') {
                    vscode.window.showInformationMessage('Copy cancelled.');
                    return;
                }
            }

            fsSync.copyFileSync(sourcePath, targetPath);
            vscode.window.showInformationMessage(`File copied to project: ${targetPath}`);
        }

    });
    context.subscriptions.push(copyToProjectFolderCommand);

    let launchIdeCommand = vscode.commands.registerCommand('micropython-ide.launchIde', async () => {
        // Replace with your actual IDE launch logic
        const projectPath = await vscode.window.showOpenDialog({
            canSelectFolders: true,
            canSelectFiles: false,
            openLabel: 'Select MicroPython Project'
        });

        if (!projectPath || projectPath.length === 0) {
            return;
        }

        const selectedProject = projectPath[0].fsPath;

        // Example: Open the project in a new VS Code window
        const workspaceFile = path.join(selectedProject, `${path.basename(selectedProject)}.code-workspace`);

        try {
            await fs.access(workspaceFile);
            await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(workspaceFile), { forceNewWindow: true });
        } catch {

            await vscode.commands.executeCommand('micropython-ide.runUtil');
        }
    });
    context.subscriptions.push(launchIdeCommand);
    const utilMcuCommand = vscode.commands.registerCommand('micropython-ide.runUtil', async () => {
    });
    context.subscriptions.push(utilMcuCommand);
    const stopCommand = vscode.commands.registerCommand('micropython-ide.stopRun', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active file to run.');
            return;
        }

        const filePath = editor.document.fileName;

        const fileDir = path.dirname(filePath);
        const venvFolder = getVenvPythonPathFolder();
        const venvPython = getVenvPythonPath(venvFolder);
        // const terminal = vscode.window.createTerminal("MicroPython Runner");
        const terminal = getMpremoteTerminal();
        // terminal.show();
        terminal.sendText(`cd "${fixGitBashPath(fileDir)}"`);


        terminal.sendText(`"${venvPython}" -m mpremote resume reset`);
    });
    context.subscriptions.push(stopCommand);
    const syncMcuFolderCommand = vscode.commands.registerCommand('micropython-ide.syncMcuFolder', async () => {

        // Get current workspace or active file path
        let workingProjectPath;
        let syncMcuFolder;

        syncMcuFolder = await getSyncFolderPath(context);
        console.log("Sync MCU Folder:", syncMcuFolder);

        console.log("Root path:", syncMcuFolder)

        if (!syncMcuFolder) {
            vscode.window.showErrorMessage('Could not find sync folder');
            vscode.window.showInformationMessage('Please open a project working file (xxx.py) first, then try again.');
            return;
        }

        // Option 1: Get from active workspace
        if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
            workingProjectPath = vscode.workspace.workspaceFolders[0].uri.fsPath;
            console.log(vscode.workspace.workspaceFolders)
        }
        // Option 3: Show error if neither is available
        else {
            vscode.window.showErrorMessage('No workspace or active file found. Open a project first.');
            return;
        }

        console.log("Using parent path:", workingProjectPath);

        try {
            // Find device.cfg
            const deviceIniPath = path.join(workingProjectPath, 'device.cfg');

            console.log("device Init Path:", deviceIniPath);

            if (!deviceIniPath) {
                vscode.window.showErrorMessage('device.cfg not found. Make sure your project is configured.');
                return;
            }

            // Parse device.cfg
            const { port, syncFolder } = await parseDeviceConfig(deviceIniPath);

            console.log("Port configuration:", port, syncFolder, deviceIniPath);

            if (!port) {
                vscode.window.showErrorMessage('Device port not found in device.cfg');
                return;
            }
            if (!syncFolder) {
                vscode.window.showErrorMessage('sync_folder not found in device.cfg');
                return;
            }

            console.log("Sync folder:", syncMcuFolder);
            if (!isSyncFunctionActive) {

                setupAutoSync(context, syncMcuFolder, port);
                isSyncFunctionActive = true;

            } else {
                // If sync folder is already set, just show info
                vscode.window.showInformationMessage(`Sync folder already set: ${syncMcuFolder}`);
            }

            // Verify sync folder exists
            if (!syncMcuFolder) {
                vscode.window.showErrorMessage(`Sync folder not found: ${syncMcuFolder}`);
                return;
            } else {
                console.log("Sync folder exists:", syncMcuFolder);
                vscode.window.showInformationMessage(`Sync folder found: ${syncMcuFolder} Active auto-sync enabled!`);
            }

        } catch (error) {
            vscode.window.showErrorMessage(`Sync failed: ${error.message}`);
            console.error("Sync error:", error);
        }

    });
    context.subscriptions.push(syncMcuFolderCommand);
    let runOnMcuCommand = vscode.commands.registerCommand('micropython-ide.runOnMcu', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active file to run.');
            return;
        }

        const filePath = editor.document.fileName;
        const fileName = path.basename(filePath);
        const fileDir = path.dirname(filePath);
        const projectPath = context.extensionPath;

        // Step 1: Read COM port from device_com.ini
        const deviceIniPath = path.join(projectPath, 'device.cfg');
        let selectedDevice = null;

        try {
            const data = await fs.readFile(deviceIniPath, 'utf8');
            const portMatch = data.match(/port\s*=\s*(.+)/);
            selectedDevice = portMatch ? portMatch[1].trim() : null;
        } catch {
            selectedDevice = context.globalState.get('selectedMicroPythonDevice') || null;
        }

        if (!selectedDevice) {
            const action = await vscode.window.showErrorMessage(
                'No device port found. Detect and select one first.',
                'Detect Device'
            );
            if (action === 'Detect Device') {
                await vscode.commands.executeCommand('micropython-ide.detectAndSaveDevice');
            }
            return;
        }

        const venvFolder = getVenvPythonPathFolder();
        const venvPython = getVenvPythonPath(venvFolder);
        // const terminal = vscode.window.createTerminal("MicroPython Runner");
        const terminal = getMpremoteTerminal();
        // terminal.show();
        terminal.sendText(`cd "${fixGitBashPath(fileDir)}"`);

        // Step 2: Determine if file is on device or local
        const isMcuFolder = path.basename(fileDir).startsWith('mcu_');

        terminal.sendText(`"${venvPython}" -m mpremote connect ${selectedDevice} resume soft-reset`);
        terminal.sendText("clear", true); // Clear terminal output

        if (isMcuFolder) {
            // File is in mcu_* folder (mounted), run using import
            terminal.sendText(`"${venvPython}" -m mpremote connect ${selectedDevice} resume exec "import ${fileName.replace('.py', '')}" + repl`);
        } else {
            // File is local, send it to device using 'run'
            terminal.sendText(`"${venvPython}" -m mpremote connect ${selectedDevice} resume run "${filePath}" + repl`);
        }
        terminal.show();

        vscode.window.showInformationMessage(`Running ${fileName} on ${selectedDevice}`);
    });
    context.subscriptions.push(runOnMcuCommand);
    let setupEnvCommand = vscode.commands.registerCommand('micropython-ide.setupEnvironment', async () => {
        await setupVirtualEnv(context);
    });
    context.subscriptions.push(setupEnvCommand);
    let runCodeCommand = vscode.commands.registerCommand('micropython-ide.runCode', async () => {
        // await handleRunCode(context);
        vscode.window.showInformationMessage('RunCode command triggered');
        // 1. Start server only when needed
        if (!await isServerRunning()) {
            const started = await startServer(context);
            if (!started) {
                vscode.window.showErrorMessage('Failed to start server');
                return;
            }
        }
        // 2. Execute user code
        const code = await getActiveEditorCode();
        vscode.window.showInformationMessage(code)
        console.log(code);
        if (code) {
            executeCode(code);
        }

    });
    context.subscriptions.push(runCodeCommand);
    let installDepsCommand = vscode.commands.registerCommand('micropython-ide.installDependencies', async () => {

        vscode.window.showWarningMessage("Use ... MicroPython: Setup Development Environment to install dependencies.");
    });
    context.subscriptions.push(installDepsCommand);
    let detectDeviceCommand = vscode.commands.registerCommand('micropython-ide.detectDevice', async () => {
        try {
            const projectName = await vscode.window.showInputBox({
                prompt: 'Enter project name',
                placeHolder: 'e.g. my-micropython-project',
                validateInput: value => value ? null : 'Project name is required'
            });
            if (!projectName) return;


            const selectedMcu = await vscode.window.showQuickPick(mcuOptions, {
                placeHolder: 'Select target microcontroller'
            });
            if (!selectedMcu) return;

            const folderUri = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                openLabel: 'Select Project Folder Location'
            });
            if (!folderUri?.length) return;

            const parentPath = folderUri[0].fsPath;
            const projectDir = path.join(parentPath, projectName);
            const syncFolder = `mcu_${selectedMcu}`;
            const mcuDir = path.join(parentPath, syncFolder);
            const helperDir = path.join(parentPath, '.helper');
            const settingsDir = path.join(projectDir, '.vscode');

            const projectExists = await fs.access(projectDir).then(() => true).catch(() => false);

            if (!projectExists) {
                await fs.mkdir(projectDir, { recursive: true });
                await fs.mkdir(mcuDir, { recursive: true });
                await fs.mkdir(helperDir, { recursive: true });
                await fs.mkdir(settingsDir, { recursive: true });

                await fs.writeFile(path.join(projectDir, 'main.py'), `# MicroPython Project\nprint("New project created for ${selectedMcu}")`);
                await fs.writeFile(path.join(projectDir, 'pylintrc'), `[MESSAGES CONTROL]\ndisable=E0401, W0511, W0718, I1101, C0301, E1101, C0116\n[DESIGN]\nmax-args=10\nmax-locals=15\nmax-returns=5\nmax-statements=50\nmax-line-length=120\n[FORMAT]\nindent-string='    '\n[REPORTS]\noutput-format=text\nreports=no\n`);
                // await fs.writeFile(path.join(mcuDir, '_device_root.txt'),
                //     `This folder represents the root filesystem of your MicroPython device (${selectedMcu}).\n[Read-only view - files here are stored on your MCU]`,
                //     'utf8');

            }

            const venvFolder = getVenvPythonPathFolder();
            const venvPython = getVenvPythonPath(venvFolder);

            const { exec } = require('child_process');
            const command = `${venvPython} -m mpremote connect list`;

            exec(command, async (error, stdout, stderr) => {
                if (error) {
                    vscode.window.showErrorMessage(`Error detecting devices: ${stderr}`);
                    return;
                }
                let copyVidpid;
                const lines = stdout.trim().split('\n').filter(Boolean);
                const devices = lines.map(line => {
                    const [port, , vidpid] = line.trim().split(/\s+/);
                    let mcuType = 'Unknown';
                    if (vidpid === '2e8a:0005') mcuType = 'RP2040';
                    else if (vidpid.includes('10c4') || vidpid.includes('0403')) mcuType = 'ESP32';
                    else if (vidpid.includes('0483')) mcuType = 'STM32';
                    copyVidpid = vidpid;
                    return { label: port, description: mcuType };
                });

                await fs.writeFile(path.join(mcuDir, '.mcu'), `${copyVidpid}:${selectedMcu}`);


                const selected = await vscode.window.showQuickPick(devices, {
                    placeHolder: 'Select a connected MicroPython device'
                });
                if (!selected) return;

                const selectedDevice = selected.label;
                const now = new Date().toISOString();
                const deviceCfgContent = `[device]\nport = ${selectedDevice}\nmcu = ${selectedMcu}\nsync_folder = ${syncFolder}\nroot_folder = ${projectName}\nproject_created = ${now}\nlast_sync = ${now}\ndevice_firmware = Micropython`;

                const deviceCfgPath = path.join(projectDir, 'device.cfg');
                await fs.writeFile(deviceCfgPath, deviceCfgContent, 'utf8');

                const workspaceFilePath = path.join(parentPath, `${projectName}.code-workspace`);
                const repoName = await getGitRepoName(parentPath) || projectName;
                const workspaceFolders = [
                    {
                        path: projectName,
                        name: `📁 ${repoName}`,
                        icon: "folder"
                    },
                    {
                        path: syncFolder,
                        name: `🖥️ LOGIC DEVICE (${selectedMcu.toUpperCase()})`,
                        icon: "server-environment"
                    }
                ];

                const workspaceSettings = {
                    "workbench.tree.indent": 24,
                    "workbench.list.highlightFocused": true,
                    "workbench.iconTheme": "vs-seti"
                };

                const workspaceContent = {
                    folders: workspaceFolders,
                    settings: workspaceSettings
                };


                // const workspaceContent = {
                //     folders: [
                //         { path: projectName, name: `📁 ${repoName}` },
                //         { path: '.helper', name: `──────────────────────` },
                //         { path: syncFolder, name: `🖥️ Logic Device (${selectedMcu.toUpperCase()})` }
                //     ],
                //     settings: {
                //         "micropython-ide": {
                //             selectedDevice,
                //             mcuType: selectedMcu
                //         }
                //     }
                // };

                await fs.writeFile(workspaceFilePath, JSON.stringify(workspaceContent, null, 2));
                // Define the settings content as a JavaScript object directly
                const setting_json_payload = {
                    "files.associations": {
                        "*.mpy": "python",
                        "*.my": "python"
                    },
                    "files.exclude": {
                        "**/.helper": false
                    },
                    "python.languageServer": "Pylance",
                    "python.analysis.typeCheckingMode": "basic",
                    "python.analysis.typeshedPaths": [
                        path.join(venvFolder, "Lib", "site-packages")
                    ],
                    "python.defaultInterpreterPath": path.join(venvFolder, "Scripts", "python.exe"),
                    "python.analysis.diagnosticSeverityOverrides": {
                        "reportMissingModuleSource": "none"
                    }
                };

                try {
                    // Pass the JavaScript object directly to JSON.stringify
                    await fs.writeFile(path.join(settingsDir, 'settings.json'), JSON.stringify(setting_json_payload, null, 2));
                    console.log('settings.json updated successfully!');
                } catch (error) {
                    console.error('Failed to write settings.json:', error);
                    if (error.code === 'EPERM') {
                        console.error('Permission denied. Try running your script as an administrator or check folder permissions.');
                    } else if (error.code === 'ENOENT') {
                        console.error('No such file or directory. Ensure the .vscode folder exists at the target path.');
                    }
                }

                context.globalState.update('selectedMicroPythonDevice', selectedDevice);

                await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(workspaceFilePath), { forceNewWindow: false });

                const action = await vscode.window.showInformationMessage('Reload window to refresh folder names and settings?', 'Reload');
                if (action === 'Reload') {
                    await vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            });

        } catch (err) {
            vscode.window.showErrorMessage(`Failed to create or update project: ${err.message}`);
        }
    });
    context.subscriptions.push(detectDeviceCommand);
    const mountMcuFolderCommand = vscode.commands.registerCommand('micropython-ide.mountMcuFolder', async (folderUri) => {
        const mcuFolderPath = folderUri.fsPath;
        const parentPath = path.dirname(mcuFolderPath);
        // 1. Find device.cfg
        const deviceIniPath = await findDeviceConfig(parentPath);
        if (!deviceIniPath) {
            vscode.window.showErrorMessage('device.cfg not found near selected mcu_ folder.');
            return;
        }
        // 2. Parse device.cfg
        const { port, syncFolder } = await parseDeviceConfig(deviceIniPath);
        if (!port || !syncFolder) {
            vscode.window.showErrorMessage('Missing port or sync_folder in device.cfg');
            return;
        }
        if (!port || !syncFolder) {
            vscode.window.showErrorMessage('Missing port or sync_folder in device.cfg');
            return;
        }

        const syncFolderPath = path.join(parentPath, syncFolder);
        const venvFolder = getVenvPythonPathFolder();
        const venvPython = getVenvPythonPath(venvFolder);
        // const terminal = vscode.window.createTerminal("MicroPython Mount and Sync");
        const terminal = getMpremoteTerminal();
        // terminal.show();
        // go to command line 
        terminal.sendText(`cd "${fixGitBashPath(parentPath)}"`);

        // 2. List files on device
        terminal.sendText(`"${venvPython}" -m mpremote connect ${port} resume fs ls`);

        // 3. Copy all files from device to sync folder (NOTE: manually copy files; no wildcards)
        terminal.sendText(`"${venvPython}" -m mpremote connect ${port} resume fs cp -r : "${fixGitBashPath(syncFolderPath)}"`);
    });
    context.subscriptions.push(mountMcuFolderCommand);
    const unmountMcuFolderCommand = vscode.commands.registerCommand('micropython-ide.unmountMcuFolder', async (folderUri) => {
        const mcuFolderPath = folderUri.fsPath;
        const parentPath = path.dirname(mcuFolderPath);
        // 1. Find device.cfg
        const deviceIniPath = await findDeviceConfig(parentPath);
        if (!deviceIniPath) {
            vscode.window.showErrorMessage('device.cfg not found near selected mcu_ folder.');
            return;
        }
        // 2. Parse device.cfg
        const { port, syncFolder } = await parseDeviceConfig(deviceIniPath);
        if (!port || !syncFolder) {
            vscode.window.showErrorMessage('Missing port or sync_folder in device.cfg');
            return;
        }
        if (!port || !syncFolder) {
            vscode.window.showErrorMessage('Missing port or sync_folder in device.cfg');
            return;
        }
        const venvFolder = getVenvPythonPathFolder();
        const venvPython = getVenvPythonPath(venvFolder);
        // const terminal = vscode.window.createTerminal("MicroPython Mount and Sync");
        const terminal = getMpremoteTerminal();
        // terminal.show();
        // go to command line 
        terminal.sendText(`cd "${fixGitBashPath(parentPath)}"`);
        // 2. List files on device
        terminal.sendText(`"${venvPython}" -m mpremote connect ${port} resume umount`);
    });
    context.subscriptions.push(unmountMcuFolderCommand);
    let uploadToMcuDisposable = vscode.commands.registerCommand('micropython-ide.uploadToMcu', (resource) => {
        // Your logic for uploading to MCU, using 'resource' for the clicked path
        if (resource && resource.fsPath) {
            vscode.window.showInformationMessage(`Uploading ${resource.fsPath} to MCU!`);
        } else {
            vscode.window.showWarningMessage('No resource selected for upload.');
        }
    });
    context.subscriptions.push(uploadToMcuDisposable);
    // TODO: update with latest code 
    let createProjectCommand = vscode.commands.registerCommand('micropython-ide.createProject', async () => {
        try {
            const projectName = await vscode.window.showInputBox({
                prompt: 'Enter project name',
                placeHolder: 'e.g. my-micropython-project',
                validateInput: value => value ? null : 'Project name is required'
            });

            if (!projectName) {
                vscode.window.showInformationMessage('Project creation cancelled.');
                return;
            }


            const selectedMcu = await vscode.window.showQuickPick(mcuOptions, {
                placeHolder: 'Select target microcontroller'
            });

            if (!selectedMcu) {
                vscode.window.showInformationMessage('Project creation cancelled.');
                return;
            }

            const folderUri = await vscode.window.showOpenDialog({
                canSelectFiles: false,
                canSelectFolders: true,
                canSelectMany: false,
                openLabel: 'Select Project Folder Location'
            });

            if (!folderUri || folderUri.length === 0) {
                vscode.window.showInformationMessage('No folder selected.');
                return;
            }

            const parentPath = folderUri[0].fsPath;

            const projectDir = path.join(parentPath, projectName);
            const mcuDir = path.join(parentPath, `mcu_${selectedMcu}`);
            const dividerFolderName = '.helper';
            const dividerFolderDir = path.join(parentPath, dividerFolderName);

            await fs.mkdir(projectDir, { recursive: true });
            await fs.mkdir(mcuDir, { recursive: true });
            await fs.mkdir(dividerFolderDir, { recursive: true });

            await fs.writeFile(
                path.join(mcuDir, '_device_root.txt'),
                `This folder represents the root filesystem of your MicroPython device (${selectedMcu}).\n[Read-only view - files here are stored on your MCU]`
            );
            await fs.writeFile(path.join(mcuDir, '.mcu'), selectedMcu, 'utf8');

            await fs.writeFile(path.join(projectDir, 'main.py'), `# MicroPython Project\nprint("New project created for ${selectedMcu}")`);
            await fs.writeFile(path.join(projectDir, '.pylintrc'), `[MASTER]
# Add custom paths to the Python path
init-hook='import sys; sys.path.append(".")'

[MESSAGES CONTROL]
# Disable specific errors/warnings
disable=E0401, W0511, W0718, I1101, C0301

[DESIGN]
max-attributes=10  # Set your preferred threshold`);
            const settingsDir = path.join(projectDir, '.vscode');
            await fs.mkdir(settingsDir, { recursive: true });
            await fs.writeFile(path.join(settingsDir, 'settings.json'), JSON.stringify({
                "files.associations": {
                    "mcu_rp2040": "darkorange",
                    "mcu_rp2050": "orangered",
                    "mcu_esp32": "green",
                    "mcu_stm32": "royalblue",
                    "**/.helper": "gray"
                },

                "python.languageServer": "Pylance",
                "python.analysis.typeCheckingMode": "basic",
                "python.analysis.diagnosticSeverityOverrides": {
                    "reportMissingModuleSource": "none"
                },
                "python.analysis.typeshedPaths": [
                    "${workspaceFolder}/.micropython-venv/Lib/site-packages"

                ],
                "files.exclude": {
                    "**/.helper": true
                },

            }, null, 2));

            const workspaceFileName = `${projectName}.code-workspace`;
            const workspacePath = path.join(parentPath, workspaceFileName);

            const repoName = await getGitRepoName(parentPath) || projectName;

            const workspaceContent = {
                "folders": [
                    { "path": projectName, "name": `📁 ${repoName}` },
                    { "path": dividerFolderName, "name": `──────────────────────` },
                    { "path": `mcu_${selectedMcu}`, "name": `🖥️ Device (${selectedMcu.toUpperCase()})` }
                ],
                "settings": {}
            };

            await fs.writeFile(workspacePath, JSON.stringify(workspaceContent, null, 2));
            await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(workspacePath), { forceNewWindow: false });

            const action = await vscode.window.showInformationMessage(
                'Reload window to refresh folder names and settings?',
                'Reload'
            );
            if (action === 'Reload') {
                await vscode.commands.executeCommand('workbench.action.reloadWindow');
            }
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create project: ${error.message}`);
        }
    });
    context.subscriptions.push(createProjectCommand);
    let refreshMcuFolderCommand = vscode.commands.registerCommand('micropython-ide.refreshMcuFolder', async (resource) => {
        vscode.window.showInformationMessage("Refresh MicroPython Tools...");
        console.log("Refreshing MCU folder...", resource);
        const mcuFolderPath = resource.fsPath
        const parentPath = path.dirname(mcuFolderPath);
        console.log("Parent path:", parentPath);

        const configPath = await findDeviceConfig(parentPath);

        if (!configPath) {
            vscode.window.showErrorMessage('device.cfg not found near selected mcu_ folder.');
            return;
        }
        const { port, syncFolder } = await parseDeviceConfig(configPath);
        if (!port || !syncFolder) {
            vscode.window.showErrorMessage('Missing port or sync_folder in device.cfg');
            return;
        }
        global_mcu_port = port;
        global_syncFolderPath = syncFolder;
        console.log("Port:", global_mcu_port, "Sync Folder:", global_syncFolderPath);
        const newTimestamp = new Date().toISOString();

        updateLastSync(configPath, newTimestamp);


        // const micropythonStudioDir = path.join(appDataDir, '.micropython-studio');
        // const terminal = vscode.window.createTerminal("MicroPython Sync");
        // terminal.show();
        // terminal.sendText(`cd "${fixGitBashPath(micropythonStudioDir)}"`);

    });
    context.subscriptions.push(refreshMcuFolderCommand);
    let codeflowMcuFolderCommand = vscode.commands.registerCommand('micropython-ide.codeflow', async (fUri) => {
        const fsPath = fUri.fsPath;
        const messageShow = `Generating Codeflow Graph for: ${fsPath}`;
        vscode.window.showInformationMessage(messageShow);
        const venvFolder = getVenvPythonPathFolder();
        const code2flowExe = path.join(venvFolder, 'Scripts', 'code2flow.exe');
        const command = `"${code2flowExe}" "${fUri.fsPath}"`;
        const terminal = getMpremoteTerminal();
        // terminal.show();
        terminal.sendText(command);
    });

    context.subscriptions.push(codeflowMcuFolderCommand);
}

// Helper function to find the MCU sync folder
async function getSyncFolderPath(context) {
    // 1. Try to find from workspace folders
    if (vscode.workspace.workspaceFolders) {
        for (const folder of vscode.workspace.workspaceFolders) {
            if (folder.name.startsWith('🖥️ Device')) {
                return folder.uri.fsPath;
            }
            if (folder.name.includes('mcu_')) {
                return folder.uri.fsPath;
            }
        }
    }

    // 2. Try active file path
    if (vscode.window.activeTextEditor) {
        const activeFilePath = vscode.window.activeTextEditor.document.fileName;
        if (activeFilePath.includes('mcu_')) {
            return path.dirname(activeFilePath);
        }
    }

    // 3. Fallback to global state
    return context.globalState.get('lastSyncFolderPath');
}
function syncFileToDevice(localPath, selectedPort) {
    const venvFolder = getVenvPythonPathFolder();
    const venvPython = getVenvPythonPath(venvFolder);
    const remoteFile = ':' + path.basename(localPath);
    console.log('file watch:', venvPython, remoteFile)
    const command = `${venvPython} -m mpremote connect ${selectedPort} fs cp "${localPath}" ${remoteFile}`;
    const { exec } = require('child_process');
    exec(command, (err) => {
        if (err) {
            vscode.window.showWarningMessage(`Failed to sync ${path.basename(localPath)} to device`);
        }
    });
}
// Helper functions for auto-sync
async function findDeviceConfig(parentPath) {
    const siblingDirs = await fs.readdir(parentPath, { withFileTypes: true });
    console.log("Sibling directories:", siblingDirs);
    for (const dir of siblingDirs) {
        if (dir.isDirectory()) {
            const possiblePath = path.join(parentPath, dir.name, 'device.cfg');
            try {
                await fs.access(possiblePath);
                console.log("Found device.cfg at:", possiblePath);
                return possiblePath;
            } catch { }
        }
    }
    return null;
}
async function parseDeviceConfig(configPath) {
    try {
        const data = await fs.readFile(configPath, 'utf8');
        return {
            port: (data.match(/port\s*=\s*(.+)/)?.[1] || '').trim(),
            syncFolder: (data.match(/sync_folder\s*=\s*(.+)/)?.[1] || '').trim()
        };
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to read device.cfg: ${err.message}`);
        return {};
    }
}
async function prepareSyncFolder(syncFolderPath) {
    await fs.rm(syncFolderPath, { recursive: true, force: true });
    await fs.mkdir(syncFolderPath, { recursive: true });
}
function setupAutoSync(context, syncFolderPath, port) {
    const venvFolder = getVenvPythonPathFolder();
    const venvPython = getVenvPythonPath(venvFolder);
    const outputChannel = vscode.window.createOutputChannel("Auto Sync");
    outputChannel.show();

    const terminal = getMpremoteTerminal();

    // Debounce to prevent rapid consecutive syncs
    const syncQueue = new Map();
    const debounceTime = 1500; // 1 second

    const syncFile = (filePath) => {
        if (syncQueue.has(filePath)) {
            clearTimeout(syncQueue.get(filePath));
        }

        syncQueue.set(filePath, setTimeout(() => {
            const relativePath = path.relative(syncFolderPath, filePath);
            const devicePath = `:${relativePath.replace(/\\/g, '/')}`;
            vscode.window.showInformationMessage(`Syncing ${filePath} to device...`);
            outputChannel.appendLine(`[SYNC] Uploading ${filePath} → ${devicePath}`);

            const command = `"${venvPython}" -m mpremote connect ${port} resume cp "${filePath}" "${devicePath}"`;
            terminal.sendText(command);
            // exec(command, (error) => {
            //     if (error) {
            //         outputChannel.appendLine(`[ERROR] Sync failed for ${filePath}: ${error.message}`);
            //     } else {
            //         outputChannel.appendLine(`[SYNC] Uploaded ${filePath} → ${devicePath}`);
            //     }
            // });

            syncQueue.delete(filePath);
        }, debounceTime));
    };

    // File watcher setup
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(syncFolderPath, '**/*'),
        false, // ignoreCreateEvents (we handle separately)
        false, // ignoreChangeEvents
        false  // ignoreDeleteEvents
    );

    watcher.onDidChange(uri => syncFile(uri.fsPath));
    watcher.onDidCreate(uri => syncFile(uri.fsPath));
    watcher.onDidDelete(uri => {
        const filePath = uri.fsPath;
        const relativePath = path.relative(syncFolderPath, filePath);
        const devicePath = `:${relativePath.replace(/\\/g, '/')}`;
        vscode.window.showInformationMessage(`File deleted: ${filePath}. Removing from device...`);
        // terminal.show();
        // go to command line 

        const command = `$"{venvPython}" -m mpremote connect ${port} rm "${devicePath}"`;
        // 2. List files on device
        terminal.sendText(command);
        // exec(command, (error) => {
        //     if (error) {
        //         outputChannel.appendLine(`[ERROR] Delete failed for ${devicePath}: ${error.message}`);
        //     } else {
        //         outputChannel.appendLine(`[DELETE] Removed ${devicePath}`);
        //     }
        // });
    });

    context.subscriptions.push(watcher);
    context.subscriptions.push(outputChannel);
}
async function handleRunCode(context) {

    // 4. Start server only when needed
    if (!await isServerRunning()) {
        const started = await startServer(context);
        if (!started) {
            vscode.window.showErrorMessage('Failed to start server');
            return;
        }
    }

    // 5. Execute user code
    const code = await getActiveEditorCode();
    if (code) {
        executeCode(code);
    }
}
async function getActiveEditorCode() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor');
        return null;
    }
    return editor.document.getText();
}
function executeCode(code) {
    const ws = new WebSocket(`ws://localhost:${WS_PORT}`);

    ws.on('open', () => {

        ws.send(code);
    });

    ws.on('message', (data) => {
        const output = vscode.window.createOutputChannel("MicroPython Output");
        output.appendLine(data.toString());
        output.show();
    });

    ws.on('error', (err) => {

    });
}
async function getDevicePortFromIni(context) {
    const iniPath = path.join(context.extensionPath, 'device.cfg');
    try {
        const data = await fs.readFile(iniPath, 'utf8');
        const portMatch = data.match(/port\s*=\s*(.+)/);
        return portMatch ? portMatch[1].trim() : null;
    } catch {
        return context.globalState.get('selectedMicroPythonDevice') || null;
    }
}
async function updateLastSync(configPath, newTimestamp) {
    try {
        let content = await fs.readFile(configPath, 'utf8');

        // Replace the line starting with 'last_sync ='
        content = content.replace(
            /last_sync\s*=\s*[^\n]+/,
            `last_sync = ${newTimestamp}`
        );

        await fs.writeFile(configPath, content, 'utf8');
        console.log('last_sync updated successfully.');
    } catch (err) {
        console.error('Failed to update config file:', err);
    }
}
// Helper: Get Python path in venv
function getVenvPythonPath(venvPath) {
    const isWindows = process.platform === 'win32';
    return path.join(
        venvPath,
        isWindows ? 'Scripts/python.exe' : 'bin/python'
    );
}
//  get virtual enviroment path folder 
function getVenvPythonPathFolder() {
    const appDataDir = os.homedir();
    const micropythonStudioDir = path.join(appDataDir, '.micropython-studio');
    const venvFolderName = '.venv';
    const venvPathFolder = path.join(micropythonStudioDir, venvFolderName);
    return venvPathFolder;
}
async function setupVirtualEnv(context) {
    const os = require('os');
    const path = require('path');
    const fs = require('fs/promises');
    const vscode = require('vscode');
    const micropythonStudioDir = path.join(os.homedir(), '.micropython-studio');
    const venvFolder = '.venv';
    const venvPath = path.join(micropythonStudioDir, venvFolder);
    const requirementsPath = path.resolve(path.join(context.extensionPath, 'requirements.txt'));

    try {
        // Create base directory
        await fs.mkdir(micropythonStudioDir, { recursive: true });

        // Check if venv already exists
        try {
            await fs.access(venvPath);
            vscode.window.showInformationMessage('MicroPython virtual environment already exists.');
            return getVenvPythonPath(venvPath);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }

        const pythonExecutable = await getPythonCommand();
        const outputChannel = vscode.window.createOutputChannel('Venv Setup');
        outputChannel.show();
        outputChannel.appendLine('Setting up MicroPython virtual environment...');

        // 1. Create virtual environment
        await runCommand(outputChannel, pythonExecutable, ['-m', 'venv', venvPath], micropythonStudioDir);

        const venvPython = getVenvPythonPath(venvPath);

        // 2. Upgrade pip
        // await runCommand(outputChannel, venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], micropythonStudioDir);
        // 
        await runCommand(
            outputChannel,
            venvPython,
            ['-m', 'pip', 'install', '--upgrade', 'pip'],
            micropythonStudioDir
        );

        // await runCommand(
        //     outputChannel,
        //     venvPython,
        //     ['-m', 'pip', 'install', 'pipx==1.7.0'],
        //     micropythonStudioDir
        // );

        // await runCommand(
        //     outputChannel,
        //     venvPython,
        //     ['-m', 'pip', 'install', 'rich-click==1.8.8', 'pyusb==1.3.0'],
        //     micropythonStudioDir
        // );

        // 3. Install requirements
        try {
            await fs.access(requirementsPath);
            await runCommand(
                outputChannel,
                venvPython,
                ['-m', 'pip', 'install', '-r', requirementsPath],
                micropythonStudioDir
            );
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;

            // Install default packages
            outputChannel.appendLine('requirements.txt not found. Installing default packages.');
            const packages = [
                'pyserial', 'adafruit-ampy', 'rshell', 'esptool',
                'mpremote', 'mpflash', 'micropython-stubber',
                'micropython-rp2-pico_w-stubs', 'code2flow'
            ];
            await runCommand(outputChannel, venvPython, ['-m', 'pip', 'install', ...packages], micropythonStudioDir);
        }
        // await runCommand(
        //     outputChannel,
        //     venvPython,
        //     ['-m', 'pip', 'install', 'micropython-stubber', 'micropython-stdlib-stubs'],
        //     micropythonStudioDir
        // );

        vscode.window.showInformationMessage('Virtual environment setup complete!');
        return venvPython;
    } catch (error) {
        vscode.window.showErrorMessage(`Virtual environment setup failed: ${error.message}`);
        console.error('Venv setup error:', error);
        throw error;
    }
}

// Helper function to run commands
function runCommand(outputChannel, command, args, cwd) {
    return new Promise((resolve, reject) => {
        outputChannel.appendLine(`Running: ${command} ${args.join(' ')}`);
        console.log(`Running: ${command} ${args.join(' ')}`);

        const process = spawn(command, args, {
            cwd,
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        process.stdout.on('data', (data) => {
            outputChannel.append(data.toString());
        });

        process.stderr.on('data', (data) => {
            outputChannel.append(data.toString());
        });

        process.on('close', (code) => {
            if (code === 0) {
                outputChannel.appendLine('Command completed successfully');
                resolve();
            } else {
                outputChannel.appendLine(`Command failed with code ${code}`);
                reject(new Error(`Process exited with code ${code}`));
            }
        });

        process.on('error', (error) => {
            outputChannel.appendLine(`Command error: ${error.message}`);
            reject(error);
        });
    });
}
// Helper: Detect working Python command
async function getPythonCommand() {
    return new Promise((resolve) => {
        exec('python3 --version', (py3Error) => {
            if (!py3Error) {
                resolve('python3');
            } else {
                exec('python --version', (pyError) => {
                    resolve(pyError ? 'python' : 'python3');
                });
            }
        });
    });
}
function fixGitBashPath(winPath) {
    // Replace backslashes with forward slashes
    let fixed = winPath.replace(/\\/g, '/');
    // Convert drive letter (C:\ -> /c/)
    fixed = fixed.replace(/^([a-zA-Z]):\//, (match, letter) =>
        `/` + letter.toLowerCase() + `/`
    );
    // Remove extra slashes
    fixed = fixed.replace(/\/\/+/g, '/');
    return fixed;
}
// Helper: Get Git repo name
async function getGitRepoName(folderPath) {
    const gitDir = path.join(folderPath, '.git');
    try {
        await fs.access(gitDir);
        const config = await fs.readFile(path.join(gitDir, 'config'), 'utf8');
        const originMatch = config.match(/url *= *([^\\r\\n]+)/i);
        if (originMatch) {
            const url = originMatch[1];
            return url.split('/').pop().replace('.git', '');
        }

        const { execSync } = require('child_process');
        let remote = execSync('git remote -v', { cwd: folderPath, encoding: 'utf8' });
        const remoteUrl = remote.split('\n')[0]?.split(/\s+/)[1];
        if (remoteUrl) {
            return remoteUrl.split('/').pop().replace('.git', '');
        }

        return null;
    } catch {
        return null;
    }
}
// Function 1: Python availability check
function checkPythonAvailability() { // 👈 Accept vscode as an argument
    exec('python --version', (err) => {
        if (err) {
            vscode.window.showWarningMessage(
                'Python not found in PATH. Try installing Python or using python3.'
            );
        }
    });
}
// Function 2: Auto-start server
async function autoStartServer(context) {
    if (await isVenvReady(context)) {
        const venvPython = getVenvPythonPath(context);
        console.log(venvPython);
        console.log(context);
        serverProcess = startServer(venvPython, context);
    }
}
// Fucntion 2.1: Helper: Check if venv exists
async function isVenvReady(context) {
    const venvPath = path.join(context.extensionPath, '.micropython-venv');
    try {
        await fs.access(venvPath);
        return true;
    } catch {
        return false;
    }
}
// Fucntion 2.2: Helper Start server process
function startServer(venvPython, context) {
    const serverPath = path.join(context.extensionPath, 'python', 'server.py');
    const args = [serverPath, '--port', String(WS_PORT)];

    console.log(args)
    const server = spawn(venvPython, args, {
        shell: true,
        cwd: context.extensionPath
    });
    console.log(server);
    const serverOutput = vscode.window.createOutputChannel("MicroPython Server");

    server.stdout.on('data', (data) => {
        serverOutput.appendLine(data.toString());
    });

    server.stderr.on('data', (data) => {
        serverOutput.appendLine(`ERROR: ${data.toString()}`);
    });

    server.on('close', (code) => {
        serverOutput.appendLine(`Server exited with code ${code}`);
        serverProcess = null;
    });

    serverOutput.show();

    return server;
}
// Fucntion 2.3: Helper Wait for server
async function waitForServerReady(timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (await isServerRunning()) return true;
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
}
// Fucntion 2.4: Helper Check server status
async function isServerRunning() {
    return new Promise((resolve) => {
        const testSocket = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
        console.log('Test Socket:${testSocket}');
        testSocket.on('open', () => {
            testSocket.close();
            resolve(true);
        });
        testSocket.on('error', () => resolve(false));
    });
}
// Fucntion 2.5: Helper Connect WebSocket
function connectWebSocket(code) {
    if (wsClient) {
        wsClient.close();
    }

    wsClient = new WebSocket(`ws://127.0.0.1:${WS_PORT}`);
    console.log('Connect New Socket:${wsClient}');
    wsClient.on('open', () => {
        outputChannel.appendLine("Connected to execution server");
        wsClient.send(code);
    });

    wsClient.on('message', (data) => {
        const str = data.toString();
        console.log(str);
        try {
            const msg = JSON.parse(str);
            outputChannel.appendLine(`[${msg.type.toUpperCase()}] ${msg.data}`);
        } catch {
            outputChannel.appendLine(`SERVER: ${str}`);
        }
    });

    wsClient.on('close', () => {
        outputChannel.appendLine("Connection closed");
        wsClient = null;
    });

    wsClient.on('error', (err) => {
        outputChannel.appendLine(`WebSocket error: ${err.message}`);
        vscode.window.showErrorMessage(`Connection error: ${err.message}`);
    });
}
// Function 2.6: Helper Start server if needed
async function startServerIfNeeded(context) {
    const var_startServer = await vscode.window.showInformationMessage(
        "Execution server not running. Start it now?",
        "Start Server"
    );

    if (var_startServer !== "Start Server") {
        vscode.window.showErrorMessage("Execution requires server to be running");
        return false;
    }

    const venvPython = getVenvPythonPath(context);
    serverProcess = startServer(venvPython, context);

    if (!(await waitForServerReady())) {
        vscode.window.showErrorMessage("Server failed to start");
        return false;
    }

    return true;
}
// Fucntion 3: Helper Get editor code
async function getEditorCode() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
        vscode.window.showErrorMessage('No active editor');
        return null;
    }

    const code = editor.document.getText(editor.selection) || editor.document.getText();
    if (!code.trim()) {
        vscode.window.showErrorMessage('No code to execute');
        return null;
    }

    return code;
}
// Deactivation handler
function deactivate() {
    if (wsClient) wsClient.close();
    if (serverProcess) serverProcess.kill();
}

module.exports = { activate, deactivate };