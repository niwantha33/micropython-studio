const vscode = require('vscode');
const axios = require('axios');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const WebSocket = require('ws');
// user app js files 


// Global variables
let wsClient = null;
let serverProcess = null;
let outputChannel = null;
const WS_PORT = 8765;

const debugChannel = vscode.window.createOutputChannel("MicroPython Debug");

// Main activation function
function activate(context) {
    checkPythonAvailability();
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

            if (!projectName) {
                vscode.window.showInformationMessage('Project creation cancelled.');
                return;
            }

            const mcuOptions = ['esp32', 'rp2040', 'rp2050', 'stm32'];
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

            const projectExists = await fs.access(projectDir)
                .then(() => true)
                .catch(() => false);

            if (projectExists) {
                vscode.window.showInformationMessage(`Project "${projectName}" already exists. Updating device info...`);
            } else {
                // Create project folder and structure
                await fs.mkdir(projectDir, { recursive: true });
                await fs.mkdir(mcuDir, { recursive: true });
                await fs.mkdir(dividerFolderDir, { recursive: true });

                await fs.writeFile(
                    path.join(mcuDir, '_device_root.txt'),
                    `This folder represents the root filesystem of your MicroPython device (${selectedMcu}).\n[Read-only view - files here are stored on your MCU]`,
                    'utf8'
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
                    "files.exclude": {
                        "**/.helper": true
                    },
                    "python.languageServer": "Pylance",
                    "python.analysis.typeCheckingMode": "basic",
                    "python.analysis.diagnosticSeverityOverrides": {
                        "reportMissingModuleSource": "none"
                    },
                    "python.analysis.typeshedPaths": [
                        "${workspaceFolder}/.micropython-venv/Lib/site-packages"

                    ],
                }, null, 2));
            }

            // Detect device
            const venvPython = getVenvPythonPath(context);
            const command = `${venvPython} -m mpremote connect list`;

            const { exec } = require('child_process');

            exec(command, async (error, stdout, stderr) => {
                if (error) {
                    vscode.window.showErrorMessage(`Error detecting devices: ${stderr}`);
                    return;
                }

                const rawOutput = stdout.trim();
                if (!rawOutput) {
                    vscode.window.showInformationMessage('No MicroPython devices found.');
                    return;
                }

                const lines = rawOutput.split('\n').filter(line => line.trim());

                const devices = lines.map(line => {
                    const parts = line.trim().split(/\s+/);
                    const port = parts[0];
                    const vidpid = parts[2];

                    let mcuType = 'Unknown Device';
                    if (vidpid === '2e8a:0005') mcuType = 'RP2040';
                    else if (vidpid.includes('10c4') || vidpid.includes('0403')) mcuType = 'ESP32';
                    else if (vidpid.includes('0483')) mcuType = 'STM32';

                    return {
                        label: port,
                        description: mcuType
                    };
                });

                const selected = await vscode.window.showQuickPick(devices, {
                    placeHolder: 'Select a connected MicroPython device'
                });

                if (!selected) {
                    vscode.window.showInformationMessage('No device selected.');
                    return;
                }

                const selectedDevice = selected.label;
                const mcuType = selected.description;

                const deviceUtilPath = path.join(projectDir, 'device.cfg');

                try {
                    const device_data = `[device]\nport = ${selectedDevice}\nmcu = ${selectedMcu}\nlast_sync = ${new Date().toISOString()}`;
                    await fs.writeFile(deviceUtilPath, device_data, 'utf8');
                    vscode.window.showInformationMessage(`Device saved to: ${deviceUtilPath}`);
                } catch (writeError) {
                    vscode.window.showErrorMessage(`Failed to save device file: ${writeError.message}`);
                    return;
                }

                const workspaceFilePath = path.join(parentPath, `${projectName}.code-workspace`);

                // Try to get repo name
                const repoName = await getGitRepoName(parentPath) || projectName;

                const workspaceContent = {
                    "folders": [
                        { "path": projectName, "name": `📁 ${repoName}` },
                        { "path": dividerFolderName, "name": `──────────────────────` },
                        { "path": `mcu_${selectedMcu}`, "name": `🖥️ Device (${selectedMcu.toUpperCase()})` }
                    ],
                    "settings": {
                        "micropython-ide": {
                            "selectedDevice": selectedDevice,
                            "mcuType": mcuType
                        }
                    }
                };

                try {
                    await fs.writeFile(workspaceFilePath, JSON.stringify(workspaceContent, null, 2));
                    vscode.window.showInformationMessage(`Saved device info to workspace file`);
                } catch (writeError) {
                    vscode.window.showErrorMessage(`Failed to update workspace file: ${writeError.message}`);
                }

                context.globalState.update('selectedMicroPythonDevice', selectedDevice);
                vscode.window.showInformationMessage(`Device ${selectedDevice} saved for project ${projectName}`);

                // Open workspace
                await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(workspaceFilePath), { forceNewWindow: false });

                const action = await vscode.window.showInformationMessage(
                    'Reload window to refresh folder names and settings?',
                    'Reload'
                );
                if (action === 'Reload') {
                    await vscode.commands.executeCommand('workbench.action.reloadWindow');
                }
            });
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create or update project: ${error.message}`);
        }
    });
    context.subscriptions.push(detectDeviceCommand);

    let mountMcuFolderCommand = vscode.commands.registerCommand('micropython-ide.mountMcuFolder', async (folderUri) => {
        const mcuFolderPath = folderUri.fsPath;
        // console.log()`cd "${mcuFolderPath}"`)
        const selectedDevice = context.globalState.get('selectedMicroPythonDevice');

        if (!selectedDevice) {
            vscode.window.showErrorMessage('No device selected. Detect and select one first.');
            return;
        }

        const venvPython = getVenvPythonPath(context);
        const terminal = vscode.window.createTerminal("MicroPython Mount");
        terminal.show();
        console.log(`cd "${fixGitBashPath(mcuFolderPath)}"`);
        terminal.sendText(`cd "${fixGitBashPath(mcuFolderPath)}"`);
        terminal.sendText(`${venvPython} -m mpremote connect ${selectedDevice} mount .`);
        
    });
    context.subscriptions.push(mountMcuFolderCommand);

    let refreshMcuFolderCommand = vscode.commands.registerCommand('micropython-ide.refreshMcuFolder', async (folderUri) => {
        const mcuFolderPath = folderUri.fsPath;
        const projectPath = path.dirname(mcuFolderPath);
        const selectedMcu = path.basename(mcuFolderPath).replace(/^mcu_/, '');

        // Step 1: Read COM port from device_com.ini
        const deviceIniPath = path.join(projectPath, 'device_com.ini');
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

        const venvPython = getVenvPythonPath(context);
        const terminal = vscode.window.createTerminal("MicroPython File Downloader");
        terminal.show();
        terminal.sendText(`cd "${fixGitBashPath(projectPath)}"`);

        // Step 2: Clear mcu_* folder before refresh (optional)
        await fs.rm(mcuFolderPath, { recursive: true, force: true });
        await fs.mkdir(mcuFolderPath, { recursive: true });

        // Step 3: Download all files and directories from device
        terminal.sendText(`${venvPython} -m mpremote connect ${selectedDevice} fs ls`);
        terminal.sendText(`${venvPython} -m mpremote connect ${selectedDevice} fs cp -r : ${fixGitBashPath(mcuFolderPath)}`);


        // Step 4: Show success message and reload
        const action = await vscode.window.showInformationMessage(
            `Downloaded all files from ${selectedDevice}. Reload to refresh Explorer?`,
            'Reload'
        );
        if (action === 'Reload') {
            await vscode.commands.executeCommand('workbench.action.reloadWindow');
        }
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

            const mcuOptions = ['esp32', 'rp2040', 'rp2050', 'stm32'];
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



async function handleRunCode(context) {
    debugChannel.appendLine('RunCode command triggered');
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
        debugChannel.appendLine('Sending code to server');
        ws.send(code);
    });

    ws.on('message', (data) => {
        const output = vscode.window.createOutputChannel("MicroPython Output");
        output.appendLine(data.toString());
        output.show();
    });

    ws.on('error', (err) => {
        debugChannel.appendLine(`WebSocket error: ${err.message}`);
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
function getVenvPythonPath(context) {
    const isWindows = process.platform === 'win32';
    return isWindows
        ? `"${path.join(context.extensionPath, '.micropython-venv', 'Scripts', 'python.exe')}"`
        : `"${path.join(context.extensionPath, '.micropython-venv', 'bin', 'python')}"`;
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
// Helper: Detect working Python command
async function getPythonCommand() {
    return new Promise((resolve) => {
        const { exec } = require('child_process');
        exec('python --version', (err, stdout) => {
            if (!err && stdout.includes('Python 3')) {
                resolve('python');
                return;
            }

            exec('python3 --version', (err) => {
                if (!err) {
                    resolve('python3');
                } else {
                    resolve('python');
                }
            });
        });
    });
}
// Helper: Setup venv
async function setupVirtualEnv(context) {
    const venvFolder = '.micropython-venv';
    const venvPath = path.join(context.extensionPath, venvFolder);

    const pythonExecutable = await getPythonCommand();

    const requirementsPath = path.join(context.extensionPath, 'requirements.txt');
    console.log(requirementsPath)

    try {
        await fs.access(venvPath);
        vscode.window.showInformationMessage('Virtual environment already exists.');
        return getVenvPythonPath(context);
    } catch {
        const terminal = vscode.window.createTerminal("MicroPython Setup");
        terminal.show();
        terminal.sendText(`cd "${context.extensionPath}"`);
        terminal.sendText(`${pythonExecutable} -m venv "${venvPath}"`);

        const venvPython = getVenvPythonPath(context);

        terminal.sendText(`${venvPython} -m pip install --upgrade pip`);

        if (await fs.access(requirementsPath).catch(() => false)) {
            terminal.sendText(`${venvPython} -m pip install -r requirements.txt`);
        } else {
            terminal.sendText(`${venvPython} -m pip install websockets pyserial pyserial adafruit-ampy rshell esptool mpremote mpflash`);

            terminal.sendText(`${venvPython} -m  pip install micropython-stubber`);

            terminal.sendText(`${venvPython} -m  pip install -U micropython-rp2-pico_w-stubs`);
        }

        return venvPython;
    }
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