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
print(sys.implementation.name)
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
            metrics.firmware = sysLines[0];
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

        h1 {
            font-size: 28px;
            font-weight: 700;
            margin-bottom: 8px;
            background: linear-gradient(90deg, #60a5fa, #a78bfa);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        .subtitle {
            color: var(--text-muted);
            margin-bottom: 40px;
            font-size: 14px;
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
    </style>
</head>
<body>

    <h1>Device Dashboard</h1>
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

    </div>

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

    // Fetch the real data
    try {
        const metrics = await gatherDeviceMetrics(outputChannel, workspaceRoot);
        panel.webview.html = getWebviewContent(metrics);
    } catch (err) {
        panel.webview.html = `<body><h2>Error gathering telemetry</h2><p>${err.message}</p></body>`;
    }
}

module.exports = { openDeviceDashboard };
