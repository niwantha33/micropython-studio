/**
 * setupenv.js
 * setup virtual environment and install necessary files 
 * @license MIT
 * @version 1.0
 * @author  Niwantha Meepage 
 */

const vscode = require('vscode');
const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');
const { getVenvPythonPathFolder, getVenvPythonPath } = require('./commonFxn');
const { languageOption, mcuOptions_MP, rpBoards_MP, espBoards_MP, stmBoards_MP, samBoards_MP, nrfBoards_MP, raBoards_MP, mix_MP } = require('./mcuoption');

async function createNewProjectConfigDict(configDict, folderUri) {
    configDict['parentPath'] = folderUri[0].fsPath;
    configDict['projectDir'] = path.join(configDict.parentPath, configDict.projectName);
    configDict['deviceCodeDir'] = path.join(configDict.projectDir, 'device_code');
    configDict['settingsDir'] = path.join(configDict.projectDir, '.vscode');
    configDict['projectExists'] = await fs.access(configDict.projectDir).then(() => true).catch(() => false);
    return configDict;
}

async function selectMcuAndBoard() {
    const configDict = {};

    try {
        const projectName = await vscode.window.showInputBox({
            prompt: 'Enter project name',
            placeHolder: 'e.g. my-micropython-project',
            validateInput: value => value ? null : 'Project name is required'
        });

        if (!projectName) return;
        configDict.projectName = projectName;

        const progLanguage = await vscode.window.showQuickPick(languageOption, {
            placeHolder: 'Select target Programming Language'
        });

        if (!progLanguage) return;
        configDict.progLanguage = progLanguage;

        if (progLanguage === 'Micropython') {
            const selectedMcuFamily = await vscode.window.showQuickPick(mcuOptions_MP, {
                placeHolder: 'Select target microcontroller Family'
            });

            if (!selectedMcuFamily) return;
            configDict.selectedMcuFamily = selectedMcuFamily;

            let selectedMcuTarget = null;
            const placeHolderStr = 'Select target microcontroller';

            if (selectedMcuFamily === 'RP2') {
                selectedMcuTarget = await vscode.window.showQuickPick(rpBoards_MP, {
                    placeHolder: placeHolderStr
                });
            } else if (selectedMcuFamily === 'ESP') {
                selectedMcuTarget = await vscode.window.showQuickPick(espBoards_MP, {
                    placeHolder: placeHolderStr
                });
            } else if (selectedMcuFamily === 'STM') {
                selectedMcuTarget = await vscode.window.showQuickPick(stmBoards_MP, {
                    placeHolder: placeHolderStr
                });
            } else if (selectedMcuFamily === 'SAM') {
                selectedMcuTarget = await vscode.window.showQuickPick(samBoards_MP, {
                    placeHolder: placeHolderStr
                });
            } else if (selectedMcuFamily === 'NRF') {
                selectedMcuTarget = await vscode.window.showQuickPick(nrfBoards_MP, {
                    placeHolder: placeHolderStr
                });
            } else if (selectedMcuFamily === 'RA') {
                selectedMcuTarget = await vscode.window.showQuickPick(raBoards_MP, {
                    placeHolder: placeHolderStr
                });
            } else {
                selectedMcuTarget = await vscode.window.showQuickPick(mix_MP, {
                    placeHolder: placeHolderStr
                });
            }

            if (!selectedMcuTarget) return;
            configDict.selectedMcuTarget = selectedMcuTarget;
        } else if (progLanguage === 'CircuitPython') {
            vscode.window.showErrorMessage('CircuitPython Not supported!');
            return;
        }

        const folderUri = await vscode.window.showOpenDialog({
            canSelectFiles: false,
            canSelectFolders: true,
            openLabel: 'Select Project Folder Location'
        });

        if (!folderUri?.length) return;

        return await createNewProjectConfigDict(configDict, folderUri);
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to create or update project: ${err.message}`);
    }
}

async function creatNewProject(context, outputChnnel) {
    try {
        const config = await selectMcuAndBoard();
        if (!config) return;

        // Create project directories
        await fs.mkdir(config.projectDir, { recursive: true });
        await fs.mkdir(config.deviceCodeDir, { recursive: true });
        await fs.mkdir(config.settingsDir, { recursive: true });

        // Get virtual environment paths
        const venvFolder = getVenvPythonPathFolder();
        const venvPython = getVenvPythonPath(venvFolder);

        // Create device code files
        await fs.writeFile(
            path.join(config.deviceCodeDir, 'main.py'),
            `# MicroPython Project for ${config.selectedMcuTarget}\nprint("Hello from ${config.projectName}")`
        );

        // Create .mcu config file to remember the target
        await fs.writeFile(
            path.join(config.deviceCodeDir, '.mcu'),
            config.selectedMcuTarget,
            'utf8'
        );

        // Create pylint configuration
        await fs.writeFile(
            path.join(config.projectDir, '.pylintrc'),
            `
# Pylint Configuration for MicroPython Project
[MESSAGES CONTROL]
# Disable common false positives in MicroPython
disable=E0401,       # Import error (micropython modules not found)
        W0511,       # NotImplemented warning
        W0718,       # Broad exception caught
        I1101,       # Unable to import (for C modules)
        C0301,       # Line too long
        E1101,       # Instance of 'module' has no 'xxx' member
        C0116        # Missing function docstring

[DESIGN]
max-args=10
max-locals=15
max-returns=5
max-statements=50
max-line-length=120

[FORMAT]
# Use 4 spaces for indentation
indent-string='    '

[REPORTS]
output-format=text
reports=no
`.trim()
        );

        // Detect connected devices
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
                if (vidpid === '2e8a:0005') {
                    mcuType = `${config.selectedMcuTarget}`;
                    copyVidpid = vidpid;
                }
                else if (vidpid.includes('10c4') || vidpid.includes('0403')) { mcuType = 'ESP32'; copyVidpid = vidpid; }
                else if (vidpid.includes('0483')) { mcuType = 'STM32'; copyVidpid = vidpid; }
                return { label: port, description: mcuType };
            });

            const selected = await vscode.window.showQuickPick(devices, {
                placeHolder: 'Select a connected MicroPython device'
            });

            if (!selected) return;

            const selectedDevice = selected.label;
            const now = new Date().toISOString();

            // Create device configuration
            const deviceCfgPath = path.join(config.projectDir, 'device.cfg');
            const deviceCfgContent = `
[device]
port = ${selectedDevice}
mcu = ${config.selectedMcuTarget}
sync_folder = device_code
root_folder = ${config.projectName}
project_created = ${now}
last_sync = ${now}
device_firmware = ${config.progLanguage}
deviceId=${copyVidpid}

[filePath]
projectDir = "${config.parentPath}"
ProjectFolder = "${config.projectDir}"
deviceCodeDir = "${config.deviceCodeDir}"
virtualEnv = "${venvFolder}"
virtualPython = "${venvPython}"
`.trim();

            await fs.writeFile(deviceCfgPath, deviceCfgContent, 'utf8');

            // Create VS Code settings
            const settings = {
                "files.associations": {
                    "*.mpy": "python",
                    "*.my": "python"
                },
                "micropython-ide.deviceCodePath": "device_code",
                "micropython-ide.targetMCU": config.selectedMcuTarget,
                "python.languageServer": "Pylance",
                "python.analysis.typeCheckingMode": "basic",
                "python.analysis.typeshedPaths": [
                    path.join(venvFolder, "Lib", "site-packages")
                ],
                "python.defaultInterpreterPath": path.join(venvFolder, "Scripts", "python.exe"),
                "python.analysis.diagnosticSeverityOverrides": {
                    "reportMissingModuleSource": "none"
                },
                "files.exclude": {
                    "**/__pycache__": true,
                    "**/.mypy_cache": true
                }
            };

            await fs.writeFile(
                path.join(config.settingsDir, 'settings.json'),
                JSON.stringify(settings, null, 2)
            );

            // Store device selection in global state
            context.globalState.update('selectedMicroPythonDevice', selectedDevice);

            // Open the project folder
            await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(config.projectDir));

            vscode.window.showInformationMessage(`Project ${config.projectName} created successfully!`);
        });

    } catch (error) {
        vscode.window.showErrorMessage(`Failed to create project: ${error.message}`);
    }
}

module.exports = { creatNewProject };