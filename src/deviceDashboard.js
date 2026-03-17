const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { runMpremote } = require('./runCommand');

/**
 * Gathers all metrics from the device and converts them to a structured object.
 * We write a temporary python script locally and run it on the board to avoid
 * complex shell quote escaping issues with `mpremote exec`.
 */
async function gatherDeviceMetrics(outputChannel, workspaceFolder) {
    const metrics = {
        firmware: 'Unknown',
        platform: 'Unknown',
        version: 'Unknown',
        cpuFreqHtml: 'Unknown',
        ramUsed: 0,
        ramFree: 0,
        ramTotal: 0,
        flashUsed: 0,
        flashFree: 0,
        flashTotal: 0
    };

    // The single python script to fetch all metrics at once
    const pythonScript = `import sys, machine, gc, os

# 1. Firmware
print("---SYS---")
print(sys.platform)
print('.'.join(map(str, sys.implementation.version)))
print(machine.freq() if hasattr(machine, 'freq') else 0)

# 2. RAM
print("---RAM---")
gc.collect()
print(gc.mem_alloc())
print(gc.mem_free())

# 3. Flash
print("---FLASH---")
try:
    s=os.statvfs('/')
    print(s[0]*s[2])
    print(s[0]*s[3])
except Exception:
    print(0)
    print(0)
`;

    // Save script locally to a safe temp spot in the workspace
    const tempScriptPath = path.join(workspaceFolder, '.dashboard_metrics.py');
    try {
        fs.writeFileSync(tempScriptPath, pythonScript, 'utf8');

        // Run the script on the device
        const rawOutput = await runMpremote(outputChannel, ['run', `"${tempScriptPath}"`]);
        
        // Parse the block output
        const lines = rawOutput.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        
        let currentSection = '';
        let sysLines = [];
        let ramLines = [];
        let flashLines = [];

        for (const line of lines) {
            if (line === '---SYS---') { currentSection = 'SYS'; continue; }
            if (line === '---RAM---') { currentSection = 'RAM'; continue; }
            if (line === '---FLASH---') { currentSection = 'FLASH'; continue; }

            if (currentSection === 'SYS') sysLines.push(line);
            else if (currentSection === 'RAM') ramLines.push(line);
            else if (currentSection === 'FLASH') flashLines.push(line);
        }

        // Apply SYS metrics
        if (sysLines.length >= 3) {
            metrics.platform = sysLines[0];
            metrics.firmware = 'MicroPython'; // Always MicroPython in this extension
            metrics.version = sysLines[1];
            const freqHz = parseInt(sysLines[2], 10);
            metrics.cpuFreqHtml = freqHz > 0 ? `${(freqHz / 1000000).toFixed(0)} <span class="unit">MHz</span>` : 'Unknown';
        }

        // Apply RAM metrics
        if (ramLines.length >= 2) {
            metrics.ramUsed = parseInt(ramLines[0], 10) || 0;
            metrics.ramFree = parseInt(ramLines[1], 10) || 0;
            metrics.ramTotal = metrics.ramUsed + metrics.ramFree;
        }

        // Apply Flash metrics
        if (flashLines.length >= 2) {
            metrics.flashTotal = parseInt(flashLines[0], 10) || 0;
            metrics.flashFree = parseInt(flashLines[1], 10) || 0;
            metrics.flashUsed = metrics.flashTotal - metrics.flashFree;
        }

    } catch (err) {
        console.error('Failed to gather metrics:', err);
    } finally {
        if (fs.existsSync(tempScriptPath)) {
            fs.unlinkSync(tempScriptPath);
        }
    }

    return metrics;
}

/**
 * Format bytes to readable strings like "145 KB" or "2.1 MB"
 */
function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' <span class="unit">' + sizes[i] + '</span>';
}

/**
 * Creates the sleek SVG Donut Chart HTML
 */
