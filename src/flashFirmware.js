/**
 * flashFirmware.js
 * mpflash integration — list boards, download firmware, flash devices
 * @license MIT
 * @version 1.0
 * @author  Niwantha Meepage
 */

const vscode = require('vscode');
const { exec } = require('child_process');
const { getVenvPythonPathFolder, getVenvToolPath } = require('./commonFxn');

const FIRMWARE_VERSIONS = [
    'stable',
    'preview',
    '1.25.0',
    '1.24.1',
    '1.24.0',
    '1.23.0',
    '1.22.2',
    'Enter custom version...'
];

/**
 * Run `mpflash list --json` and return an array of board objects.
 * Falls back to empty array on any error.
 */
async function listBoards(outputChannel) {
    const mpflashExe = getVenvToolPath(getVenvPythonPathFolder(), 'mpflash');

    return new Promise((resolve) => {
        exec(`"${mpflashExe}" list --json`, (error, stdout) => {
            if (error) {
                outputChannel.appendLine(`[mpflash] Board scan failed: ${error.message}`);
                resolve([]);
                return;
            }
            try {
                const parsed = JSON.parse(stdout);
                resolve(Array.isArray(parsed) ? parsed : []);
            } catch {
                outputChannel.appendLine('[mpflash] Could not parse board list JSON.');
                resolve([]);
            }
        });
    });
}

/**
 * Show a QuickPick for firmware version selection.
 * Handles "Enter custom version..." option.
 * @param {string} boardName - Board name for the placeholder label
 * @returns {Promise<string|null>}
 */
async function pickVersion(boardName) {
    const pick = await vscode.window.showQuickPick(
        FIRMWARE_VERSIONS.map(v => ({ label: v })),
        { placeHolder: `Select firmware version for ${boardName}` }
    );
    if (!pick) return null;

    if (pick.label === 'Enter custom version...') {
        return vscode.window.showInputBox({
            prompt: 'Enter firmware version',
            placeHolder: 'e.g. 1.24.0'
        });
    }

    return pick.label;
}

/**
 * Show a board selector from mpflash list results.
 * Falls back to manual text input if no boards found.
 * @returns {Promise<{port: string, board: string}|null>}
 */
async function pickBoard(boards, outputChannel) {
    if (boards.length === 0) {
        outputChannel.appendLine('No boards detected — requesting manual input.');

        const port = await vscode.window.showInputBox({
            prompt: 'Enter device port',
            placeHolder: 'e.g. COM3 or /dev/ttyUSB0'
        });
        if (!port) return null;

        const board = await vscode.window.showInputBox({
            prompt: 'Enter board name (see mpflash docs)',
            placeHolder: 'e.g. RPI_PICO, ESP32_GENERIC'
        });
        if (!board) return null;

        return { port, board };
    }

    const items = boards.map(b => ({
        label: b.serialport || b.port || 'Unknown port',
        description: b.board || b.board_id || 'Unknown board',
        detail: b.description || '',
        port: b.serialport || b.port,
        board: b.board || b.board_id
    }));

    const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select the board to flash'
    });

    return pick ? { port: pick.port, board: pick.board } : null;
}

/**
 * Full flash wizard: scan boards → pick version → confirm → flash via terminal.
 * @param {vscode.OutputChannel} outputChannel
 * @param {vscode.Terminal} terminal
 * @returns {Promise<{port: string, board: string, version: string}|null>}
 */
async function flashFirmware(outputChannel, terminal) {
    const mpflashExe = getVenvToolPath(getVenvPythonPathFolder(), 'mpflash');

    outputChannel.show(true);
    outputChannel.appendLine('── Flash Firmware ──────────────────────────────────');
    outputChannel.appendLine('Scanning for connected boards via mpflash...');

    const boards = await listBoards(outputChannel);
    const selected = await pickBoard(boards, outputChannel);
    if (!selected) return null;

    const version = await pickVersion(selected.board);
    if (!version) return null;

    const confirm = await vscode.window.showWarningMessage(
        `Flash ${selected.board} on ${selected.port} with MicroPython ${version}?\n\nThis will erase and reflash the device firmware.`,
        { modal: true },
        'Flash Now'
    );
    if (confirm !== 'Flash Now') return null;

    outputChannel.appendLine(`Flashing: ${selected.board} @ ${selected.port}  version: ${version}`);

    const cmd = [
        `"${mpflashExe}"`, 'flash',
        `--serial "${selected.port}"`,
        `--board "${selected.board}"`,
        `--version "${version}"`
    ].join(' ');

    terminal.show();
    terminal.sendText(cmd);

    return { port: selected.port, board: selected.board, version };
}

/**
 * Download firmware only (no flashing).
 * @param {vscode.OutputChannel} outputChannel
 * @param {vscode.Terminal} terminal
 */
async function downloadFirmware(outputChannel, terminal) {
    const mpflashExe = getVenvToolPath(getVenvPythonPathFolder(), 'mpflash');

    outputChannel.show(true);
    outputChannel.appendLine('── Download Firmware ───────────────────────────────');

    // Board can come from a detected device or be entered manually
    const boards = await listBoards(outputChannel);
    let selectedBoard = null;

    if (boards.length > 0) {
        const items = [
            ...boards.map(b => ({
                label: b.board || b.board_id || 'Unknown',
                description: b.serialport || b.port || '',
                board: b.board || b.board_id
            })),
            { label: '$(pencil) Enter board name manually...', board: null }
        ];
        const pick = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select board to download firmware for'
        });
        if (!pick) return;
        selectedBoard = pick.board;
    }

    if (!selectedBoard) {
        selectedBoard = await vscode.window.showInputBox({
            prompt: 'Enter board name',
            placeHolder: 'e.g. RPI_PICO, ESP32_GENERIC, ARDUINO_NANO_RP2040_CONNECT'
        });
        if (!selectedBoard) return;
    }

    const version = await pickVersion(selectedBoard);
    if (!version) return;

    const destUri = await vscode.window.showOpenDialog({
        canSelectFiles: false,
        canSelectFolders: true,
        openLabel: 'Select Download Folder'
    });
    const destDir = destUri ? destUri[0].fsPath : null;

    outputChannel.appendLine(`Downloading: ${selectedBoard}  version: ${version}${destDir ? `  → ${destDir}` : ''}`);

    const cmd = [
        `"${mpflashExe}"`, 'download',
        `--board "${selectedBoard}"`,
        `--version "${version}"`,
        destDir ? `--dir "${destDir}"` : ''
    ].filter(Boolean).join(' ');

    terminal.show();
    terminal.sendText(cmd);
}

module.exports = { flashFirmware, downloadFirmware };
