const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { runMpremote } = require("./runCommand");
const {
  updateCfgComponent,
  getVenvPythonPath,
  getVenvPythonPathFolder,
  getConfigValue,
} = require("./commonFxn");

/**
 * Gathers all metrics from the device and converts them to a structured object.
 * We write a temporary python script locally and run it on the board to avoid
 * complex shell quote escaping issues with `mpremote exec`.
 * @param {string} devicePort - The COM port or ws: address of the device
 */
async function gatherDeviceMetrics(outputChannel, workspaceFolder, devicePort) {
  const metrics = {
    firmware: "Unknown",
    platform: "Unknown",
    version: "Unknown",
    cpuFreqHtml: "Unknown",
    ramUsed: 0,
    ramFree: 0,
    ramTotal: 0,
    flashUsed: 0,
    flashFree: 0,
    flashTotal: 0,
    wifi: { supported: false, connected: false, ip: "", ssid: "" },
    bootLog: { hasLog: false, status: "none", ip: "", detail: "" },
  };

  // The single python script to fetch all metrics at once
  const pythonScript = `import sys
try:
    import gc
except ImportError:
    gc = None
try:
    import os
except ImportError:
    os = None

# 1. Firmware
print("---SYS---")
try:
    print(sys.version)
except:
    print("unknown")
print(sys.platform)
print('.'.join(map(str, sys.implementation.version)))
try:
    import machine
    print(machine.freq() if hasattr(machine, 'freq') else 0)
except ImportError:
    try:
        import microcontroller
        print(microcontroller.cpu.frequency if hasattr(microcontroller, 'cpu') else 0)
    except ImportError:
        print(0)

# 2. RAM
print("---RAM---")
if gc:
    gc.collect()
    print(gc.mem_alloc() if hasattr(gc, 'mem_alloc') else 0)
    print(gc.mem_free() if hasattr(gc, 'mem_free') else 0)
else:
    print(0)
    print(0)

# 3. Flash
print("---FLASH---")
try:
    s=os.statvfs('/') if os else None
    if s:
        print(s[0]*s[2])
        print(s[0]*s[3])
    else:
        print(0)
        print(0)
except Exception:
    print(0)
    print(0)

# 4. Wi-Fi
print("---WIFI---")
try:
    import network
    if not hasattr(network, 'WLAN'):
        print("NO_WIFI")
    else:
        sta = network.WLAN(network.STA_IF)
        sta.active(True)
        if sta.isconnected():
            cfg = sta.ifconfig()
            print("1")
            print(cfg[0])
            try:
                print(sta.config('essid'))
            except:
                print("")
        else:
            print("0")
            print("")
            print("")
except ImportError:
    try:
        import wifi
        if hasattr(wifi, 'radio'):
            if wifi.radio.ipv4_address:
                print("1")
                print(wifi.radio.ipv4_address)
                try:
                    print(wifi.radio.ap_info.ssid)
                except:
                    print("")
            else:
                print("0")
                print("")
                print("")
        else:
            print("NO_WIFI")
    except ImportError:
        print("NO_WIFI")

# 5. Boot log (written by safe boot.py on each reboot)
print("---BOOTLOG---")
try:
    with open('mps_boot.log') as f:
        print(f.read().strip())
except:
    print("NO_LOG")
`;

  // Save script locally to a safe temp spot in the workspace
  const tempScriptPath = path.join(workspaceFolder, "_dashboard_metrics.py");
  try {
    fs.writeFileSync(tempScriptPath, pythonScript, "utf8");

    // Run the script on the device
    // ws: ports need mpremotesubpro.py (mpremote has no WebSocket transport)
    let rawOutput;
    if (devicePort && devicePort.startsWith("ws:")) {
      const venvPython = getVenvPythonPath(getVenvPythonPathFolder());
      const subpro = path.join(__dirname, "mpremotesubpro.py");
      rawOutput = await new Promise((resolve) => {
        execFile(
          venvPython,
          [
            subpro,
            "--python",
            venvPython,
            "run_mcu",
            "--port",
            devicePort,
            "--file",
            tempScriptPath,
          ],
          { timeout: 30000 },
          (_err, stdout) => resolve(stdout || ""),
        );
      });
    } else {
      const mpArgs = devicePort
        ? ["connect", devicePort, "run", `"${tempScriptPath}"`]
        : ["run", `"${tempScriptPath}"`];
      rawOutput = await runMpremote(outputChannel, mpArgs);
    }

    // Parse the block output
    const lines = rawOutput
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);

    let currentSection = "";
    let sysLines = [];
    let ramLines = [];
    let flashLines = [];
    let wifiLines = [];
    let bootLogLines = [];

    for (const line of lines) {
      if (line === "---SYS---") {
        currentSection = "SYS";
        continue;
      }
      if (line === "---RAM---") {
        currentSection = "RAM";
        continue;
      }
      if (line === "---FLASH---") {
        currentSection = "FLASH";
        continue;
      }
      if (line === "---WIFI---") {
        currentSection = "WIFI";
        continue;
      }
      if (line === "---BOOTLOG---") {
        currentSection = "BOOTLOG";
        continue;
      }

      if (currentSection === "SYS") sysLines.push(line);
      else if (currentSection === "RAM") ramLines.push(line);
      else if (currentSection === "FLASH") flashLines.push(line);
      else if (currentSection === "WIFI") wifiLines.push(line);
      else if (currentSection === "BOOTLOG") bootLogLines.push(line);
    }

    // Apply SYS metrics
    if (sysLines.length >= 4) {
      const rawSysVersion = sysLines[0].toLowerCase();
      metrics.firmware = rawSysVersion.includes("circuitpython")
        ? "CircuitPython"
        : "MicroPython";
      metrics.platform = sysLines[1];
      metrics.version = sysLines[2];
      const freqHz = parseInt(sysLines[3], 10);
      metrics.cpuFreqHtml =
        freqHz > 0
          ? `${(freqHz / 1000000).toFixed(0)} <span class="unit">MHz</span>`
          : "Unknown";
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

    // Apply Wi-Fi metrics
    if (wifiLines.length > 0 && wifiLines[0] !== "NO_WIFI") {
      metrics.wifi.supported = true;
      metrics.wifi.connected = wifiLines[0] === "1";
      metrics.wifi.ip = wifiLines[1] || "";
      metrics.wifi.ssid = wifiLines[2] || "";
    } else if (wifiLines[0] === "NO_WIFI") {
      metrics.wifi.supported = false;
    }

    // Apply Boot Log — written by safe boot.py on each reboot
    const rawLog = bootLogLines.join("").trim();
    if (rawLog && rawLog !== "NO_LOG") {
      metrics.bootLog.hasLog = true;
      if (rawLog.startsWith("OK:")) {
        metrics.bootLog.status = "ok";
        metrics.bootLog.ip = rawLog.slice(3);
        metrics.bootLog.detail = `Remote access active — ${metrics.bootLog.ip}`;
      } else if (rawLog.startsWith("WIFI_TIMEOUT:")) {
        metrics.bootLog.status = "timeout";
        metrics.bootLog.detail = "Wi-Fi not available — USB mode only";
      } else if (rawLog.startsWith("ERROR:")) {
        metrics.bootLog.status = "error";
        metrics.bootLog.detail = `Boot error: ${rawLog.slice(6)}`;
      } else {
        metrics.bootLog.status = "unknown";
        metrics.bootLog.detail = rawLog;
      }
    }
  } catch (err) {
    console.error("Failed to gather metrics:", err);
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
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return (
    parseFloat((bytes / Math.pow(k, i)).toFixed(1)) +
    ' <span class="unit">' +
    sizes[i] +
    "</span>"
  );
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
  let color = "#10b981"; // green
  if (percentage > 70) color = "#f59e0b"; // yellow
  if (percentage > 90) color = "#ef4444"; // red

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
 * Known Board Pinouts — loaded from resource/pinouts/pinouts.json.
 * To add a new board or update pins, edit that file directly.
 * @type {Record<string, {name: string, left: string[], right: string[]}>}
 */
let PINOUT_DATA = {};
try {
  const pinoutsPath = path.join(
    __dirname,
    "..",
    "resource",
    "pinouts",
    "pinouts.json",
  );
  PINOUT_DATA = JSON.parse(fs.readFileSync(pinoutsPath, "utf8"));
} catch (e) {
  // fallback — empty, pinout section will show nothing
}

/**
 * Map sys.platform / device.cfg mcu values → pinouts.json key.
 * Priority: connected device sys.platform > device.cfg mcu field > first available key.
 * @param {string} platform  - sys.platform from device (e.g. 'rp2', 'esp32') or 'Unknown'
 * @param {string} mcuFromCfg - mcu value from device.cfg (e.g. 'rp2350', 'rp2_w', 'esp32')
 * @returns {string} key into PINOUT_DATA
 */
function resolvePinoutKey(platform, mcuFromCfg) {
  // 1. device.cfg mcu is most specific — sys.platform returns 'rp2' for BOTH RP2040 and RP2350
  //    so cfg takes priority to get the correct board name
  if (mcuFromCfg) {
    const m = mcuFromCfg.toLowerCase().trim();
    if (PINOUT_DATA[m]) return m;
    // prefix matches: rp2350w → rp2350_w, rp2w → rp2_w, etc.
    /** @type {Array<[RegExp, string]>} */
    const aliases = [
      // Full human-readable names (from project wizard board picker)
      [/pico\s*2\s*w/i, "rp2350_w"],
      [/pico\s*2/i, "rp2350"],
      [/pico\s*w/i, "rp2_w"],
      [/pico/i, "rp2"],
      // Short codes
      [/^rp2350.?w/, "rp2350_w"],
      [/^rp2350/, "rp2350"],
      [/^rp2.?w/, "rp2_w"],
      [/^rp2/, "rp2"],
      [/^esp32/, "esp32"],
      [/^esp8266/, "esp8266"],
      [/^samd/, "samd"],
      [/^stm32/, "stm32"],
      [/^mimxrt/, "mimxrt"],
      [/^nrf/, "nrf"],
    ];
    for (const [re, key] of aliases) {
      if (re.test(m) && PINOUT_DATA[key]) return key;
    }
  }

  // 2. Fall back to sys.platform from connected device
  if (platform && platform !== "Unknown" && PINOUT_DATA[platform])
    return platform;

  // 3. Default to first key in pinouts.json
  return Object.keys(PINOUT_DATA)[0] || "rp2";
}

/**
 * Get Color class for pin based on its name
 */
function getPinClass(pinName) {
  const p = pinName.toUpperCase();
  if (p.includes("GND")) return "gnd";
  if (
    p.includes("3V3") ||
    p.includes("VBUS") ||
    p.includes("VSYS") ||
    p.includes("VIN") ||
    p.includes("5V")
  )
    return "pwr";
  if (
    p.includes("A0") ||
    p.includes("A1") ||
    p.includes("A2") ||
    p.includes("ADC")
  )
    return "adc";
  if (p.includes("EN") || p.includes("RUN") || p.includes("RST")) return "ctrl";
  if (p.includes("TX") || p.includes("RX")) return "uart";
  return "gpio";
}

/**
 * Generate HTML for the pinout diagram
 * @param {string} pinoutKey - resolved key from resolvePinoutKey()
 */
function createPinoutHtml(pinoutKey) {
  const data =
    PINOUT_DATA[pinoutKey] || PINOUT_DATA[Object.keys(PINOUT_DATA)[0]];

  let leftHtml = "";
  let rightHtml = "";

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
                <div class="chip-label">${data.name.split(" ")[0]}</div>
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

    /* --- PINOUT CARD ENHANCEMENTS --- */
    

.pinout-card {
    grid-column: 1 / -1;
    overflow-x: auto;
}

.pinout-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 12px;   /* reduced */
    flex-wrap: wrap;
    gap: 8px;              /* reduced */
}

.pinout-header h3 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-main);
}

