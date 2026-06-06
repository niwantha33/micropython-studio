/**
 * espFlashTool.js
 * esptool integration — flash ESP32/ESP8266 devices using a custom Webview Panel.
 * @license MIT
 * @version 1.0
 * @author  Niwantha Meepage
 */

const vscode = require('vscode');
const { exec, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { getVenvPythonPathFolder, getVenvPythonPath } = require('./commonFxn');

let activePanel = null;
let activeProcess = null;

/**
 * Scan for connected serial ports using fast_port_scan.py.
 * @param {vscode.ExtensionContext} context
 * @returns {Promise<Array<{port: string, desc: string}>>}
 */
function scanComPorts(context) {
    return new Promise((resolve) => {
        const venvFolder = getVenvPythonPathFolder();
        const venvPython = getVenvPythonPath(venvFolder);
        const scanScript = path.join(context.extensionPath, 'src', 'fast_port_scan.py');

        if (!fs.existsSync(venvPython)) {
            resolve([]);
            return;
        }

        exec(`"${venvPython}" "${scanScript}"`, (error, stdout) => {
            if (error) {
                console.error('[ESP Flash Tool] Port scan failed:', error);
                resolve([]);
                return;
            }
            try {
                const parsed = JSON.parse(stdout);
                resolve(Array.isArray(parsed) ? parsed : []);
            } catch (e) {
                console.error('[ESP Flash Tool] Could not parse port list JSON:', e);
                resolve([]);
            }
        });
    });
}

/**
 * Open the ESP Flash Download Tool Webview Panel.
 * @param {vscode.ExtensionContext} context
 * @param {vscode.OutputChannel} outputChannel
 * @param {string|null} currentDevicePort
 */
async function openEspFlashTool(context, outputChannel, currentDevicePort) {
    if (activePanel) {
        activePanel.reveal(vscode.ViewColumn.One);
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'espFlashTool',
        'ESP Flash Download Tool (MicroPython)',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true
        }
    );

    activePanel = panel;

    // Load initial settings from globalState
    const savedRows = context.globalState.get('espFlash.rows', [
        { enabled: true, path: '', offset: '0x1000' },
        { enabled: false, path: '', offset: '0x0' },
        { enabled: false, path: '', offset: '0x8000' },
        { enabled: false, path: '', offset: '0xe000' }
    ]);
    const savedChipType = context.globalState.get('espFlash.chipType', 'esp32');
    const savedSpiSpeed = context.globalState.get('espFlash.spiSpeed', '40m');
    const savedSpiMode = context.globalState.get('espFlash.spiMode', 'dio');
    const savedFlashSize = context.globalState.get('espFlash.flashSize', 'detect');
    const savedBaudRate = context.globalState.get('espFlash.baudRate', '460800');
    const savedPort = context.globalState.get('espFlash.port', currentDevicePort || '');
    const savedAdvanced = context.globalState.get('espFlash.advanced', false);

    // Get current COM ports list
    const portsList = await scanComPorts(context);

    // Render HTML
    panel.webview.html = getWebviewContent(
        portsList,
        {
            rows: savedRows,
            chipType: savedChipType,
            spiSpeed: savedSpiSpeed,
            spiMode: savedSpiMode,
            flashSize: savedFlashSize,
            baudRate: savedBaudRate,
            port: savedPort,
            advanced: savedAdvanced
        }
    );

    // Helper functions to communicate with the webview
    function sendLog(text) {
        if (panel && panel.webview) {
            panel.webview.postMessage({ type: 'log', text });
        }
    }

    function sendProgress(percent, statusText) {
        if (panel && panel.webview) {
            panel.webview.postMessage({ type: 'progress', percent, statusText });
        }
    }

    // Message handler
    panel.webview.onDidReceiveMessage(async (message) => {
        switch (message.command) {
            case 'refreshPorts':
                const newPorts = await scanComPorts(context);
                panel.webview.postMessage({ type: 'portsUpdated', ports: newPorts });
                break;

            case 'browseFile':
                const uris = await vscode.window.showOpenDialog({
                    canSelectFiles: true,
                    canSelectFolders: false,
                    canSelectMany: false,
                    filters: {
                        'Binary Files': ['bin'],
                        'All Files': ['*']
                    },
                    openLabel: 'Select Firmware Binary'
                });
                if (uris && uris.length > 0) {
                    panel.webview.postMessage({
                        type: 'fileSelected',
                        rowIndex: message.rowIndex,
                        filePath: uris[0].fsPath
                    });
                }
                break;

            case 'saveSettings':
                // Persist user configuration changes
                context.globalState.update('espFlash.rows', message.settings.rows);
                context.globalState.update('espFlash.chipType', message.settings.chipType);
                context.globalState.update('espFlash.spiSpeed', message.settings.spiSpeed);
                context.globalState.update('espFlash.spiMode', message.settings.spiMode);
                context.globalState.update('espFlash.flashSize', message.settings.flashSize);
                context.globalState.update('espFlash.baudRate', message.settings.baudRate);
                context.globalState.update('espFlash.port', message.settings.port);
                context.globalState.update('espFlash.advanced', message.settings.advanced);
                break;

            case 'startFlash':
                runEsptool(message.settings, 'flash');
                break;

            case 'eraseFlash':
                const confirm = await vscode.window.showWarningMessage(
                    `Erase flash on device at ${message.settings.port}? This will erase all firmware and files on the chip.`,
                    { modal: true },
                    'Erase Now'
                );
                if (confirm === 'Erase Now') {
                    runEsptool(message.settings, 'erase');
                }
                break;

            case 'stopProcess':
                if (activeProcess) {
                    sendLog('\n[ABORTED] Stopping flashing process...\n');
                    activeProcess.kill('SIGINT');
                    setTimeout(() => {
                        if (activeProcess) {
                            activeProcess.kill('SIGKILL');
                        }
                    }, 1000);
                }
                break;
        }
    });

    panel.onDidDispose(() => {
        if (activeProcess) {
            activeProcess.kill();
            activeProcess = null;
        }
        activePanel = null;
    });

    /**
     * Run esptool child process.
     */
    function runEsptool(settings, action) {
        if (activeProcess) {
            vscode.window.showWarningMessage('A flashing or erasing operation is already in progress.');
            return;
        }

        const venvFolder = getVenvPythonPathFolder();
        const venvPython = getVenvPythonPath(venvFolder);

        if (!fs.existsSync(venvPython)) {
            sendLog('[ERROR] Python virtual environment executable not found. Please run "Setup Environment" first.\n');
            sendProgress(0, 'Failed');
            return;
        }

        const args = ['-m', 'esptool'];

        // Add serial port connection parameters
        if (settings.port) {
            args.push('--port', settings.port);
        } else {
            sendLog('[ERROR] No COM Port selected. Please select a valid COM port.\n');
            sendProgress(0, 'Failed');
            return;
        }

        if (settings.baudRate) {
            args.push('--baud', settings.baudRate);
        }

        if (action === 'erase') {
            args.push('erase_flash');
            sendLog(`Executing: python -m esptool --port ${settings.port} erase_flash\n`);
            sendProgress(0, 'Erasing flash...');
        } else {
            // Flashing logic
            if (settings.chipType) {
                args.push('--chip', settings.chipType);
            }

            args.push('write_flash', '-z');

            if (settings.advanced) {
                if (settings.spiMode) {
                    args.push('--flash_mode', settings.spiMode);
                }
                if (settings.spiSpeed) {
                    args.push('--flash_freq', settings.spiSpeed);
                }
                if (settings.flashSize && settings.flashSize !== 'detect') {
                    args.push('--flash_size', settings.flashSize);
                } else {
                    args.push('--flash_size', 'detect');
                }
            } else {
                // In simple mode, default to detect/auto parameters
                args.push('--flash_size', 'detect');
            }

            // Parse rows of binaries
            let filesAdded = 0;
            const logDetails = [];
            
            if (settings.advanced) {
                // Advanced mode: parse all enabled rows
                for (const row of settings.rows) {
                    if (row.enabled && row.path.trim()) {
                        args.push(row.offset.trim(), row.path.trim());
                        logDetails.push(`${row.offset} -> ${path.basename(row.path)}`);
                        filesAdded++;
                    }
                }
            } else {
                // Simple mode: just write row 0 (MicroPython binary) at offset-0 (auto-determined address)
                const mainRow = settings.rows[0];
                if (mainRow && mainRow.path.trim()) {
                    args.push(mainRow.offset.trim(), mainRow.path.trim());
                    logDetails.push(`${mainRow.offset} -> ${path.basename(mainRow.path)}`);
                    filesAdded++;
                }
            }

            if (filesAdded === 0) {
                sendLog('[ERROR] No binary files enabled or selected. Check at least one row and select a .bin file.\n');
                sendProgress(0, 'Failed');
                return;
            }

            sendLog(`Executing: python -m esptool write_flash ${logDetails.join(', ')}\n`);
            sendProgress(0, 'Connecting...');
        }

        panel.webview.postMessage({ type: 'processState', running: true });

        activeProcess = spawn(venvPython, args);

        activeProcess.stdout.on('data', (data) => {
            const output = data.toString();
            sendLog(output);

            // Parse progress percentage (e.g. "(12 %)" or "Writing at 0x00004000... (32 %)")
            const match = output.match(/(\d+)\s*%/);
            if (match) {
                const percent = parseInt(match[1], 10);
                sendProgress(percent, `Writing... ${percent}%`);
            }
        });

        activeProcess.stderr.on('data', (data) => {
            sendLog(data.toString());
        });

        activeProcess.on('close', (code) => {
            panel.webview.postMessage({ type: 'processState', running: false });
            activeProcess = null;

            if (code === 0) {
                sendProgress(100, action === 'erase' ? 'Erase Complete' : 'Flash Complete');
                sendLog(action === 'erase' ? '\n[SUCCESS] Flash erased successfully!\n' : '\n[SUCCESS] MicroPython firmware flashed successfully!\n');
            } else {
                sendProgress(0, 'Failed');
                sendLog(`\n[ERROR] esptool exited with code ${code}\n`);
            }
        });

        activeProcess.on('error', (err) => {
            panel.webview.postMessage({ type: 'processState', running: false });
            activeProcess = null;
            sendProgress(0, 'Error');
            sendLog(`\n[ERROR] Failed to start esptool subprocess: ${err.message}\n`);
        });
    }
}