function createDonutChart(used, total) {
    if (total === 0) return `<div class="donut-fallback">N/A</div>`;
    
    // Calculate SVG Stroke Dash Array for the circle percentage
    const percentage = Math.round((used / total) * 100);
    const radius = 50;
    const circumference = 2 * Math.PI * radius;
    const strokeDasharray = `${(percentage / 100) * circumference} ${circumference}`;

    // Color logic (green -> yellow -> red based on usage)
    let color = '#10b981'; // green
    if (percentage > 70) color = '#f59e0b'; // yellow
    if (percentage > 90) color = '#ef4444'; // red

    return `
        <div class="chart-container">
            <svg width="140" height="140" viewBox="0 0 120 120">
                <circle class="donut-bg" cx="60" cy="60" r="${radius}" fill="none" stroke="#2d2d3d" stroke-width="12"></circle>
                <circle class="donut-segment" cx="60" cy="60" r="${radius}" fill="none" stroke="${color}" stroke-width="12"
                    stroke-dasharray="${strokeDasharray}" stroke-linecap="round" transform="rotate(-90 60 60)"></circle>
            </svg>
            <div class="donut-text">
                <span class="pct">${percentage}%</span>
                <span class="label">Used</span>
            </div>
            <div class="chart-stats">
                <div class="stat-line"><div class="dot used"></div> Used: ${formatBytes(used)}</div>
                <div class="stat-line"><div class="dot free"></div> Free: ${formatBytes(total - used)}</div>
            </div>
        </div>
    `;
}

/**
 * Known Board Pinouts for the interactive diagram
 */
const PINOUT_DATA = {
    'rp2': {
        name: 'Raspberry Pi Pico (RP2040)',
        left: ['GP0', 'GP1', 'GND', 'GP2', 'GP3', 'GP4', 'GP5', 'GND', 'GP6', 'GP7', 'GP8', 'GP9', 'GND', 'GP10', 'GP11', 'GP12', 'GP13', 'GND', 'GP14', 'GP15'],
        right: ['VBUS', 'VSYS', 'GND', '3V3_EN', '3V3', 'ADC_VREF', 'GP28_A2', 'GND', 'GP27_A1', 'GP26_A0', 'RUN', 'GP22', 'GND', 'GP21', 'GP20', 'GP19', 'GP18', 'GND', 'GP17', 'GP16']
    },
    'esp32': {
        name: 'ESP32 (Standard 30-Pin)',
        left: ['3V3', 'EN', 'VP_36', 'VN_39', '34', '35', '32', '33', '25', '26', '27', '14', '12', '13', 'GND'],
        right: ['VIN', 'GND', '23', '22', 'TX_1', 'RX_3', '21', '19', '18', '5', '17', '16', '4', '0', '2', '15']
    },
    'esp8266': {
        name: 'ESP8266 (NodeMCU)',
        left: ['A0', 'ADC', 'RSV', 'RSV', 'D0(16)', 'D1(5)', 'D2(4)', 'D3(0)', 'D4(2)', '3V3', 'GND', 'D5(14)', 'D6(12)', 'D7(13)', 'D8(15)'],
        right: ['3V3', 'EN', 'RST', 'GND', 'VIN', '3V3', 'GND', 'TX', 'RX', 'D9(3)', 'D10(1)', 'GND', '3V3', 'RSV', 'RSV']
    }
};

/**
 * Get Color class for pin based on its name
 */
function getPinClass(pinName) {
    const p = pinName.toUpperCase();
    if (p.includes('GND')) return 'gnd';
    if (p.includes('3V3') || p.includes('VBUS') || p.includes('VSYS') || p.includes('VIN') || p.includes('5V')) return 'pwr';
    if (p.includes('A0') || p.includes('A1') || p.includes('A2') || p.includes('ADC')) return 'adc';
    if (p.includes('EN') || p.includes('RUN') || p.includes('RST')) return 'ctrl';
    if (p.includes('TX') || p.includes('RX')) return 'uart';
    return 'gpio';
}

/**
 * Generate HTML for the pinout diagram
 */
