/**
 * createNewProject.js
 * Project creation wizard for MicroPython projects
 * @license MIT
 * @version 2.0
 * @author  Niwantha Meepage
 */

const vscode = require('vscode');
const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');
const { getVenvPythonPathFolder, getVenvPythonPath } = require('./commonFxn');
const {
    languageOption, mcuOptions_MP,
    rpBoards_MP, espBoards_MP, stmBoards_MP,
    samBoards_MP, nrfBoards_MP, raBoards_MP, mix_MP
} = require('./mcuOption');

/**
 * Board family to board list mapping.
 * Avoids long if-else chains.
 */
const BOARD_MAP = {
    'RP2': rpBoards_MP,
    'ESP': espBoards_MP,
    'STM': stmBoards_MP,
    'SAM': samBoards_MP,
    'NRF': nrfBoards_MP,
    'RA': raBoards_MP,
    'Any': mix_MP
};

/**
 * Build the full project configuration dictionary from user input and folder selection.
 */
async function buildProjectConfig(configDict, folderUri) {
    configDict.parentPath = folderUri[0].fsPath;
    configDict.projectDir = path.join(configDict.parentPath, configDict.projectName);
    configDict.deviceCodeDir = path.join(configDict.projectDir, 'main');
    configDict.settingsDir = path.join(configDict.projectDir, '.vscode');
    configDict.projectExists = await fs.access(configDict.projectDir).then(() => true).catch(() => false);
    return configDict;
}

/**
 * Walk the user through MCU and board selection via quick-pick dialogs.
 * @returns {Promise<object|undefined>} Config dict, or undefined if user cancelled
 */
async function selectMcuAndBoard() {
    const configDict = {};

    // 1. Project name
    const projectName = await vscode.window.showInputBox({
        prompt: 'Enter project name',
        placeHolder: 'e.g. my-micropython-project',
        validateInput: value => {
            if (!value) return 'Project name is required';
            if (/[<>:"/\\|?*]/.test(value)) return 'Project name contains invalid characters';
            return null;
        }
    });
    if (!projectName) return;
    configDict.projectName = projectName;

    // 2. Programming language
    const progLanguage = await vscode.window.showQuickPick(languageOption, {
        placeHolder: 'Select target programming language'
    });
    if (!progLanguage) return;
    configDict.progLanguage = progLanguage;

    if (progLanguage === 'CircuitPython') {
        vscode.window.showWarningMessage('CircuitPython support is coming soon!');
        return;
    }

    // 3. MCU family
    const selectedMcuFamily = await vscode.window.showQuickPick(mcuOptions_MP, {
        placeHolder: 'Select target microcontroller family'
    });
    if (!selectedMcuFamily) return;
    configDict.selectedMcuFamily = selectedMcuFamily;

    // 4. Specific board
    const boardList = BOARD_MAP[selectedMcuFamily] || mix_MP;
    const selectedMcuTarget = await vscode.window.showQuickPick(boardList, {
        placeHolder: 'Select target microcontroller'
    });
    if (!selectedMcuTarget) return;
    configDict.selectedMcuTarget = selectedMcuTarget;

    // 5. Project folder location
    const folderUri = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        openLabel: 'Select Project Folder Location'
    });
    if (!folderUri || folderUri.length === 0) return;

    return await buildProjectConfig(configDict, folderUri);
}

/**
 * Detect connected devices and let the user pick one.
 * @param {object} config - Project config dict
 * @returns {Promise<{port: string|null, vidpid: string|null}>}
 */
async function detectAndSelectDevice(config) {
    const venvFolder = getVenvPythonPathFolder();
    const venvPython = getVenvPythonPath(venvFolder);

    return new Promise((resolve) => {
        const command = `"${venvPython}" -m mpremote connect list`;

        exec(command, async (error, stdout) => {
            if (error) {
                vscode.window.showWarningMessage(
                    'Could not detect devices. You can configure the port later in device.cfg.'
                );
                resolve({ port: null, vidpid: null });
                return;
            }

            const lines = stdout.trim().split('\n').filter(Boolean);
            const devices = lines.map(line => {
                const parts = line.trim().split(/\s+/);
                const port = parts[0];
                const vidpid = parts[2] || '0000:0000';

                let mcuType = 'Unknown';
                if (vidpid === '2e8a:0005') mcuType = config.selectedMcuTarget;
                else if (vidpid.includes('10c4') || vidpid.includes('0403')) mcuType = 'ESP32';
                else if (vidpid.includes('0483')) mcuType = 'STM32';

                return { label: port, description: mcuType, vidpid };
            });

            if (devices.length === 0) {
                vscode.window.showInformationMessage(
                    'No devices detected. You can configure the port later in device.cfg.'
                );
                resolve({ port: null, vidpid: null });
                return;
            }

            const selected = await vscode.window.showQuickPick(devices, {
                placeHolder: 'Select your MicroPython device (or press Escape to skip)'
            });

            if (selected) {
                resolve({ port: selected.label, vidpid: selected.vidpid });
            } else {
                resolve({ port: null, vidpid: null });
            }
        });
    });
}