.badge {
    background: rgba(59, 130, 246, 0.15);
    color: #60a5fa;
    padding: 3px 12px;
    border-radius: 20px;
    font-size: 11px;
    font-weight: 600;
    backdrop-filter: blur(2px);
    border: 1px solid rgba(96, 165, 250, 0.2);
}

.pinout-wrapper {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
}

/* CHIP – compact */
.board-chip {
    background: linear-gradient(145deg, #1e1e2a 0%, #111115 100%);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 24px;
    min-width: 220px;
    width: auto;
    max-width: 100%;
    position: relative;
    display: flex;
    justify-content: space-between;
    box-shadow: 0 20px 35px -10px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.05);
    margin: 20px 0 30px 0;
    padding: 32px 12px;
}

.board-chip::after {
    content: '';
    position: absolute;
    top: 12px;
    left: 50%;
    transform: translateX(-50%);
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #000;
    border: 2px solid #2a2a2a;
    box-shadow: 0 0 6px rgba(0,0,0,0.4);
}

.chip-label {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%) rotate(-90deg);
    font-size: 24px;
    font-weight: 800;
    letter-spacing: 4px;
    color: rgba(148, 163, 184, 0.15);
    text-transform: uppercase;
    white-space: nowrap;
    pointer-events: none;
    font-family: 'Segoe UI', 'SF Pro Text', system-ui, sans-serif;
}

/* PIN COLUMNS – tighter spacing */
.pins-left, .pins-right {
    display: flex;
    flex-direction: column;
    gap: 14px;
}

.pin-row {
    display: flex;
    align-items: center;
    height: 28px;
}

.pin {
    position: relative;
    width: 18px;
    height: 10px;
    background: #cbd5e1;
    border-radius: 2px;
    box-shadow: 0 1px 2px rgba(0,0,0,0.2);
    transition: all 0.15s ease;
    cursor: default;
}

.pin:hover {
    transform: scaleX(1.1);
    filter: brightness(1.1);
}

/* pin labels – adjust positioning for smaller pins */
.pin-label {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    font-weight: 500;
    white-space: nowrap;
    background: rgba(0,0,0,0.6);
    padding: 2px 6px;
    border-radius: 6px;
    backdrop-filter: blur(4px);
    opacity: 0.9;
    pointer-events: none;
}

.pin.left .pin-label {
    right: 22px;
    text-align: right;
}

.pin.right .pin-label {
    left: 22px;
    text-align: left;
}

/* legend – compact */
.pin-legend {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;              /* reduced gap */
    background: rgba(255,255,255,0.03);
    backdrop-filter: blur(8px);
    border-radius: 32px;
    padding: 8px 16px;     /* less padding */
    margin-top: 12px;      /* reduced */
    border: 1px solid rgba(255,255,255,0.05);
    box-shadow: 0 2px 8px rgba(0,0,0,0.1);
}

.legend-item {
    display: inline-flex;
    align-items: center;
    gap: 6px;              /* smaller gap */
    background: rgba(0,0,0,0.3);
    padding: 3px 10px;     /* less padding */
    border-radius: 24px;
    font-size: 10px;       /* smaller font */
    font-weight: 500;
    color: var(--text-main);
    transition: all 0.2s;
    cursor: default;
    border: 1px solid rgba(255,255,255,0.02);
}

.legend-item:hover {
    transform: translateY(-1px);
    background: rgba(255,255,255,0.1);
    border-color: rgba(255,255,255,0.2);
}

.dot {
    width: 8px;            /* smaller dot */
    height: 8px;
    border-radius: 50%;
    box-shadow: 0 1px 1px rgba(0,0,0,0.2);
    transition: transform 0.1s;
}