function createPinoutHtml(platform) {
    const data = PINOUT_DATA[platform] || PINOUT_DATA['esp32']; // fallback to esp32
    
    let leftHtml = '';
    let rightHtml = '';
    
    // Generate Left Pins
    for (const pin of data.left) {
        const pClass = getPinClass(pin);
        leftHtml += `
            <div class="pin-row">
                <div class="pin left ${pClass}"><span class="pin-label">${pin}</span></div>
            </div>
        `;
    }

    // Generate Right Pins
    for (const pin of data.right) {
        const pClass = getPinClass(pin);
        rightHtml += `
            <div class="pin-row">
                <div class="pin right ${pClass}"><span class="pin-label">${pin}</span></div>
            </div>
        `;
    }

    return `
        <div class="pinout-header">
            <h3>🧷 Hardware Pinout Diagram</h3>
            <span class="badg">${data.name}</span>
        </div>
        <div class="pinout-wrapper">
            <div class="board-chip">
                <div class="chip-label">${data.name.split(' ')[0]}</div>
                <div class="pins-left">${leftHtml}</div>
                <div class="pins-right">${rightHtml}</div>
            </div>
            
            <div class="pin-legend">
                <div class="legend-item"><div class="dot pwr"></div> Power</div>
                <div class="legend-item"><div class="dot gnd"></div> Ground</div>
                <div class="legend-item"><div class="dot gpio"></div> GPIO</div>
                <div class="legend-item"><div class="dot adc"></div> ADC</div>
                <div class="legend-item"><div class="dot uart"></div> UART / TXRX</div>
                <div class="legend-item"><div class="dot ctrl"></div> Control</div>
            </div>
        </div>
    `;
}

/**
 * Generates the full HTML for the Webview
 */