/**
 * Main entry point: create a new MicroPython project.
 * @param {vscode.ExtensionContext} context
 */
async function createNewProject(context) {
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

        // Create main.py template
        await fs.writeFile(
            path.join(config.deviceCodeDir, 'main.py'),
            `# MicroPython Project: ${config.projectName}\n` +
            `# Target: ${config.selectedMcuTarget}\n\n` +
            `print("Hello from ${config.projectName}!")\n`
        );

        // Create .mcu config file
        await fs.writeFile(
            path.join(config.deviceCodeDir, '.mcu'),
            config.selectedMcuTarget,
            'utf8'
        );

        // Create pylint configuration
        const pylintrc = [
            '# Pylint Configuration for MicroPython Project',
            '[MESSAGES CONTROL]',
            'disable=E0401,W0511,W0718,I1101,C0301,E1101,C0116',
            '',
            '[DESIGN]',
            'max-args=10',
            'max-locals=15',
            'max-returns=5',
            'max-statements=50',
            'max-line-length=120',
            '',
            '[FORMAT]',
            "indent-string='    '",
            '',
            '[REPORTS]',
            'output-format=text',
            'reports=no'
        ].join('\n');
        await fs.writeFile(path.join(config.projectDir, '.pylintrc'), pylintrc);

        // Detect connected devices
        const device = await detectAndSelectDevice(config);

        const now = new Date().toISOString();

        // Create device.cfg
        const deviceCfgContent = [
            '[device]',
            `port = ${device.port || 'NOT_SET'}`,
            `mcu = ${config.selectedMcuTarget}`,
            `sync_folder = device_code`,
            `root_folder = ${config.projectName}`,
            `project_created = ${now}`,
            `last_sync = ${now}`,
            `device_firmware = ${config.progLanguage}`,
            `deviceId = ${device.vidpid || 'undefined'}`,
            '',
            '[filePath]',
            `projectDir = "${config.parentPath}"`,
            `ProjectFolder = "${config.projectDir}"`,
            `deviceCodeDir = "${config.deviceCodeDir}"`,
            `virtualEnv = "${venvFolder}"`,
            `virtualPython = "${venvPython}"`
        ].join('\n');
        await fs.writeFile(path.join(config.projectDir, 'device.cfg'), deviceCfgContent, 'utf8');

        // Create VS Code settings.json
        const settings = {
            'files.associations': {
                '*.mpy': 'python',
                '*.my': 'python'
            },
            'micropython-ide.deviceCodePath': 'device_code',
            'micropython-ide.targetMCU': config.selectedMcuTarget,
            'python.languageServer': 'Pylance',
            'python.analysis.typeCheckingMode': 'basic',
            'python.analysis.typeshedPaths': [
                process.platform === 'win32'
                    ? path.join(venvFolder, 'Lib', 'site-packages')
                    : path.join(venvFolder, 'lib', 'python3', 'site-packages')
            ],
            'python.defaultInterpreterPath': venvPython,
            'python.analysis.diagnosticSeverityOverrides': {
                'reportMissingModuleSource': 'none'
            },
            'files.exclude': {
                '**/__pycache__': true,
                '**/.mypy_cache': true
            }
        };
        await fs.writeFile(
            path.join(config.settingsDir, 'settings.json'),
            JSON.stringify(settings, null, 2)
        );

        // Create .code-workspace file
        const workspacePath = path.join(config.parentPath, `${config.projectName}.code-workspace`);
        const workspaceContent = {
            folders: [
                {
                    path: config.projectName,
                    name: `📁 ${config.projectName} (MicroPython Studio)`
                }
            ],
            settings: {
                'micropythonStudio.project': true,
                'micropythonStudio.targetMCU': config.selectedMcuTarget,
                'micropythonStudio.language': config.progLanguage
            }
        };
        await fs.writeFile(workspacePath, JSON.stringify(workspaceContent, null, 2));

        // Store device selection in global state
        if (device.port) {
            context.globalState.update('selectedMicroPythonDevice', device.port);
        }

        // Open the workspace
        await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(workspacePath), true);
        vscode.window.showInformationMessage(`MicroPython project "${config.projectName}" created successfully!`);

    } catch (error) {
        vscode.window.showErrorMessage(`Failed to create project: ${error.message}`);
        console.error('Project creation error:', error);
    }
}

module.exports = { createNewProject };