/**
 * Return Webview HTML content.
 */
function getWebviewContent(ports, initialSettings) {
    // Generate COM ports options HTML
    const portOptions = ports.map(p => {
        const isSelected = p.port === initialSettings.port ? 'selected' : '';
        const displayLabel = p.vendor ? `${p.port} (${p.vendor})` : `${p.port} - ${p.desc}`;
        return `<option value="${p.port}" ${isSelected}>${displayLabel}</option>`;
    }).join('');

    // Fallback if no ports found
    const finalPortOptions = portOptions || (initialSettings.port ? `<option value="${initialSettings.port}" selected>${initialSettings.port}</option>` : '<option value="">No ports detected</option>');

    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ESP Flash Download Tool</title>
    <style>
        :root {
            --bg-primary: #0a0b10;
            --bg-secondary: #131520;
            --bg-card: rgba(30, 32, 50, 0.6);
            --border-color: rgba(255, 255, 255, 0.08);
            --text-main: #e2e8f0;
            --text-secondary: #94a3b8;
            
            --accent-cyan: #06b6d4;
            --accent-cyan-hover: #0891b2;
            
            --accent-purple: #7c3aed;
            --accent-purple-hover: #6d28d9;
            --accent-purple-glow: rgba(124, 58, 237, 0.3);

            --accent-yellow: #eab308;
            --accent-yellow-hover: #ca8a04;

            --accent-red: #ef4444;
            --accent-red-hover: #dc2626;

            --accent-green: #10b981;
        }

        body {
            background-color: var(--bg-primary);
            color: var(--text-main);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            margin: 0;
            padding: 20px;
            box-sizing: border-box;
        }

        .header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-bottom: 20px;
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 12px;
        }

        .header h1 {
            font-size: 1.25rem;
            font-weight: 700;
            margin: 0;
            background: linear-gradient(135deg, #a78bfa 0%, #06b6d4 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        .header-subtitle {
            font-size: 0.8rem;
            color: var(--text-secondary);
        }

        .container {
            display: grid;
            grid-template-columns: 1fr;
            gap: 20px;
            max-width: 900px;
            margin: 0 auto;
        }

        @media (min-width: 768px) {
            .container {
                grid-template-columns: 3fr 2fr;
            }
            .full-width {
                grid-column: span 2;
            }
        }

        .card {
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 12px;
            padding: 16px;
            backdrop-filter: blur(12px);
            box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
            transition: all 0.3s ease;
        }

        .card h2 {
            font-size: 0.95rem;
            font-weight: 600;
            margin-top: 0;
            margin-bottom: 14px;
            color: var(--text-main);
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .card h2 svg {
            color: var(--accent-cyan);
        }

        /* Rows Table styling */
        .binary-row-grid {
            display: flex;
            flex-direction: column;
            gap: 10px;
        }

        .binary-row {
            display: grid;
            grid-template-columns: auto 1fr auto auto;
            align-items: center;
            gap: 8px;
        }

        .binary-row.simple-view {
            grid-template-columns: 1fr auto;
        }

        .binary-row input[type="checkbox"] {
            width: 18px;
            height: 18px;
            cursor: pointer;
            accent-color: var(--accent-purple);
        }

        .binary-row input[type="text"].file-path {
            background: rgba(15, 16, 26, 0.8);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            color: #fff;
            padding: 8px 10px;
            font-size: 0.8rem;
            outline: none;
            transition: border-color 0.2s;
        }

        .binary-row input[type="text"].file-path:focus {
            border-color: var(--accent-purple);
        }

        .binary-row input[type="text"].offset {
            width: 80px;
            background: rgba(15, 16, 26, 0.8);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            color: #fff;
            padding: 8px 10px;
            font-size: 0.8rem;
            font-family: 'JetBrains Mono', Consolas, monospace;
            text-align: center;
            outline: none;
            transition: border-color 0.2s;
        }

        .binary-row input[type="text"].offset:focus {
            border-color: var(--accent-purple);
        }

        .btn {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid var(--border-color);
            color: var(--text-main);
            padding: 8px 12px;
            border-radius: 6px;
            font-size: 0.8rem;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 6px;
            transition: all 0.2s;
        }

        .btn:hover {
            background: rgba(255, 255, 255, 0.1);
            border-color: rgba(255, 255, 255, 0.2);
        }

        .btn-primary {
            background: linear-gradient(135deg, var(--accent-purple) 0%, #4f46e5 100%);
            border: none;
            color: #fff;
            font-weight: 600;
            box-shadow: 0 4px 12px var(--accent-purple-glow);
        }

        .btn-primary:hover {
            opacity: 0.95;
            transform: translateY(-1px);
        }

        .btn-primary:active {
            transform: translateY(0);
        }

        .btn-danger {
            background: linear-gradient(135deg, var(--accent-red) 0%, #b91c1c 100%);
            border: none;
            color: #fff;
            font-weight: 600;
        }

        .btn-danger:hover {
            opacity: 0.95;
            transform: translateY(-1px);
        }

        .btn-danger:disabled {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid var(--border-color);
            color: var(--text-secondary);
            cursor: not-allowed;
            transform: none;
            box-shadow: none;
            opacity: 0.5;
        }

        .btn-warning {
            background: linear-gradient(135deg, var(--accent-yellow) 0%, var(--accent-yellow-hover) 100%);
            border: none;
            color: #000;
            font-weight: 600;
        }

        .btn-warning:hover {
            opacity: 0.95;
            transform: translateY(-1px);
        }

        /* Form Grid styling */
        .form-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
        }

        .form-item {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        .form-item label {
            font-size: 0.75rem;
            color: var(--text-secondary);
            font-weight: 500;
        }

        .form-item select, .form-item input {
            background: rgba(15, 16, 26, 0.8);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            color: #fff;
            padding: 8px 10px;
            font-size: 0.8rem;
            outline: none;
            width: 100%;
            box-sizing: border-box;
        }

        .form-item select:focus, .form-item input:focus {
            border-color: var(--accent-purple);
        }

        .select-row {
            display: flex;
            gap: 8px;
            align-items: center;
        }

        /* Console Output styling */
        .console-wrap {
            margin-top: 14px;
        }

        .console-container {
            background-color: #07080d;
            border: 1px solid var(--border-color);
            border-radius: 8px;
            padding: 12px;
            height: 180px;
            overflow-y: auto;
            font-family: 'JetBrains Mono', 'Fira Code', Consolas, monospace;
            font-size: 0.75rem;
            color: #a6adbb;
            white-space: pre-wrap;
            line-height: 1.4;
        }

        /* Progress Bar styling */
        .progress-section {
            margin-top: 14px;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        .progress-header {
            display: flex;
            justify-content: space-between;
            font-size: 0.75rem;
            font-weight: 600;
        }

        .progress-bar-bg {
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid var(--border-color);
            border-radius: 8px;
            height: 12px;
            overflow: hidden;
            position: relative;
        }

        .progress-bar-fill {
            background: linear-gradient(90deg, var(--accent-cyan) 0%, var(--accent-purple) 100%);
            width: 0%;
            height: 100%;
            border-radius: 8px;
            transition: width 0.3s ease;
            box-shadow: 0 0 10px rgba(6, 182, 212, 0.5);
        }

        .actions-bar {
            display: flex;
            justify-content: flex-end;
            gap: 10px;
            margin-top: 20px;
            border-top: 1px solid var(--border-color);
            padding-top: 14px;
        }

        .checkbox-container {
            display: flex;
            align-items: center;
            gap: 6px;
            font-size: 0.75rem;
            color: var(--text-secondary);
        }

        /* Spinner */
        .spinner {
            border: 2px solid rgba(255,255,255,0.1);
            border-top-color: var(--accent-cyan);
            border-radius: 50%;
            width: 14px;
            height: 14px;
            animation: spin 0.8s linear infinite;
            display: inline-block;
        }

        @keyframes spin {
            to { transform: rotate(360deg); }
        }

        /* Advanced elements styling */
        .advanced-only {
            transition: all 0.3s ease;
        }

        .hidden-advanced {
            display: none !important;
        }
    </style>
</head>
<body>

    <header class="header">
        <div>
            <h1>ESP Flash Download Tool</h1>
            <div class="header-subtitle">Write MicroPython firmware and binaries using esptool</div>
        </div>
        <div class="checkbox-container">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 0.85rem; user-select: none;">
                <input type="checkbox" id="advanced-toggle" ${initialSettings.advanced ? 'checked' : ''} onchange="toggleAdvancedMode()" style="width: 16px; height: 16px; accent-color: var(--accent-purple); cursor: pointer;">
                Advanced Mode
            </label>
        </div>
    </header>

    <div class="container">
        <!-- Binary Files table -->
        <div class="card full-width">
            <h2>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="9" y1="3" x2="9" y2="21"/><line x1="15" y1="3" x2="15" y2="21"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/></svg>
                Download Path Config
            </h2>
            <div class="binary-row-grid">
                <!-- Row 1 -->
                <div class="binary-row ${initialSettings.advanced ? '' : 'simple-view'}" id="row-wrap-0">
                    <input type="checkbox" id="check-0" class="advanced-only ${initialSettings.advanced ? '' : 'hidden-advanced'}" ${initialSettings.rows[0].enabled ? 'checked' : ''} onchange="saveConfig()">
                    <input type="text" class="file-path" id="path-0" value="${initialSettings.rows[0].path}" placeholder="Select MicroPython bin file..." onchange="saveConfig()">
                    <button class="btn btn-sm" onclick="browseFile(0)">Browse...</button>
                    <input type="text" class="offset advanced-only ${initialSettings.advanced ? '' : 'hidden-advanced'}" id="offset-0" value="${initialSettings.rows[0].offset}" placeholder="0x1000" onchange="saveConfig()">
                </div>
                <!-- Row 2 -->
                <div class="binary-row advanced-only ${initialSettings.advanced ? '' : 'hidden-advanced'}" id="row-wrap-1">
                    <input type="checkbox" id="check-1" ${initialSettings.rows[1].enabled ? 'checked' : ''} onchange="saveConfig()">
                    <input type="text" class="file-path" id="path-1" value="${initialSettings.rows[1].path}" placeholder="Additional binary (e.g. bootloader)..." onchange="saveConfig()">
                    <button class="btn btn-sm" onclick="browseFile(1)">Browse...</button>
                    <input type="text" class="offset" id="offset-1" value="${initialSettings.rows[1].offset}" placeholder="0x0" onchange="saveConfig()">
                </div>
                <!-- Row 3 -->
                <div class="binary-row advanced-only ${initialSettings.advanced ? '' : 'hidden-advanced'}" id="row-wrap-2">
                    <input type="checkbox" id="check-2" ${initialSettings.rows[2].enabled ? 'checked' : ''} onchange="saveConfig()">
                    <input type="text" class="file-path" id="path-2" value="${initialSettings.rows[2].path}" placeholder="Additional binary (e.g. partitions)..." onchange="saveConfig()">
                    <button class="btn btn-sm" onclick="browseFile(2)">Browse...</button>
                    <input type="text" class="offset" id="offset-2" value="${initialSettings.rows[2].offset}" placeholder="0x8000" onchange="saveConfig()">
                </div>
                <!-- Row 4 -->
                <div class="binary-row advanced-only ${initialSettings.advanced ? '' : 'hidden-advanced'}" id="row-wrap-3">
                    <input type="checkbox" id="check-3" ${initialSettings.rows[3].enabled ? 'checked' : ''} onchange="saveConfig()">
                    <input type="text" class="file-path" id="path-3" value="${initialSettings.rows[3].path}" placeholder="Additional binary (e.g. ota)..." onchange="saveConfig()">
                    <button class="btn btn-sm" onclick="browseFile(3)">Browse...</button>
                    <input type="text" class="offset" id="offset-3" value="${initialSettings.rows[3].offset}" placeholder="0xe000" onchange="saveConfig()">
                </div>
            </div>
        </div>

        <!-- Port, Chip & Speed Config -->
        <div class="card">
            <h2>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/><path d="M12 6v6l4 2"/></svg>
                Device &amp; Port Config
            </h2>
            <div class="form-grid">
                <div class="form-item" style="grid-column: span 2;">
                    <label for="chip-type">Chip Type</label>
                    <select id="chip-type" onchange="onChipTypeChange()">
                        <option value="esp32" ${initialSettings.chipType === 'esp32' ? 'selected' : ''}>ESP32</option>
                        <option value="esp32s2" ${initialSettings.chipType === 'esp32s2' ? 'selected' : ''}>ESP32-S2</option>
                        <option value="esp32s3" ${initialSettings.chipType === 'esp32s3' ? 'selected' : ''}>ESP32-S3</option>
                        <option value="esp32c3" ${initialSettings.chipType === 'esp32c3' ? 'selected' : ''}>ESP32-C3</option>
                        <option value="esp32c6" ${initialSettings.chipType === 'esp32c6' ? 'selected' : ''}>ESP32-C6</option>
                        <option value="esp32c2" ${initialSettings.chipType === 'esp32c2' ? 'selected' : ''}>ESP32-C2</option>
                        <option value="esp32c5" ${initialSettings.chipType === 'esp32c5' ? 'selected' : ''}>ESP32-C5</option>
                        <option value="esp32p4" ${initialSettings.chipType === 'esp32p4' ? 'selected' : ''}>ESP32-P4</option>
                        <option value="esp32h2" ${initialSettings.chipType === 'esp32h2' ? 'selected' : ''}>ESP32-H2</option>
                        <option value="esp8266" ${initialSettings.chipType === 'esp8826' ? 'selected' : ''}>ESP8266</option>
                    </select>
                </div>
                <div class="form-item">
                    <label for="com-port">COM Port</label>
                    <div class="select-row">
                        <select id="com-port" onchange="saveConfig()">
                            ${finalPortOptions}
                        </select>
                        <button class="btn" onclick="refreshPorts()" title="Rescan Ports">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>
                        </button>
                    </div>
                </div>
                <div class="form-item">
                    <label for="baud-rate">Baud Rate</label>
                    <select id="baud-rate" onchange="saveConfig()">
                        <option value="115200" ${initialSettings.baudRate === '115200' ? 'selected' : ''}>115200</option>
                        <option value="230400" ${initialSettings.baudRate === '230400' ? 'selected' : ''}>230400</option>
                        <option value="460800" ${initialSettings.baudRate === '460800' ? 'selected' : ''}>460800</option>
                        <option value="921600" ${initialSettings.baudRate === '921600' ? 'selected' : ''}>921600</option>
                        <option value="1500000" ${initialSettings.baudRate === '1500000' ? 'selected' : ''}>1500000</option>
                        <option value="2000000" ${initialSettings.baudRate === '2000000' ? 'selected' : ''}>2000000</option>
                    </select>
                </div>
            </div>
        </div>

        <!-- SPI Configuration (Advanced Only) -->
        <div class="card advanced-only ${initialSettings.advanced ? '' : 'hidden-advanced'}">
            <h2>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="2" y="2" width="20" height="8" rx="2" ry="2"/><rect x="2" y="14" width="20" height="8" rx="2" ry="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/></svg>
                SPI Flash Config
            </h2>
            <div class="form-grid">
                <div class="form-item" style="grid-column: span 2;">
                    <label for="flash-size">Flash Size</label>
                    <select id="flash-size" onchange="saveConfig()">
                        <option value="detect" ${initialSettings.flashSize === 'detect' ? 'selected' : ''}>Detect automatically</option>
                        <option value="1MB" ${initialSettings.flashSize === '1MB' ? 'selected' : ''}>1 MB</option>
                        <option value="2MB" ${initialSettings.flashSize === '2MB' ? 'selected' : ''}>2 MB</option>
                        <option value="4MB" ${initialSettings.flashSize === '4MB' ? 'selected' : ''}>4 MB</option>
                        <option value="8MB" ${initialSettings.flashSize === '8MB' ? 'selected' : ''}>8 MB</option>
                        <option value="16MB" ${initialSettings.flashSize === '16MB' ? 'selected' : ''}>16 MB</option>
                        <option value="32MB" ${initialSettings.flashSize === '32MB' ? 'selected' : ''}>32 MB</option>
                    </select>
                </div>
                <div class="form-item">
                    <label for="spi-speed">SPI Speed</label>
                    <select id="spi-speed" onchange="saveConfig()">
                        <option value="40m" ${initialSettings.spiSpeed === '40m' ? 'selected' : ''}>40 MHz</option>
                        <option value="26m" ${initialSettings.spiSpeed === '26m' ? 'selected' : ''}>26 MHz</option>
                        <option value="20m" ${initialSettings.spiSpeed === '20m' ? 'selected' : ''}>20 MHz</option>
                        <option value="80m" ${initialSettings.spiSpeed === '80m' ? 'selected' : ''}>80 MHz</option>
                    </select>
                </div>
                <div class="form-item">
                    <label for="spi-mode">SPI Mode</label>
                    <select id="spi-mode" onchange="saveConfig()">
                        <option value="dio" ${initialSettings.spiMode === 'dio' ? 'selected' : ''}>DIO</option>
                        <option value="dout" ${initialSettings.spiMode === 'dout' ? 'selected' : ''}>DOUT</option>
                        <option value="qio" ${initialSettings.spiMode === 'qio' ? 'selected' : ''}>QIO</option>
                        <option value="qout" ${initialSettings.spiMode === 'qout' ? 'selected' : ''}>QOUT</option>
                    </select>
                </div>
            </div>
        </div>

        <!-- Progress and Console Logs -->
        <div class="card full-width">
            <h2>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                Flashing Output &amp; Status
            </h2>
            <div class="progress-section">
                <div class="progress-header">
                    <span id="progress-status">Idle</span>
                    <span id="progress-percent">0%</span>
                </div>
                <div class="progress-bar-bg">
                    <div class="progress-bar-fill" id="progress-bar"></div>
                </div>
            </div>
            <div class="console-wrap">
                <div class="console-container" id="console-output">ESP Flash Download Tool initialized. Ready to flash...</div>
            </div>
            
            <div class="actions-bar">
                <button class="btn btn-warning" id="btn-erase" onclick="eraseFlash()">Erase Flash</button>
                <button class="btn btn-danger" id="btn-stop" onclick="stopProcess()" disabled>STOP</button>
                <button class="btn btn-primary" id="btn-start" onclick="startFlash()">START</button>
            </div>
        </div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();

        function getConfig() {
            return {
                rows: [
                    {
                        enabled: document.getElementById('check-0').checked,
                        path: document.getElementById('path-0').value,
                        offset: document.getElementById('offset-0').value
                    },
                    {
                        enabled: document.getElementById('check-1').checked,
                        path: document.getElementById('path-1').value,
                        offset: document.getElementById('offset-1').value
                    },
                    {
                        enabled: document.getElementById('check-2').checked,
                        path: document.getElementById('path-2').value,
                        offset: document.getElementById('offset-2').value
                    },
                    {
                        enabled: document.getElementById('check-3').checked,
                        path: document.getElementById('path-3').value,
                        offset: document.getElementById('offset-3').value
                    }
                ],
                chipType: document.getElementById('chip-type').value,
                flashSize: document.getElementById('flash-size').value,
                spiSpeed: document.getElementById('spi-speed').value,
                spiMode: document.getElementById('spi-mode').value,
                port: document.getElementById('com-port').value,
                baudRate: document.getElementById('baud-rate').value,
                advanced: document.getElementById('advanced-toggle').checked
            };
        }

        function saveConfig() {
            const settings = getConfig();
            vscode.postMessage({
                command: 'saveSettings',
                settings: settings
            });
        }

        function browseFile(rowIndex) {
            vscode.postMessage({
                command: 'browseFile',
                rowIndex: rowIndex
            });
        }

        function refreshPorts() {
            const btn = document.querySelector('button[onclick="refreshPorts()"]');
            btn.innerHTML = '<span class="spinner"></span>';
            btn.disabled = true;
            vscode.postMessage({ command: 'refreshPorts' });
        }

        function startFlash() {
            clearConsole();
            saveConfig();
            vscode.postMessage({
                command: 'startFlash',
                settings: getConfig()
            });
        }

        function eraseFlash() {
            clearConsole();
            saveConfig();
            vscode.postMessage({
                command: 'eraseFlash',
                settings: getConfig()
            });
        }

        function stopProcess() {
            vscode.postMessage({ command: 'stopProcess' });
        }

        function clearConsole() {
            document.getElementById('console-output').textContent = '';
        }

        function appendToConsole(text) {
            const consoleEl = document.getElementById('console-output');
            consoleEl.textContent += text;
            consoleEl.scrollTop = consoleEl.scrollHeight;
        }

        function onChipTypeChange() {
            const chip = document.getElementById('chip-type').value;
            const offsetInput = document.getElementById('offset-0');
            const currentOffset = offsetInput.value.trim();
            const standardOffsets = ['', '0x0', '0x1000', '0x2000'];

            if (standardOffsets.includes(currentOffset)) {
                if (chip === 'esp32' || chip === 'esp32s2') {
                    offsetInput.value = '0x1000';
                } else if (chip === 'esp32p4' || chip === 'esp32c5') {
                    offsetInput.value = '0x2000';
                } else {
                    // esp32s3, esp32c3, esp32c6, esp32c2, esp32h2, esp8266
                    offsetInput.value = '0x0';
                }
            }
            saveConfig();
        }

        function toggleAdvancedMode() {
            const isAdvanced = document.getElementById('advanced-toggle').checked;
            
            // Toggle visibility of advanced elements
            const advElements = document.querySelectorAll('.advanced-only');
            advElements.forEach(el => {
                if (isAdvanced) {
                    el.classList.remove('hidden-advanced');
                } else {
                    el.classList.add('hidden-advanced');
                }
            });

            // Adjust the grid layout for row 0
            const row0 = document.getElementById('row-wrap-0');
            if (isAdvanced) {
                row0.classList.remove('simple-view');
            } else {
                row0.classList.add('simple-view');
            }
            
            saveConfig();
        }

        // Receive messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.type) {
                case 'portsUpdated':
                    const btn = document.querySelector('button[onclick="refreshPorts()"]');
                    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>';
                    btn.disabled = false;
                    
                    const select = document.getElementById('com-port');
                    const currentVal = select.value;
                    select.innerHTML = '';
                    
                    if (message.ports.length === 0) {
                        select.innerHTML = '<option value="">No ports detected</option>';
                    } else {
                        message.ports.forEach(p => {
                            const option = document.createElement('option');
                            option.value = p.port;
                            option.textContent = p.vendor ? (p.port + ' (' + p.vendor + ')') : (p.port + ' - ' + p.desc);
                            if (p.port === currentVal) {
                                option.selected = true;
                            }
                            select.appendChild(option);
                        });
                    }
                    saveConfig();
                    break;

                case 'fileSelected':
                    document.getElementById('path-' + message.rowIndex).value = message.filePath;
                    document.getElementById('check-' + message.rowIndex).checked = true;
                    saveConfig();
                    break;

                case 'log':
                    appendToConsole(message.text);
                    break;

                case 'progress':
                    document.getElementById('progress-bar').style.width = message.percent + '%';
                    document.getElementById('progress-percent').textContent = message.percent + '%';
                    document.getElementById('progress-status').textContent = message.statusText;
                    break;

                case 'processState':
                    document.getElementById('btn-start').disabled = message.running;
                    document.getElementById('btn-erase').disabled = message.running;
                    document.getElementById('btn-stop').disabled = !message.running;
                    
                    document.querySelectorAll('.binary-row input, .binary-row button, select').forEach(el => {
                        // Skip the abort button
                        if (el.id !== 'btn-stop') {
                            el.disabled = message.running;
                        }
                    });
                    break;
            }
        });
    </script>
</body>
</html>`;
}

module.exports = { openEspFlashTool };