function getWebviewContent(metrics) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Device Dashboard</title>
    <style>
        :root {
            --bg-color: #1a1a24;
            --card-bg: rgba(30, 30, 46, 0.7);
            --card-border: rgba(255, 255, 255, 0.08);
            --text-main: #e2e8f0;
            --text-muted: #94a3b8;
            --accent: #3b82f6;
        }

        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            background-color: var(--bg-color);
            color: var(--text-main);
            margin: 0;
            padding: 32px;
            display: flex;
            flex-direction: column;
            align-items: center;
        }

        .header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            width: 100%;
            max-width: 900px;
            margin-bottom: 8px;
        }

        h1 {
            font-size: 28px;
            font-weight: 700;
            margin: 0;
            background: linear-gradient(90deg, #60a5fa, #a78bfa);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        .refresh-btn {
            background: var(--accent);
            color: white;
            border: none;
            padding: 8px 16px;
            border-radius: 8px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .refresh-btn:hover {
            background: #2563eb;
            transform: translateY(-1px);
        }

        .refresh-btn:active {
            transform: translateY(1px);
        }

        .subtitle {
            color: var(--text-muted);
            margin-bottom: 40px;
            font-size: 14px;
            width: 100%;
            max-width: 900px;
            text-align: left;
        }

        .dashboard-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
            gap: 24px;
            width: 100%;
            max-width: 900px;
        }

        .card {
            background: var(--card-bg);
            border: 1px solid var(--card-border);
            border-radius: 16px;
            padding: 24px;
            backdrop-filter: blur(12px);
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
            transition: transform 0.2s, box-shadow 0.2s;
            display: flex;
            flex-direction: column;
        }

        .card:hover {
            transform: translateY(-2px);
            box-shadow: 0 12px 40px rgba(0, 0, 0, 0.3);
            border-color: rgba(255, 255, 255, 0.15);
        }

        .card h2 {
            margin: 0 0 20px 0;
            font-size: 16px;
            text-transform: uppercase;
            letter-spacing: 1px;
            color: var(--text-muted);
            display: flex;
            align-items: center;
            gap: 8px;
        }

        /* Chart Styles */
        .chart-container {
            display: flex;
            flex-direction: column;
            align-items: center;
            position: relative;
        }

        .donut-text {
            position: absolute;
            top: 50px;
            display: flex;
            flex-direction: column;
            align-items: center;
        }

        .donut-text .pct {
            font-size: 24px;
            font-weight: 700;
            line-height: 1;
        }

        .donut-text .label {
            font-size: 12px;
            color: var(--text-muted);
            margin-top: 4px;
        }

        .chart-stats {
            width: 100%;
            margin-top: 20px;
            padding-top: 20px;
            border-top: 1px solid var(--card-border);
            display: flex;
            justify-content: space-around;
        }

        .stat-line {
            display: flex;
            align-items: center;
            font-size: 13px;
            color: var(--text-muted);
            font-family: "JetBrains Mono", "Fira Code", monospace;
        }
        
        .stat-line .unit {
            font-size: 11px;
            color: #64748b;
        }

        .dot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            margin-right: 8px;
        }
        .dot.used { background: var(--accent); }
        .dot.free { background: #2d2d3d; }

        /* System Info Styles */
        .info-grid {
            display: grid;
            grid-template-columns: 1fr;
            gap: 16px;
        }
        .info-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding-bottom: 12px;
            border-bottom: 1px solid var(--card-border);
        }
        .info-item:last-child {
            border-bottom: none;
            padding-bottom: 0;
        }
        .info-label {
            color: var(--text-muted);
            font-size: 14px;
        }
        .info-val {
            font-weight: 600;
            font-size: 15px;
            color: #fff;
            text-transform: capitalize;
        }
        .info-val .unit {
            font-size: 12px;
            color: var(--text-muted);
            font-weight: normal;
        }

        /* SVG animations */
        .donut-segment {
            animation: fillDonut 1s ease-out forwards;
        }
        @keyframes fillDonut {
            0% { stroke-dasharray: 0 314; }
        }

        /* Pinout Diagram Styles */
        .pinout-card {
            grid-column: 1 / -1;
            align-items: center;
        }
        
        .pinout-header {
            width: 100%;
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 24px;
        }
        
        .pinout-header h3 {
            margin: 0;
            color: var(--text-muted);
            font-size: 16px;
            text-transform: uppercase;
            letter-spacing: 1px;
        }

        .badg {
            background-color: rgba(59, 130, 246, 0.2);
            color: #60a5fa;
            padding: 4px 12px;
            border-radius: 999px;
            font-size: 12px;
            font-weight: 600;
        }

        .pinout-wrapper {
            display: flex;
            flex-direction: column;
            align-items: center;
            width: 100%;
            position: relative;
        }

        .board-chip {
            background-color: #111115;
            border: 2px solid #333;
            border-radius: 8px;
            min-height: 400px;
            width: 140px;
            position: relative;
            display: flex;
            justify-content: space-between;
            box-shadow: inset 0 0 20px rgba(0,0,0,0.8), 0 10px 30px rgba(0,0,0,0.4);
            margin: 20px 0 40px 0;
            padding: 24px 0;
        }

        .board-chip::after {
            content: '';
            position: absolute;
            top: 10px;
            left: 50%;
            transform: translateX(-50%);
            width: 16px;
            height: 16px;
            border-radius: 50%;
            background: #000;
            border: 2px solid #222;
        }

        .chip-label {
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%) rotate(-90deg);
            color: #333;
            font-size: 32px;
            font-weight: 800;
            letter-spacing: 8px;
            pointer-events: none;
        }

        .pins-left, .pins-right {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .pin-row {
            height: 8px;
            display: flex;
            align-items: center;
        }

        .pin {
            width: 12px;
            height: 8px;
            background: #c0c0c0;
            position: relative;
            box-shadow: 0 2px 4px rgba(0,0,0,0.5);
        }

        .pin.left {
            border-radius: 0 3px 3px 0;
            margin-left: -6px;
        }
        
        .pin.right {
            border-radius: 3px 0 0 3px;
            margin-right: -6px;
        }

        .pin-label {
            position: absolute;
            top: 50%;
            transform: translateY(-50%);
            font-family: "JetBrains Mono", "Fira Code", monospace;
            font-size: 11px;
            font-weight: 600;
            white-space: nowrap;
        }

        .pin.left .pin-label { right: 20px; text-align: right; }
        .pin.right .pin-label { left: 20px; text-align: left; }

        /* Pin Colors */
        .pin.pwr { background: #ef4444; }
        .pin.pwr .pin-label { color: #ef4444; }
        
        .pin.gnd { background: #1a1a24; border: 1px solid #444; }
        .pin.gnd .pin-label { color: #888; }
        
        .pin.gpio { background: #10b981; }
        .pin.gpio .pin-label { color: #10b981; }
        
        .pin.adc { background: #a855f7; }
        .pin.adc .pin-label { color: #a855f7; }
        
        .pin.uart { background: #3b82f6; }
        .pin.uart .pin-label { color: #3b82f6; }
        
        .pin.ctrl { background: #f59e0b; }
        .pin.ctrl .pin-label { color: #f59e0b; }

        .pin-legend {
            width: 100%;
            display: flex;
            justify-content: center;
            flex-wrap: wrap;
            gap: 16px;
            margin-top: 20px;
            padding-top: 20px;
            border-top: 1px solid var(--card-border);
        }

        .legend-item {
            display: flex;
            align-items: center;
            font-size: 12px;
            color: var(--text-muted);
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>Device Dashboard</h1>
        <button class="refresh-btn" id="refreshBtn">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>
            Refresh
        </button>
    </div>
    <div class="subtitle">Live hardware telemetry & management via mpremote</div>

    <div class="dashboard-grid">
        
        <!-- System Info Card -->
        <div class="card">
            <h2>⚙️ System Information</h2>
            <div class="info-grid">
                <div class="info-item">
                    <span class="info-label">Firmware</span>
                    <span class="info-val">${metrics.firmware}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Version</span>
                    <span class="info-val">v${metrics.version}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">CPU Clock</span>
                    <span class="info-val">${metrics.cpuFreqHtml}</span>
                </div>
            </div>
        </div>

        <!-- RAM Card -->
        <div class="card">
            <h2>🧠 RAM Usage</h2>
            ${createDonutChart(metrics.ramUsed, metrics.ramTotal)}
        </div>

        <!-- Flash Card -->
        <div class="card">
            <h2>💾 Flash Storage</h2>
            ${createDonutChart(metrics.flashUsed, metrics.flashTotal)}
        </div>

        <!-- Pinout Diagram Card -->
        <div class="card pinout-card">
            ${createPinoutHtml(metrics.platform)}
        </div>

    </div>

    <script>
        const vscode = acquireVsCodeApi();
        document.getElementById('refreshBtn').addEventListener('click', () => {
            document.getElementById('refreshBtn').innerHTML = '<div class="loader" style="width:14px;height:14px;border-width:2px;border-top-color:white;margin-right:6px"></div> Refreshing...';
            document.getElementById('refreshBtn').style.opacity = '0.7';
            document.getElementById('refreshBtn').disabled = true;
            vscode.postMessage({ command: 'refreshMetrics' });
        });
    </script>
</body>
</html>`;
}

/**
 * Open the Webview Panel
 */
async function openDeviceDashboard(context, outputChannel, currentDevicePort) {
    if (!currentDevicePort) {
        vscode.window.showWarningMessage('No device connected. Please connect a device and run "Refresh Device Files" first.');
        return;
    }

    // Create the Webview Panel
    const panel = vscode.window.createWebviewPanel(
        'deviceDashboard',
        `Device: ${currentDevicePort}`,
        vscode.ViewColumn.One,
        { enableScripts: true }
    );

    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('You must have a project workspace open to use the Dashboard.');
        panel.dispose();
        return;
    }
    const workspaceRoot = workspaceFolders[0].uri.fsPath;

    // Initial Loading State
    panel.webview.html = `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <style>
                body { background-color: #1a1a24; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; font-family: sans-serif; gap: 20px;}
                .loader { border: 4px solid rgba(255,255,255,0.1); border-top-color: #3b82f6; border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; }
                @keyframes spin { to { transform: rotate(360deg); } }
            </style>
        </head>
        <body>
            <div class="loader"></div>
            <div>Fetching live telemetry from ${currentDevicePort}...</div>
        </body>
        </html>
    `;

    // Function to fetch and update html
    const updateDashboard = async () => {
        try {
            const metrics = await gatherDeviceMetrics(outputChannel, workspaceRoot);
            panel.webview.html = getWebviewContent(metrics);
        } catch (err) {
            panel.webview.html = `<body><h2>Error gathering telemetry</h2><p>${err.message}</p></body>`;
        }
    };

    // Listen for refresh messages
    panel.webview.onDidReceiveMessage(
        message => {
            if (message.command === 'refreshMetrics') {
                updateDashboard();
            }
        },
        undefined,
        context.subscriptions
    );

    // Initial fetch
    updateDashboard();
}

module.exports = { openDeviceDashboard };