/* responsive – ensure it still fits */
@media (max-width: 550px) {
    .board-chip {
        flex-direction: column;
        align-items: center;
        gap: 12px;
        padding: 16px 8px;
    }
    .pins-left, .pins-right {
        width: 80%;
        gap: 6px;
    }
    .chip-label {
        font-size: 14px;
        letter-spacing: 1px;
    }
    .pin-legend {
        gap: 6px;
        padding: 6px 12px;
    }
    .legend-item {
        padding: 2px 8px;
        font-size: 9px;
    }
}

    /* PIN COLOR OVERRIDES (keep your existing colors) */
    .pin.pwr { background: #ef4444; }
    .pin.pwr .pin-label { color: #ef4444; background: rgba(0,0,0,0.7); }

    .pin.gnd { background: #6b7280; border: none; }
    .pin.gnd .pin-label { color: #9ca3af; }

    .pin.gpio { background: #10b981; }
    .pin.gpio .pin-label { color: #10b981; }

    .pin.adc { background: #a855f7; }
    .pin.adc .pin-label { color: #a855f7; }

    .pin.uart { background: #3b82f6; }
    .pin.uart .pin-label { color: #3b82f6; }

    .pin.ctrl { background: #f59e0b; }
    .pin.ctrl .pin-label { color: #f59e0b; }

    /* LEGEND – BEAUTIFIED */
    .pin-legend {
        display: flex;
        flex-wrap: wrap;
        justify-content: center;
        gap: 12px;
        background: rgba(255,255,255,0.03);
        backdrop-filter: blur(8px);
        border-radius: 48px;
        padding: 12px 24px;
        margin-top: 20px;
        border: 1px solid rgba(255,255,255,0.05);
        box-shadow: 0 4px 12px rgba(0,0,0,0.1);
    }

    .legend-item {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        background: rgba(0,0,0,0.3);
        padding: 5px 14px;
        border-radius: 32px;
        font-size: 12px;
        font-weight: 500;
        color: var(--text-main);
        transition: all 0.2s cubic-bezier(0.2, 0.9, 0.4, 1.1);
        cursor: default;
        border: 1px solid rgba(255,255,255,0.02);
    }

    .legend-item:hover {
        transform: translateY(-2px);
        background: rgba(255,255,255,0.1);
        border-color: rgba(255,255,255,0.2);
    }

    .dot {
        width: 12px;
        height: 12px;
        border-radius: 50%;
        box-shadow: 0 1px 2px rgba(0,0,0,0.2);
        transition: transform 0.1s;
    }

    .legend-item:hover .dot {
        transform: scale(1.2);
    }

    /* Dot colors – gradients for extra flair */
    .dot.pwr { background: linear-gradient(135deg, #ef4444, #dc2626); }
    .dot.gnd { background: linear-gradient(135deg, #6b7280, #4b5563); }
    .dot.gpio { background: linear-gradient(135deg, #10b981, #059669); }
    .dot.adc { background: linear-gradient(135deg, #a855f7, #9333ea); }
    .dot.uart { background: linear-gradient(135deg, #3b82f6, #2563eb); }
    .dot.ctrl { background: linear-gradient(135deg, #f59e0b, #d97706); }

    /* Responsive adjustments */
    @media (max-width: 550px) {
        .board-chip {
            flex-direction: column;
            align-items: center;
            gap: 16px;
            padding: 24px 12px;
        }
        .pins-left, .pins-right {
            width: 80%;
        }
        .pin.left, .pin.right {
            margin: 0 auto;
        }
        .chip-label {
            font-size: 20px;
            letter-spacing: 2px;
            white-space: normal;
            text-align: center;
            width: 100%;
        }
        .pin-legend {
            padding: 10px 16px;
            gap: 8px;
        }
        .legend-item {
            padding: 4px 10px;
            font-size: 11px;
        }
    }

        .legend-item {
            display: flex;
            align-items: center;
            font-size: 12px;
            color: var(--text-muted);
        }

        /* ── Wi-Fi Card ──────────────────────────────── */
        .wifi-card { grid-column: 1 / -1; }

        .wifi-status-badge {
            display: inline-flex;
            align-items: center;
            gap: 7px;
            padding: 5px 14px;
            border-radius: 999px;
            font-size: 13px;
            font-weight: 600;
            margin-bottom: 18px;
        }
        .wifi-status-badge.connected    { background: rgba(16,185,129,0.15); color: #10b981; }
        .wifi-status-badge.disconnected { background: rgba(148,163,184,0.12); color: #94a3b8; }
        .wifi-status-badge.no-wifi      { background: rgba(239,68,68,0.12);  color: #ef4444; }

        .wifi-dot {
            width: 8px; height: 8px;
            border-radius: 50%;
            background: currentColor;
        }

        .wifi-info-row {
            display: flex;
            gap: 24px;
            flex-wrap: wrap;
            margin-bottom: 20px;
        }
        .wifi-info-item { display: flex; flex-direction: column; gap: 3px; }
        .wifi-info-item .wlabel { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
        .wifi-info-item .wval   { font-size: 15px; font-weight: 600; font-family: "JetBrains Mono","Fira Code",monospace; }

        .wifi-actions { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }

        .btn {
            padding: 8px 16px;
            border-radius: 8px;
            border: none;
            font-size: 13px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.18s;
            display: inline-flex;
            align-items: center;
            gap: 6px;
        }
        .btn:hover   { transform: translateY(-1px); }
        .btn:active  { transform: translateY(1px); }
        .btn:disabled{ opacity: 0.45; cursor: not-allowed; transform: none; }

        .btn-primary  { background: var(--accent); color: #fff; }
        .btn-primary:hover { background: #2563eb; }
        .btn-success  { background: #10b981; color: #fff; }
        .btn-success:hover { background: #059669; }
        .btn-warning  { background: #f59e0b; color: #000; }
        .btn-warning:hover { background: #d97706; }
        .btn-ghost    { background: rgba(255,255,255,0.07); color: var(--text-main); border: 1px solid var(--card-border); }
        .btn-ghost:hover { background: rgba(255,255,255,0.13); }

        .wifi-scan-area, .wifi-connect-area, .webrepl-area {
            margin-top: 20px;
            padding-top: 20px;
            border-top: 1px solid var(--card-border);
        }

        .network-list {
            width: 100%;
            max-width: 420px;
            background: rgba(0,0,0,0.3);
            border: 1px solid var(--card-border);
            border-radius: 8px;
            color: var(--text-main);
            padding: 8px 12px;
            font-size: 14px;
            margin-bottom: 12px;
            cursor: pointer;
        }
        .network-list option { background: #1e1e2e; padding: 6px; }

        .wifi-input {
            background: rgba(0,0,0,0.3);
            border: 1px solid var(--card-border);
            border-radius: 8px;
            color: var(--text-main);
            padding: 8px 12px;
            font-size: 14px;
            width: 100%;
            max-width: 420px;
            margin-bottom: 12px;
            display: block;
        }
        .wifi-input:focus { outline: none; border-color: var(--accent); }
        .wifi-input::placeholder { color: #4a5568; }

        .wifi-input-label {
            display: block;
            font-size: 12px;
            color: var(--text-muted);
            margin-bottom: 6px;
            margin-top: 10px;
        }

        .spinner {
            width: 18px; height: 18px;
            border: 3px solid rgba(255,255,255,0.15);
            border-top-color: #60a5fa;
            border-radius: 50%;
            animation: spin 0.8s linear infinite;
            display: inline-block;
        }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* WebREPL Toggle */
        .toggle-row {
            display: flex;
            align-items: center;
            gap: 14px;
            margin-bottom: 14px;
        }
        .toggle-label { font-size: 14px; font-weight: 600; }
        .toggle-sub   { font-size: 12px; color: var(--text-muted); margin-top: 2px; }

        .toggle {
            position: relative;
            width: 44px; height: 24px;
            cursor: pointer;
        }
        .toggle input { opacity: 0; width: 0; height: 0; }
        .toggle-slider {
            position: absolute;
            top: 0; left: 0; right: 0; bottom: 0;
            background: #334155;
            border-radius: 12px;
            transition: 0.3s;
        }
        .toggle-slider::before {
            content: '';
            position: absolute;
            height: 18px; width: 18px;
            left: 3px; bottom: 3px;
            background: white;
            border-radius: 50%;
            transition: 0.3s;
        }
        .toggle input:checked + .toggle-slider { background: #10b981; }
        .toggle input:checked + .toggle-slider::before { transform: translateX(20px); }

        .webrepl-ip-box {
            background: rgba(16,185,129,0.1);
            border: 1px solid rgba(16,185,129,0.3);
            border-radius: 10px;
            padding: 14px 18px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            flex-wrap: wrap;
            gap: 12px;
            margin-top: 14px;
        }
        .webrepl-ip-label { font-size: 12px; color: #10b981; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
        .webrepl-ip-val   { font-size: 18px; font-weight: 700; font-family: "JetBrains Mono","Fira Code",monospace; }
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
            ${createPinoutHtml(metrics.pinoutKey || metrics.platform)}
        </div>

        <!-- Wi-Fi Manager Card -->
        ${
          metrics.wifi.supported
            ? `
        <div class="card wifi-card" id="wifiCard">
            <h2>📶 Wi-Fi Manager</h2>

            <div id="wifiStatusArea">
                ${
                  metrics.wifi.connected
                    ? `<div class="wifi-status-badge connected"><span class="wifi-dot"></span> Connected</div>
                       <div class="wifi-info-row">
                           <div class="wifi-info-item"><span class="wlabel">Network</span><span class="wval">${metrics.wifi.ssid || "—"}</span></div>
                           <div class="wifi-info-item"><span class="wlabel">IP Address</span><span class="wval" id="currentIp">${metrics.wifi.ip}</span></div>
                       </div>`
                    : `<div class="wifi-status-badge disconnected"><span class="wifi-dot"></span> Not Connected</div>`
                }
                ${
                  metrics.bootLog.hasLog
                    ? `
                <div class="boot-log-row boot-log-${metrics.bootLog.status}" id="bootLogRow">
                    <span class="boot-log-icon">${metrics.bootLog.status === "ok" ? "✅" : metrics.bootLog.status === "timeout" ? "⚠️" : "❌"}</span>
                    <span class="boot-log-text">Last boot: ${metrics.bootLog.detail}</span>
                    <button class="btn btn-danger btn-sm" id="disableRemoteBtn" style="margin-left:auto">🔒 Disable Remote Access</button>
                </div>`
                    : ""
                }
            </div>

            <div class="wifi-actions" id="wifiActionsBar">
                <button class="btn btn-primary" id="scanBtn">🔍 Scan Networks</button>
                ${
                  metrics.wifi.connected
                    ? `<button class="btn btn-ghost" id="disconnectBtn">Disconnect</button>`
                    : ""
                }
            </div>

            <div class="wifi-scan-area" id="wifiScanArea" style="display:none"></div>

            ${
              metrics.firmware === "CircuitPython"
                ? `
            <div class="webrepl-area" id="webWorkflowArea">
                <div class="toggle-row">
                    <div style="flex:1">
                        <div class="toggle-label">🌐 Web Workflow (CircuitPython Wi-Fi)</div>
                        <div class="toggle-sub">Configure Wi-Fi + API access via <code>settings.toml</code> on the CIRCUITPY drive</div>
                    </div>
                    <button class="btn-sm btn-accent" id="webWorkflowToggleBtn" onclick="toggleWebWorkflowForm()">Configure</button>
                </div>
                <div id="webWorkflowForm" style="display:none;margin-top:14px">
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px">
                        <div>
                            <div class="wlabel" style="margin-bottom:4px">Wi-Fi SSID</div>
                            <input class="wifi-input" id="cpWifiSsid" type="text" placeholder="YourNetworkName" />
                        </div>
                        <div>
                            <div class="wlabel" style="margin-bottom:4px">Wi-Fi Password</div>
                            <input class="wifi-input" id="cpWifiPass" type="password" placeholder="Wi-Fi password" />
                        </div>
                        <div>
                            <div class="wlabel" style="margin-bottom:4px">API Password</div>
                            <input class="wifi-input" id="cpApiPass" type="text" placeholder="webworkflow password" />
                        </div>
                        <div>
                            <div class="wlabel" style="margin-bottom:4px">API Port</div>
                            <input class="wifi-input" id="cpApiPort" type="number" placeholder="80" value="80" />
                        </div>
                    </div>
                    <div style="font-size:11px;color:#94a3b8;margin-bottom:10px">
                        ⚠️ CIRCUITPY drive must be mounted (USB). After saving, reset the board to apply.
                    </div>
                    <div style="display:flex;gap:8px">
                        <button class="btn-sm btn-accent" onclick="saveWebWorkflow()">💾 Save to settings.toml</button>
                        <button class="btn-sm" onclick="detectWebWorkflowIp()" style="margin-left:6px;">🔍 Detect IP</button>
                        <div style="margin-top:6px;font-size:11px;color:#94a3b8;">⚠️ Stop running code first (press <b>Stop</b> or <b>Ctrl+C</b> in REPL) — CircuitPython locks the drive while code is active.</div>
                        <div style="font-size:11px;color:#94a3b8;margin-top:2px;">After saving, power-cycle the board, then click <b>Detect IP</b> to read the assigned address.</div>
                        <button class="btn-sm" onclick="document.getElementById('webWorkflowForm').style.display='none'">Cancel</button>
                    </div>
                    <div id="webWorkflowStatus" style="margin-top:8px;font-size:12px"></div>
                </div>
                ${
                  metrics.wifi.connected
                    ? `
                <div class="webrepl-ip-box" style="margin-top:12px">
                    <div style="flex:1">
                        <div class="webrepl-ip-label">🌐 Web Workflow IP</div>
                        <div class="webrepl-ip-val">${metrics.wifi.ip}</div>
                        <div style="font-size:11px;color:#94a3b8;margin-top:4px">Access at http://${metrics.wifi.ip}/edit/</div>
                    </div>
                </div>`
                    : ""
                }
            </div>`
                : metrics.wifi.connected
                  ? `
            <div class="webrepl-area" id="webReplArea">
                <div class="toggle-row">
                    <label class="toggle">
                        <input type="checkbox" id="webReplToggle">
                        <span class="toggle-slider"></span>
                    </label>
                    <div>
                        <div class="toggle-label">Enable Wireless Access (WebREPL)</div>
                        <div class="toggle-sub">Lets you upload code &amp; use REPL over Wi-Fi — no USB cable needed</div>
                    </div>
                </div>
                <div id="webReplInfoBox" style="display:none"></div>
            </div>`
                  : ""
            }
            ${
              metrics.bootLog.status === "ok"
                ? `
            <div class="webrepl-ip-box" id="webReplActiveBox">
                <div style="flex:1">
                    <div class="webrepl-ip-label">⭐ Remote Access Active  ·  Password: micro123</div>
                    <div class="webrepl-ip-val">${metrics.bootLog.ip}</div>
                    <div style="font-size:11px;color:#94a3b8;margin-top:4px">Auto-starts on every boot</div>
                </div>
                <div style="display:flex;flex-direction:column;gap:6px">
                    <button class="btn btn-warning" id="switchWirelessBtnStatic">⚡ Switch to Wireless</button>
                    <button class="btn btn-danger btn-sm" id="disableRemoteBtnBox">🔒 Disable</button>
                </div>
            </div>`
                : ""
            }
        </div>`
            : `
        <div class="card wifi-card">
            <h2>📶 Wi-Fi Manager</h2>
            <div class="wifi-status-badge no-wifi"><span class="wifi-dot"></span> Wi-Fi Not Supported on this board</div>
        </div>`
        }

    </div>

    <script>
        const vscode = acquireVsCodeApi();

        // ── Refresh button ──────────────────────────────────────────────────
        document.getElementById('refreshBtn').addEventListener('click', () => {
            document.getElementById('refreshBtn').innerHTML = '<div class="loader" style="width:14px;height:14px;border-width:2px;border-top-color:white;margin-right:6px"></div> Refreshing...';
            document.getElementById('refreshBtn').style.opacity = '0.7';
            document.getElementById('refreshBtn').disabled = true;
            vscode.postMessage({ command: 'refreshMetrics' });
        });

        // ── Wi-Fi Scan ──────────────────────────────────────────────────────
        const scanBtn = document.getElementById('scanBtn');
        if (scanBtn) {
            scanBtn.addEventListener('click', () => {
                const area = document.getElementById('wifiScanArea');
                area.style.display = 'block';
                area.innerHTML = '<div style="display:flex;align-items:center;gap:10px;color:#94a3b8"><div class="spinner"></div> Scanning for networks…</div>';
                scanBtn.disabled = true;
                vscode.postMessage({ command: 'scanWifi' });
            });
        }

        // ── Disconnect ──────────────────────────────────────────────────────
        const disconnectBtn = document.getElementById('disconnectBtn');
        if (disconnectBtn) {
            disconnectBtn.addEventListener('click', () => {
                disconnectBtn.disabled = true;
                disconnectBtn.textContent = 'Disconnecting…';
                vscode.postMessage({ command: 'disconnectWifi' });
            });
        }

        // ── WebREPL Toggle ──────────────────────────────────────────────────
        const webReplToggle = document.getElementById('webReplToggle');
        if (webReplToggle) {
            webReplToggle.addEventListener('change', () => {
                if (webReplToggle.checked) {
                    webReplToggle.disabled = true;
                    document.getElementById('webReplInfoBox').innerHTML =
                        '<div style="display:flex;align-items:center;gap:10px;color:#94a3b8"><div class="spinner"></div> Starting WebREPL daemon…</div>';
                    document.getElementById('webReplInfoBox').style.display = 'block';
                    vscode.postMessage({ command: 'enableWebrepl', ssid: window._mpsLastSsid || '', password: window._mpsLastPassword || '' });
                } else {
                    document.getElementById('webReplInfoBox').style.display = 'none';
                }
            });
        }

        // ── CircuitPython Web Workflow ───────────────────────────────────────
        function toggleWebWorkflowForm() {
            const form = document.getElementById('webWorkflowForm');
            if (!form) return;
            form.style.display = form.style.display === 'none' ? 'block' : 'none';
        }

        function detectWebWorkflowIp() {
            const statusEl = document.getElementById('webWorkflowStatus');
            if (statusEl) statusEl.innerHTML = '<span style="color:#94a3b8">🔍 Detecting IP from boot_out.txt…</span>';
            vscode.postMessage({ command: 'detectWebWorkflowIp' });
        }

        function saveWebWorkflow() {
            const ssid       = document.getElementById('cpWifiSsid')?.value.trim();
            const wifiPass   = document.getElementById('cpWifiPass')?.value;
            const apiPass    = document.getElementById('cpApiPass')?.value.trim();
            const apiPort    = parseInt(document.getElementById('cpApiPort')?.value || '80', 10);
            const statusEl   = document.getElementById('webWorkflowStatus');

            if (!ssid || !wifiPass || !apiPass) {
                if (statusEl) statusEl.innerHTML = '<span style="color:#ef4444">⚠️ All fields are required.</span>';
                return;
            }
            if (statusEl) statusEl.innerHTML = '<span style="color:#94a3b8">Saving…</span>';
            vscode.postMessage({ command: 'saveWebWorkflow', ssid, wifiPassword: wifiPass, apiPassword: apiPass, apiPort });
        }

        // ── Message receiver ────────────────────────────────────────────────
        window.addEventListener('message', event => {
            const msg = event.data;

            if (msg.command === 'wifiResults') {
                const area = document.getElementById('wifiScanArea');
                if (!msg.networks || msg.networks.length === 0) {
                    area.innerHTML = '<div style="color:#94a3b8">No networks found. Try again.</div>';
                    if (scanBtn) scanBtn.disabled = false;
                    return;
                }
                // Build SSID dropdown + password + connect button
                const opts = msg.networks
                    .map(n => \`<option value="\${n.ssid}">\${n.ssid}  (\${n.rssi} dBm)</option>\`)
                    .join('');
                area.innerHTML = \`
                    <label class="wifi-input-label">Select Network</label>
                    <select class="network-list" id="ssidSelect">\${opts}</select>
                    <label class="wifi-input-label">Password</label>
                    <input class="wifi-input" type="password" id="wifiPassword" placeholder="Enter Wi-Fi password">
                    <div class="wifi-actions" style="margin-top:12px">
                        <button class="btn btn-success" id="connectBtn">Connect</button>
                        <button class="btn btn-ghost" id="cancelScanBtn">Cancel</button>
                    </div>
                    <div id="connectStatus" style="margin-top:10px"></div>
                \`;
                if (scanBtn) scanBtn.disabled = false;

                document.getElementById('cancelScanBtn').addEventListener('click', () => {
                    area.style.display = 'none';
                });

                document.getElementById('connectBtn').addEventListener('click', () => {
                    const ssid = document.getElementById('ssidSelect').value;
                    const password = document.getElementById('wifiPassword').value;
                    // Store credentials so the WebREPL enable handler can embed them in boot.py
                    window._mpsLastSsid = ssid;
                    window._mpsLastPassword = password;
                    document.getElementById('connectStatus').innerHTML =
                        '<div style="display:flex;align-items:center;gap:10px;color:#94a3b8"><div class="spinner"></div> Connecting… (up to 15 s)</div>';
                    document.getElementById('connectBtn').disabled = true;
                    vscode.postMessage({ command: 'connectWifi', ssid, password });
                });
            }

            if (msg.command === 'wifiConnectDone') {
                const status = document.getElementById('connectStatus');
                if (msg.success) {
                    status.innerHTML = \`<div style="color:#10b981;font-weight:600">✅ Connected!  IP: \${msg.ip}</div>\`;
                    // Update the status area at the top of the card
                    document.getElementById('wifiStatusArea').innerHTML = \`
                        <div class="wifi-status-badge connected"><span class="wifi-dot"></span> Connected</div>
                        <div class="wifi-info-row">
                            <div class="wifi-info-item"><span class="wlabel">Network</span><span class="wval">\${msg.ssid}</span></div>
                            <div class="wifi-info-item"><span class="wlabel">IP Address</span><span class="wval" id="currentIp">\${msg.ip}</span></div>
                        </div>\`;
                    // Show WebREPL toggle if not already there
                    if (!document.getElementById('webReplArea')) {
                        const toggle = document.createElement('div');
                        toggle.className = 'webrepl-area';
                        toggle.id = 'webReplArea';
                        toggle.innerHTML = \`
                            <div class="toggle-row">
                                <label class="toggle">
                                    <input type="checkbox" id="webReplToggle">
                                    <span class="toggle-slider"></span>
                                </label>
                                <div>
                                    <div class="toggle-label">Enable Wireless Access (WebREPL)</div>
                                    <div class="toggle-sub">Upload code &amp; use REPL over Wi-Fi — no USB needed</div>
                                </div>
                            </div>
                            <div id="webReplInfoBox" style="display:none"></div>\`;
                        document.getElementById('wifiCard').appendChild(toggle);
                        // Re-attach toggle listener
                        document.getElementById('webReplToggle').addEventListener('change', function() {
                            if (this.checked) {
                                this.disabled = true;
                                document.getElementById('webReplInfoBox').innerHTML =
                                    '<div style="display:flex;align-items:center;gap:10px;color:#94a3b8"><div class="spinner"></div> Starting WebREPL daemon…</div>';
                                document.getElementById('webReplInfoBox').style.display = 'block';
                                vscode.postMessage({ command: 'enableWebrepl', ssid: window._mpsLastSsid || '', password: window._mpsLastPassword || '' });
                            } else {
                                document.getElementById('webReplInfoBox').style.display = 'none';
                            }
                        });
                    }
                } else {
                    status.innerHTML = '<div style="color:#ef4444;font-weight:600">❌ Connection failed. Check password and try again.</div>';
                    document.getElementById('connectBtn').disabled = false;
                }
            }

            if (msg.command === 'webReplEnabled') {
                const box = document.getElementById('webReplInfoBox');
                box.innerHTML = \`
                    <div class="webrepl-ip-box">
                        <div style="flex:1">
                            <div class="webrepl-ip-label">⭐ Remote Access Active  ·  Password: micro123</div>
                            <div class="webrepl-ip-val">\${msg.ip}</div>
                            <div style="font-size:11px;color:#10b981;margin-top:4px">Auto-starts on every boot (boot.py updated)</div>
                        </div>
                        <div style="display:flex;flex-direction:column;gap:6px">
                            <button class="btn btn-warning" id="switchWirelessBtn">⚡ Switch to Wireless</button>
                            <button class="btn btn-danger btn-sm" id="disableRemoteBtnInBox">🔒 Disable</button>
                        </div>
                    </div>\`;

                document.getElementById('switchWirelessBtn').addEventListener('click', () => {
                    vscode.postMessage({ command: 'switchToWireless', ip: msg.ip });
                    document.getElementById('switchWirelessBtn').textContent = '✅ Switched';
                    document.getElementById('switchWirelessBtn').disabled = true;
                });
                document.getElementById('disableRemoteBtnInBox').addEventListener('click', () => {
                    vscode.postMessage({ command: 'disableRemoteAccess' });
                });
            }

            // Toggle unchecked if user cancelled the warning modal
            if (msg.command === 'webReplCancelled') {
                const t = document.getElementById('webReplToggle');
                if (t) { t.checked = false; t.disabled = false; }
                const box = document.getElementById('webReplInfoBox');
                if (box) box.style.display = 'none';
            }

            if (msg.command === 'webWorkflowIpDetected') {
                const statusEl = document.getElementById('webWorkflowStatus');
                if (statusEl) {
                    const col = msg.ip ? '#10b981' : '#f59e0b';
                    statusEl.innerHTML = '<span style="color:' + col + '">' + msg.message + '</span>';
                }
            }

            if (msg.command === 'webWorkflowSaved') {
                const statusEl = document.getElementById('webWorkflowStatus');
                if (statusEl) {
                    statusEl.innerHTML = msg.success
                        ? '<span style="color:#10b981">' + msg.message + '</span>'
                        : '<span style="color:#ef4444">' + msg.message + '</span>' +
                          (!msg.success ? '<br><span style="color:#94a3b8;font-size:11px;">Tip: Press Stop / Ctrl+C in the REPL to unlock the drive, then try again.</span>' : '');
                }
            }

            // Refresh the card after disabling remote access
            if (msg.command === 'remoteAccessDisabled') {
                const bootLogRow = document.getElementById('bootLogRow');
                if (bootLogRow) bootLogRow.remove();
                const activeBox = document.getElementById('webReplActiveBox');
                if (activeBox) activeBox.remove();
                const box = document.getElementById('webReplInfoBox');
                if (box) { box.innerHTML = ''; box.style.display = 'none'; }
                const t = document.getElementById('webReplToggle');
                if (t) { t.checked = false; t.disabled = false; }
            }

            if (msg.command === 'wifiConnectError') {
                const status = document.getElementById('connectStatus');
                if (status) status.innerHTML = \`<div style="color:#ef4444">\${msg.message}</div>\`;
            }
        });

        // ── Static disable buttons (from boot log row / active box in initial HTML) ──
        const disableRemoteBtn = document.getElementById('disableRemoteBtn');
        if (disableRemoteBtn) {
            disableRemoteBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'disableRemoteAccess' });
            });
        }
        const disableRemoteBtnBox = document.getElementById('disableRemoteBtnBox');
        if (disableRemoteBtnBox) {
            disableRemoteBtnBox.addEventListener('click', () => {
                vscode.postMessage({ command: 'disableRemoteAccess' });
            });
        }
        const switchWirelessBtnStatic = document.getElementById('switchWirelessBtnStatic');
        if (switchWirelessBtnStatic) {
            switchWirelessBtnStatic.addEventListener('click', () => {
                const ip = '${metrics.bootLog.ip}';
                vscode.postMessage({ command: 'switchToWireless', ip });
                switchWirelessBtnStatic.textContent = '✅ Switched';
                switchWirelessBtnStatic.disabled = true;
            });
        }
    </script>
</body>
</html>`;
}

/**
 * Safely escape a string for embedding inside a Python single-quoted string literal.
 */
function escapePy(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * Run a Python script string on the device and return stdout.
 * Writes a temp file, runs it via mpremote, then deletes the temp file.
 * @param {string} scriptContent  - Python source code
 * @param {string} tempName       - Temp filename (no spaces, no path separators)
 * @param {string} workspaceRoot  - Local folder to write the temp file into
 * @param {string} devicePort     - COM port or ws: address
 * @param {vscode.OutputChannel} outputChannel
 */
async function runDeviceScript(
  scriptContent,
  tempName,
  workspaceRoot,
  devicePort,
  outputChannel,
) {
  const tempPath = path.join(workspaceRoot, tempName);
  try {
    fs.writeFileSync(tempPath, scriptContent, "utf8");

    // ws: ports need mpremotesubpro.py — mpremote has no WebSocket transport
    if (devicePort && devicePort.startsWith("ws:")) {
      const venvPython = getVenvPythonPath(getVenvPythonPathFolder());
      const subpro = path.join(__dirname, "mpremotesubpro.py");
      return await new Promise((resolve) => {
        execFile(
          venvPython,
          [
            subpro,
            "--python",
            venvPython,
            "run_mcu",
            "--port",
            devicePort,
            "--file",
            tempPath,
          ],
          { timeout: 30000 },
          (_err, stdout) => resolve(stdout || ""),
        );
      });
    }

    const args = devicePort
      ? ["connect", devicePort, "run", `"${tempPath}"`]
      : ["run", `"${tempPath}"`];
    return await runMpremote(outputChannel, args);
  } finally {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
  }
}

/**
 * Open the Device Dashboard Webview Panel.
 * @param {vscode.ExtensionContext} context
 * @param {vscode.OutputChannel} outputChannel
 * @param {string} currentDevicePort  - COM port or ws: address
 * @param {function} onPortUpdate     - Optional callback(newPort) when user switches to wireless
 */
async function openDeviceDashboard(
  context,
  outputChannel,
  currentDevicePort,
  onPortUpdate,
) {
  if (!currentDevicePort) {
    vscode.window.showWarningMessage(
      'No device connected. Please run "Refresh Device Files" first.',
    );
    return;
  }

  // Track active port (may change to ws: during session)
  let activePort = currentDevicePort;

  const panel = vscode.window.createWebviewPanel(
    "deviceDashboard",
    `Device: ${currentDevicePort}`,
    vscode.ViewColumn.One,
    { enableScripts: true },
  );

  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showErrorMessage(
      "You must have a project workspace open to use the Dashboard.",
    );
    panel.dispose();
    return;
  }
  const workspaceRoot = workspaceFolders[0].uri.fsPath;

  // Loading screen
  panel.webview.html = `<!DOCTYPE html><html><head><style>
        body{background:#1a1a24;color:#fff;display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;gap:20px}
        .loader{border:4px solid rgba(255,255,255,0.1);border-top-color:#3b82f6;border-radius:50%;width:40px;height:40px;animation:spin 1s linear infinite}
        @keyframes spin{to{transform:rotate(360deg)}}
    </style></head><body><div class="loader"></div><div>Fetching telemetry from ${currentDevicePort}…</div></body></html>`;

  const updateDashboard = async () => {
    try {
      const metrics = await gatherDeviceMetrics(
        outputChannel,
        workspaceRoot,
        activePort,
      );

      // Read mcu from device.cfg for pinout fallback (used when device not connected)
      let mcuFromCfg = "";
      try {
        const cfgPath = path.join(workspaceRoot, "device.cfg");
        mcuFromCfg = (await getConfigValue(cfgPath, "device", "mcu")) || "";
      } catch (_) {}

      metrics.pinoutKey = resolvePinoutKey(metrics.platform, mcuFromCfg);
      panel.webview.html = getWebviewContent(metrics);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      panel.webview.html =
        '<body style="background:#1a1a24;color:#ef4444;padding:32px"><h2>Error</h2><p>' +
        errMsg +
        "</p></body>";
    }
  };

  // ── Message handler ───────────────────────────────────────────────────────
  panel.webview.onDidReceiveMessage(
    async (message) => {
      if (message.command === "refreshMetrics") {
        updateDashboard();
        return;
      }

      // ── Wi-Fi Scan ──────────────────────────────────────────────────────
      if (message.command === "scanWifi") {
        const script = `try:
    import network
    sta = network.WLAN(network.STA_IF)
    sta.active(True)
    nets = sta.scan()
    for n in nets:
        try:
            ssid = n[0].decode('utf-8','ignore').strip()
            rssi = n[3]
            if ssid:
                print(ssid + '|' + str(rssi))
        except:
            pass
except ImportError:
    import wifi
    for n in wifi.radio.start_scanning_networks():
        try:
            if n.ssid:
                print(str(n.ssid) + '|' + str(n.rssi))
        except:
            pass
    wifi.radio.stop_scanning_networks()
except Exception as e:
    print('ERROR|' + str(e))
`;
        try {
          const raw = await runDeviceScript(
            script,
            "_wifi_scan.py",
            workspaceRoot,
            activePort,
            outputChannel,
          );
          const networks = raw
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith("ERROR"))
            .map((l) => {
              const [ssid, rssi] = l.split("|");
              return { ssid: ssid || l, rssi: parseInt(rssi) || 0 };
            })
            .sort((a, b) => b.rssi - a.rssi); // strongest first
          panel.webview.postMessage({ command: "wifiResults", networks });
        } catch (err) {
          panel.webview.postMessage({
            command: "wifiConnectError",
            message: `Scan failed: ${err.message}`,
          });
        }
        return;
      }

      // ── Wi-Fi Connect ───────────────────────────────────────────────────
      if (message.command === "connectWifi") {
        const ssid = escapePy(message.ssid);
        const pwd = escapePy(message.password);
        const script = `try:
    import network, time
    sta = network.WLAN(network.STA_IF)
    sta.active(True)
    if sta.isconnected():
        sta.disconnect()
        time.sleep(1)
    sta.connect('${ssid}', '${pwd}')
    for i in range(15):
        if sta.isconnected():
            cfg = sta.ifconfig()
            print('OK|' + cfg[0])
            break
        time.sleep(1)
    else:
        print('FAIL|')
except ImportError:
    import wifi
    try:
        wifi.radio.connect('${ssid}', '${pwd}')
        print('OK|' + str(wifi.radio.ipv4_address))
    except Exception as e:
        print('FAIL|' + str(e))
except Exception as e:
    print('FAIL|' + str(e))
`;
        try {
          const raw = await runDeviceScript(
            script,
            "_wifi_connect.py",
            workspaceRoot,
            activePort,
            outputChannel,
          );
          const line =
            raw
              .split("\n")
              .find((l) => l.startsWith("OK|") || l.startsWith("FAIL|")) ||
            "FAIL|";
          const [status, ip] = line.split("|");
          panel.webview.postMessage({
            command: "wifiConnectDone",
            success: status === "OK",
            ip: ip || "",
            ssid: message.ssid,
          });
        } catch (err) {
          panel.webview.postMessage({
            command: "wifiConnectDone",
            success: false,
            ip: "",
            ssid: message.ssid,
          });
        }
        return;
      }

      // ── Wi-Fi Disconnect ────────────────────────────────────────────────
      if (message.command === "disconnectWifi") {
        const script = `try:
    import network
    sta = network.WLAN(network.STA_IF)
    sta.disconnect()
except ImportError:
    pass
print('OK')
`;
        try {
          await runDeviceScript(
            script,
            "_wifi_disconnect.py",
            workspaceRoot,
            activePort,
            outputChannel,
          );
        } catch (_) {}
        updateDashboard();
        return;
      }

      // ── Enable WebREPL ──────────────────────────────────────────────────
      // ── CircuitPython Web Workflow — detect IP from boot_out.txt ─────────
      if (message.command === "detectWebWorkflowIp") {
        const {
          findCircuitPyDrive: findDriveForIp,
        } = require("./circuitpyDrive");
        const drive = findDriveForIp();
        let ip = "";
        if (drive) {
          try {
            const bootOut = require("fs").readFileSync(
              require("path").join(drive, "boot_out.txt"),
              "utf8",
            );
            // CircuitPython writes lines like: "IP address: 192.168.1.x"
            const m = bootOut.match(
              /(?:IP\s+address|ip)[\s:]+(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/i,
            );
            if (m) ip = m[1];
          } catch (_) {}
        }
        if (ip) {
          const cfgPath = path.join(workspaceRoot, "device.cfg");
          await updateCfgComponent(cfgPath, "remote", "webworkflow_ip", ip);
        }
        panel.webview.postMessage({
          command: "webWorkflowIpDetected",
          ip,
          message: ip
            ? `✅ IP detected: ${ip} — saved to device.cfg.`
            : `⚠️ IP not found in boot_out.txt. Power-cycle the board and try again.`,
        });
        return;
      }

      // ── CircuitPython Web Workflow — save settings.toml ─────────────────
      if (message.command === "saveWebWorkflow") {
        const { writeSettingsToml } = require("./circuitpyWebWorkflow");
        const { findCircuitPyDrive } = require("./circuitpyDrive"); // eslint-disable-line no-shadow

        // Try to find the CIRCUITPY USB drive
        const drive = findCircuitPyDrive();
        if (!drive) {
          panel.webview.postMessage({
            command: "webWorkflowSaved",
            success: false,
            message:
              "CIRCUITPY drive not found. Make sure the USB cable is connected and the board is not in safe mode.",
          });
          return;
        }

        const result = /** @type {{ok:boolean, error?:string}} */ (
          /** @type {unknown} */ (
            writeSettingsToml(drive, {
              ssid: message.ssid,
              wifiPassword: message.wifiPassword,
              apiPassword: message.apiPassword,
              apiPort: message.apiPort || 80,
            })
          )
        );

        // Also persist Web Workflow credentials into device.cfg [remote] section
        if (result.ok) {
          const cfgPath = path.join(workspaceRoot, "device.cfg");
          await updateCfgComponent(cfgPath, "remote", "webworkflow_ip", "");
          await updateCfgComponent(
            cfgPath,
            "remote",
            "webworkflow_password",
            message.apiPassword,
          );
          await updateCfgComponent(
            cfgPath,
            "remote",
            "webworkflow_port",
            String(message.apiPort || 80),
          );
        }

        panel.webview.postMessage({
          command: "webWorkflowSaved",
          success: result.ok,
          message: result.ok
            ? `✅ settings.toml saved to ${drive} — power-cycle the board to connect.`
            : `❌ ${result.error}`,
        });
        return;
      }

      if (message.command === "enableWebrepl") {
        // CircuitPython does not support WebREPL — uses Web Workflow via settings.toml instead
        const cfgPathWr = path.join(workspaceRoot, "device.cfg");
        const fwType = await getConfigValue(
          cfgPathWr,
          "device",
          "device_firmware",
        ).catch(() => "");
        if (fwType === "CircuitPython") {
          panel.webview.postMessage({
            command: "wifiConnectError",
            message:
              "WebREPL is not supported on CircuitPython. Use Web Workflow via settings.toml instead.",
          });
          return;
        }

        let ssid = message.ssid || "";
        let password = message.password || "";

        // If credentials weren't sent from webview (board was already connected
        // when dashboard opened), ask the user now
        if (!ssid) {
          ssid = await vscode.window.showInputBox({
            prompt:
              "Enter your Wi-Fi network name (SSID) for auto-connect on boot",
            placeHolder: "e.g. MyHomeNetwork",
          });
          if (!ssid) {
            panel.webview.postMessage({ command: "webReplCancelled" });
            return;
          }
          password =
            (await vscode.window.showInputBox({
              prompt: `Enter password for "${ssid}"`,
              password: true,
              placeHolder: "Wi-Fi password",
            })) || "";
        }

        // Warning modal — user must explicitly confirm before boot.py is touched
        const confirmed = await vscode.window.showWarningMessage(
          `This will write boot.py on your device.\n\nOn every boot, the board will try to connect to "${ssid}" and start WebREPL.\n\nIf Wi-Fi is unavailable the board still starts normally — USB serial is never affected.\n\nTo undo at any time: Dashboard → Disable Remote Access`,
          { modal: true },
          "I understand — Enable Remote Access",
        );
        if (!confirmed) {
          panel.webview.postMessage({ command: "webReplCancelled" });
          return;
        }

        // Escape single quotes for embedding in Python string literals
        const safeSsid = ssid.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
        const safePassword = password
          .replace(/\\/g, "\\\\")
          .replace(/'/g, "\\'");

        // The safe boot.py template:
        //  • time.sleep(2) first — USB CDC initialises before any risky code runs
        //  • Full try/except — any crash is caught, USB serial stays alive
        //  • Writes mps_boot.log — Dashboard reads this to show last-boot status
        const bootPyContent = [
          "# MicroPython Studio - Remote Access Boot",
          "# To disable: Dashboard > Disable Remote Access",
          "import time",
          "time.sleep(2)  # USB CDC must be up before any network code runs",
          "",
          "def _log(msg):",
          "    try:",
          "        with open('mps_boot.log', 'w') as f:",
          "            f.write(msg)",
          "    except:",
          "        pass",
          "    print('[MPS]', msg)",
          "",
          "try:",
          "    import network",
          "    sta = network.WLAN(network.STA_IF)",
          "    sta.active(True)",
          `    sta.connect('${safeSsid}', '${safePassword}')`,
          "    for _ in range(15):",
          "        if sta.isconnected():",
          "            break",
          "        time.sleep(1)",
          "    if sta.isconnected():",
          "        ip = sta.ifconfig()[0]",
          "        import webrepl",
          "        webrepl.start()",
          "        _log('OK:' + ip)",
          "    else:",
          "        _log('WIFI_TIMEOUT:not available')",
          "except Exception as e:",
          "    _log('ERROR:' + str(e))",
        ].join("\\n");

        const script = `import network, sys
sta = network.WLAN(network.STA_IF)
ip = sta.ifconfig()[0] if sta.isconnected() else ''
try:
    # 1. Write webrepl password config
    with open('webrepl_cfg.py', 'w') as f:
        f.write("PASS = 'micro123'\\n")
    # 2. Write safe boot.py with USB-first delay and crash protection
    with open('boot.py', 'w') as f:
        f.write("""${bootPyContent}""")
    # 3. Start WebREPL for this session (evict stale cached modules first)
    for mod in ('webrepl_cfg', 'webrepl'):
        if mod in sys.modules:
            del sys.modules[mod]
    import webrepl
    webrepl.start()
    print('OK|' + ip)
except Exception as e:
    print('FAIL|' + str(e))
`;
        try {
          const raw = await runDeviceScript(
            script,
            "_webrepl_setup.py",
            workspaceRoot,
            activePort,
            outputChannel,
          );
          const line =
            raw
              .split("\n")
              .find((l) => l.startsWith("OK|") || l.startsWith("FAIL|")) ||
            "FAIL|";
          const [status, ipVal] = line.split("|");
          if (status === "OK") {
            panel.webview.postMessage({ command: "webReplEnabled", ip: ipVal });
          } else {
            panel.webview.postMessage({
              command: "wifiConnectError",
              message: `WebREPL failed: ${ipVal}`,
            });
          }
        } catch (err) {
          panel.webview.postMessage({
            command: "wifiConnectError",
            message: `WebREPL error: ${err.message}`,
          });
        }
        return;
      }

      // ── Disable Remote Access — writes a clean boot.py, removes config files ──
      if (message.command === "disableRemoteAccess") {
        const confirmed = await vscode.window.showWarningMessage(
          "This will overwrite boot.py on your device and disable automatic Wi-Fi / WebREPL on boot.",
          { modal: true },
          "Disable Remote Access",
        );
        if (!confirmed) return;

        const script = `import os
try:
    with open('boot.py', 'w') as f:
        f.write('# boot.py\\n# Remote access disabled by MicroPython Studio\\n')
    for f in ('webrepl_cfg.py', 'mps_boot.log'):
        try:
            os.remove(f)
        except:
            pass
    print('OK')
except Exception as e:
    print('FAIL|' + str(e))
`;
        try {
          const raw = await runDeviceScript(
            script,
            "_webrepl_disable.py",
            workspaceRoot,
            activePort,
            outputChannel,
          );
          if (raw.includes("OK")) {
            vscode.window.showInformationMessage(
              "Remote access disabled. The board will no longer auto-connect to Wi-Fi on boot.",
            );
            panel.webview.postMessage({ command: "remoteAccessDisabled" });
          }
        } catch (err) {
          vscode.window.showErrorMessage(
            `Failed to disable remote access: ${err.message}`,
          );
        }
        return;
      }

      // ── Switch to Wireless ──────────────────────────────────────────────
      if (message.command === "switchToWireless") {
        const wsPort = `ws:${message.ip},micro123`;
        activePort = wsPort;
        panel.title = `Device: ${wsPort}`;
        if (typeof onPortUpdate === "function") {
          onPortUpdate(wsPort);
        }

        // Persist WebREPL details to device.cfg so the extension
        // can auto-connect wirelessly next time — no USB required
        try {
          const cfgPath = path.join(workspaceRoot, "device.cfg");
          await updateCfgComponent(
            cfgPath,
            "remote",
            "webrepl_enabled",
            "true",
          );
          await updateCfgComponent(cfgPath, "remote", "webrepl_ip", message.ip);
          await updateCfgComponent(
            cfgPath,
            "remote",
            "webrepl_password",
            "micro123",
          );
        } catch (e) {
          console.error("Failed to save WebREPL details to device.cfg:", e);
        }

        vscode.window.showInformationMessage(
          `Switched to wireless: ${wsPort}. IP saved — extension will auto-connect next time.`,
        );
        return;
      }
    },
    undefined,
    context.subscriptions,
  );

  // Initial fetch
  updateDashboard();
}

module.exports = { openDeviceDashboard };
