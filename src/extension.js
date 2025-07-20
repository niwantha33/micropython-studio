const vscode = require('vscode');
const axios = require('axios');
const { exec, spawn } = require('child_process');

const path = require('path');
const fs = require('fs').promises;
const WebSocket = require('ws');

const os = require('os');
const util = require('util');


// user app js files 


// Global variables
let wsClient = null;
let serverProcess = null;
let outputChannel = null;
const WS_PORT = 8765;



let mpremoteTerminal;
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

function getMpremoteTerminal() {
    if (!mpremoteTerminal || mpremoteTerminal.exitStatus) {
        mpremoteTerminal = vscode.window.createTerminal("micropython-studio");
    }
    // mpremoteTerminal.show();
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
    syncRTC_OnMcuButton.text = `$(watch) Set RTC`;
    syncRTC_OnMcuButton.tooltip = `Set RTC time on MicroPython device`;
    syncRTC_OnMcuButton.command = 'micropython-ide.runUtil';
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



// Main activation function
function activate(context) {
    checkPythonAvailability();
    showButtonsInTaskbar(context);


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


        terminal.sendText(`"${venvPython}" -m mpremote reset`);
    });
    context.subscriptions.push(stopCommand);

    // const syncMcuFolderCommand = vscode.commands.registerCommand('micropython-ide.syncMcuFolder', async () => {
    //     // 1. Get the actual sync folder path from workspace
    //     const syncFolderPath = await getSyncFolderPath(context);
    //     if (!syncFolderPath) {
    //         vscode.window.showErrorMessage('Could not find MCU sync folder');
    //         return;
    //     }

    //     // 2. Get parent path (one level up)
    //     const parentPath = path.dirname(syncFolderPath);

    //     console.log("Actual parent path:", parentPath);

    //     try {
    //         // 3. Find device.cfg in parent directory
    //         // const deviceIniPath = path.join(parentPath, 'device.cfg');
    //         //  const { port, syncFolder } = await parseDeviceConfig(deviceIniPath);

    //         // console.log("Looking for device.cfg at:", deviceIniPath);

    //         // if (!deviceIniPath) {
    //         //     vscode.window.showErrorMessage(`device.cfg not found at: ${deviceIniPath}`);
    //         //     return;
    //         // }

    //         // 4. Parse device.cfg
    //         const { sync_folder, port } = await parseDeviceConfig(parentPath);
    //         if (!port) {
    //             vscode.window.showErrorMessage('Device port not found in device.cfg');
    //             return;
    //         }

    //         const venvPython = getVenvPythonPath(context);

    //         // 5. Sync command
    //         const terminal = vscode.window.createTerminal("MicroPython Sync");
    //         terminal.show();
    //         terminal.sendText(`cd "${fixGitBashPath(parentPath)}"`);
    //         terminal.sendText(`${venvPython} -m mpremote connect ${port} fs cp -r "${fixGitBashPath(syncFolderPath)}" :`);

    //         vscode.window.showInformationMessage(`Synced ${path.basename(syncFolderPath)} to ${port}`);
    //     } catch (error) {
    //         vscode.window.showErrorMessage(`Sync failed: ${error.message}`);
    //         console.error("Sync error:", error);
    //     }
    // });


    const syncMcuFolderCommand = vscode.commands.registerCommand('micropython-ide.syncMcuFolder', async () => {

        // Get current workspace or active file path
        let workingProjectPath;
        let syncMcuFolder;

        syncMcuFolder = await getSyncFolderPath(context);

        console.log("Root path:", syncMcuFolder)

        if (!syncMcuFolder) {
            vscode.window.showErrorMessage('Could not find MCU sync folder');
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
            setupAutoSync(context, syncMcuFolder, port);

            // Verify sync folder exists
            if (!syncMcuFolder) {
                vscode.window.showErrorMessage(`Sync folder not found: ${syncMcuFolder}`);
                return;
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

        terminal.sendText(`"${venvPython}" -m mpremote connect ${selectedDevice} soft-reset`);

        if (isMcuFolder) {
            // File is in mcu_* folder (mounted), run using import
            terminal.sendText(`"${venvPython}" -m mpremote connect ${selectedDevice} exec "import ${fileName.replace('.py', '')}" + repl`);
        } else {
            // File is local, send it to device using 'run'
            terminal.sendText(`"${venvPython}" -m mpremote connect ${selectedDevice} run "${filePath}" + repl`);
        }

        vscode.window.showInformationMessage(`Running ${fileName} on ${selectedDevice}`);
    });
    context.subscriptions.push(runOnMcuCommand);

    // Auto-start Flask server if venv exists
    // autoStartServer(context);        

    // Register commands
    let setupEnvCommand = vscode.commands.registerCommand('micropython-ide.setupEnvironment', async () => {
        await setupVirtualEnv(context);
    });


    let runCommand = vscode.commands.registerCommand('micropython-ide.runCode', async () => {
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

    let installDepsCommand = vscode.commands.registerCommand('micropython-ide.installDependencies', async () => {
        const terminal = vscode.window.createTerminal("MicroPython Dependency Installer");
        terminal.show();
        const projectRoot = path.join(__dirname, '..');
        const requirementsPath = path.join(projectRoot, 'requirements.txt');

        try {
            await fs.access(requirementsPath);
        } catch (err) {
            vscode.window.showErrorMessage(`requirements.txt not found in project root.`);
            return;
        }

        terminal.sendText(`cd "${projectRoot}"`);
        terminal.sendText(`pip install -r requirements.txt`);
        vscode.window.showInformationMessage("Installing MicroPython dependencies...");
    });


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
        terminal.sendText(`"${venvPython}" -m mpremote connect ${port} fs ls`);

        // 3. Copy all files from device to sync folder (NOTE: manually copy files; no wildcards)
        terminal.sendText(`"${venvPython}" -m mpremote connect ${port} fs cp -r : "${fixGitBashPath(syncFolderPath)}"`);

        // 4. Mount local sync folder to MCU
        // terminal.sendText(`${venvPython} -m mpremote connect ${port} mount "${fixGitBashPath(syncFolderPath)}"`);

        // vscode.window.showInformationMessage(`Mounted ${syncFolder} to ${port}. Auto-sync enabled!`);
        // 6. Set up file watcher for auto-sync

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
        terminal.sendText(`"${venvPython}" -m mpremote connect ${port} umount`);
    });
    context.subscriptions.push(unmountMcuFolderCommand);


    let refreshMcuFolderCommand = vscode.commands.registerCommand('micropython-ide.refreshMcuFolder', async (folderUri) => {
        const appDataDir = os.homedir();
        const micropythonStudioDir = path.join(appDataDir, '.micropython-studio');
        const terminal = vscode.window.createTerminal("MicroPython Sync");
        terminal.show();
        terminal.sendText(`cd "${fixGitBashPath(micropythonStudioDir)}"`);

    });
    context.subscriptions.push(refreshMcuFolderCommand);

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
    context.subscriptions.push(setupEnvCommand);
    context.subscriptions.push(installDepsCommand);
    context.subscriptions.push(runCommand);
    context.subscriptions.push(createProjectCommand);
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
    for (const dir of siblingDirs) {
        if (dir.isDirectory()) {
            const possiblePath = path.join(parentPath, dir.name, 'device.cfg');
            try {
                await fs.access(possiblePath);
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

    // Debounce to prevent rapid consecutive syncs
    const syncQueue = new Map();
    const debounceTime = 1000; // 1 second

    const syncFile = (filePath) => {
        if (syncQueue.has(filePath)) {
            clearTimeout(syncQueue.get(filePath));
        }

        syncQueue.set(filePath, setTimeout(() => {
            const relativePath = path.relative(syncFolderPath, filePath);
            const devicePath = `:${relativePath.replace(/\\/g, '/')}`;

            const command = `${venvPython} -m mpremote connect ${port} cp "${filePath}" "${devicePath}"`;
            exec(command, (error) => {
                if (error) {
                    outputChannel.appendLine(`[ERROR] Sync failed for ${filePath}: ${error.message}`);
                } else {
                    outputChannel.appendLine(`[SYNC] Uploaded ${filePath} → ${devicePath}`);
                }
            });

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

        const command = `${venvPython} -m mpremote connect ${port} rm "${devicePath}"`;
        exec(command, (error) => {
            if (error) {
                outputChannel.appendLine(`[ERROR] Delete failed for ${devicePath}: ${error.message}`);
            } else {
                outputChannel.appendLine(`[DELETE] Removed ${devicePath}`);
            }
        });
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
    const appDataDir = os.homedir();
    const micropythonStudioDir = path.join(appDataDir, '.micropython-studio');
    const venvFolder = '.venv';
    const venvPath = path.join(micropythonStudioDir, venvFolder);
    const requirementsPath = path.join(context.extensionPath, 'requirements.txt');

    try {
        // Create base directory
        await fs.mkdir(micropythonStudioDir, { recursive: true });

        // Check if venv already exists
        try {
            await fs.access(venvPath);
            vscode.window.showInformationMessage('MicroPython virtual environment already exists.');
            return getVenvPythonPath(venvPath);
        } catch (error) {
            // Only proceed if venv doesn't exist
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
        await runCommand(outputChannel, venvPython, ['-m', 'pip', 'install', '--upgrade', 'pip'], micropythonStudioDir);

        // 3. Install requirements
        try {
            await fs.access(requirementsPath);
            await runCommand(outputChannel, venvPython, ['-m', 'pip', 'install', '-r', requirementsPath], micropythonStudioDir);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;

            // Install default packages
            outputChannel.appendLine('requirements.txt not found. Installing default packages.');
            const packages = [
                'pyserial', 'adafruit-ampy', 'rshell', 'esptool',
                'mpremote', 'mpflash', 'micropython-stubber',
                'micropython-rp2-pico_w-stubs'
            ];
            await runCommand(outputChannel, venvPython, ['-m', 'pip', 'install', ...packages], micropythonStudioDir);
        }

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