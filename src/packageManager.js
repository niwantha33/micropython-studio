const vscode = require('vscode');
const https = require('https');
const path = require('path');
const { exec } = require('child_process');
const { getVenvPythonPathFolder, getVenvPythonPath } = require('./commonFxn');
const wsQueue = require('./wsQueue');


/**
 * Fetch the package index from micropython.org
 * @returns {Promise<Array<{name: string, description: string, version: string}>>}
 */
function fetchPackageIndex() {
    return new Promise((resolve, reject) => {
        https.get('https://micropython.org/pi/v2/index.json', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json.packages || []);
                } catch (e) {
                    reject(new Error('Failed to parse package index JSON: ' + e.message));
                }
            });
        }).on('error', (e) => reject(e));
    });
}

/**
 * Fetch the list of libraries available in the Digi XBee MicroPython repository
 * @returns {Promise<Array<{name: string, description: string, isDigi: boolean}>>}
 */
async function fetchXBeePackageIndex() {
    try {
        const url = 'https://api.github.com/repos/digidotcom/xbee-micropython/contents/lib';
        const data = await _fetchJSON(url);
        if (!Array.isArray(data)) return [];

        return data
            .filter(item => item.type === 'dir')
            .map(item => ({
                name: item.name,
                description: `Official Digi XBee library: ${item.name}`,
                isDigi: true
            }));
    } catch (err) {
        console.error('Failed to fetch XBee package index:', err);
        return [];
    }
}

/**
 * Opens a QuickPick UI allowing the user to search and select a package to install
 * @param {vscode.ExtensionContext} context 
 * @param {string} currentDevicePort The currently connected COM port (e.g. COM3)
 * @param {function} runProcess Function to run a python process (usually runPythonProcess)
 */
async function openPackageManager(context, currentDevicePort, runProcess) {
    if (!currentDevicePort) {
        vscode.window.showWarningMessage('No device connected. Please connect a device and run "Refresh Device Files" first.');
        return;
    }

    if (!runProcess) {
        vscode.window.showErrorMessage('Process runner is not available.');
        return;
    }

    try {
        // Show busy indicator while fetching
        const [standardPackages, xbeePackages] = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "MicroPython Package Manager",
            cancellable: false
        }, async (progress) => {
            progress.report({ message: "Fetching package lists..." });
            return await Promise.all([
                fetchPackageIndex().catch(() => []),
                fetchXBeePackageIndex().catch(() => [])
            ]);
        });

        if (standardPackages.length === 0 && xbeePackages.length === 0) {
            vscode.window.showInformationMessage('No packages found in remote indices.');
            return;
        }

        // Map list to QuickPick items
        const items = [
            ...xbeePackages.map(pkg => ({
                label: `$(package) ${pkg.name}`,
                description: `[XBee] Official`,
                detail: pkg.description,
                pkgName: pkg.name,
                isDigi: true
            })),
            ...standardPackages.map(pkg => ({
                label: `$(package) ${pkg.name}`,
                description: `v${pkg.version || '1.0.0'}`,
                detail: pkg.description || `Official micropython-lib package: ${pkg.name}`,
                pkgName: pkg.name,
                isDigi: false
            }))
        ];

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Search for a MicroPython package to install (e.g. umqtt.simple, aioble)',
            matchOnDescription: true,
            matchOnDetail: true
        });

        if (selected) {
            const venvFolder = getVenvPythonPathFolder();
            const venvPython = getVenvPythonPath(venvFolder);

            const answer = await vscode.window.showWarningMessage(
                `Ready to install "${selected.pkgName}" on device. This operation is queued and will run securely.`,
                { modal: true },
                'Install Now',
                'Cancel'
            );
            if (answer !== 'Install Now') return;

            const scriptPath = path.join(context.extensionPath, 'src', 'mps_backend.py');
            let mipArgs;
            if (selected.isDigi) {
                const pkgPath = `github:digidotcom/xbee-micropython/lib/${selected.pkgName}`;
                mipArgs = [scriptPath, '--python', venvPython, 'mip', '--port', currentDevicePort, '--package', pkgPath];
            } else {
                mipArgs = [scriptPath, '--python', venvPython, 'mip', '--port', currentDevicePort, '--package', selected.pkgName];
            }

            wsQueue.run(() => new Promise((resolve) => {
                runProcess(venvPython, mipArgs, resolve);
            }));

            vscode.window.showInformationMessage(`Installation of ${selected.pkgName} started. Check Output Panel for progress.`);
        }
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to load Package Manager: ${err.message}`);
    }
}

/**
 * Helper to perform an HTTPS GET request and return the JSON response.
 * @param {string} url 
 * @returns {Promise<any>}
 */
function _fetchJSON(url) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: { 'User-Agent': 'MicroPython-Studio-VSCode' }
        };
        https.get(url, options, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return _fetchJSON(res.headers.location).then(resolve).catch(reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`Failed to fetch ${url}: Status ${res.statusCode}`));
            }
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try { resolve(JSON.parse(data)); }
                catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

/**
 * Fetch the Adafruit and Community library bundles from GitHub releases.
 * @returns {Promise<Array<{name:string, description:string}>>}
 */
async function fetchCircuitPythonPackageIndex() {
    const bundles = [
        'adafruit/Adafruit_CircuitPython_Bundle',
        'adafruit/CircuitPython_Community_Bundle'
    ];
    
    let allPkgs = [];
    
    for (const repo of bundles) {
        try {
            const release = await _fetchJSON(`https://api.github.com/repos/${repo}/releases/latest`);
            // Find the JSON index asset
            const asset = release.assets.find(a => a.name.endsWith('.json') && !a.name.includes('version'));
            if (asset) {
                const indexData = await _fetchJSON(asset.browser_download_url);
                // The index is a dictionary where each key is a library name
                for (const name in indexData) {
                    allPkgs.push({
                        name: name,
                        description: indexData[name].description || `CircuitPython library: ${name}`
                    });
                }
            }
        } catch (err) {
            console.error(`Failed to fetch bundle from ${repo}: ${err.message}`);
        }
    }

    if (allPkgs.length === 0) {
        return _cpFallbackList();
    }

    // Sort alphabetically
    return allPkgs.sort((a, b) => a.name.localeCompare(b.name));
}

/** Curated fallback list if GitHub is unreachable */
function _cpFallbackList() {
    return [
        { name: 'adafruit_neopixel',        description: 'NeoPixel LED driver' },
        { name: 'adafruit_bus_device',       description: 'I2C/SPI bus device helper' },
        { name: 'adafruit_register',         description: 'Register abstractions' },
        { name: 'adafruit_dht',              description: 'DHT temperature/humidity sensor' },
        { name: 'adafruit_ssd1306',          description: 'SSD1306 OLED display' },
        { name: 'adafruit_bmp280',           description: 'BMP280 pressure/temperature sensor' },
        { name: 'adafruit_htu21d',           description: 'HTU21D humidity sensor' },
        { name: 'adafruit_motor',            description: 'DC/stepper motor control' },
        { name: 'adafruit_servokit',         description: 'PCA9685 servo kit' },
        { name: 'adafruit_requests',         description: 'HTTP requests for CircuitPython' },
        { name: 'adafruit_minimqtt',         description: 'MQTT client' },
        { name: 'adafruit_display_text',     description: 'Text rendering for displays' },
        { name: 'adafruit_imageload',        description: 'Image loading for displayio' },
        { name: 'adafruit_esp32spi',         description: 'ESP32 SPI WiFi co-processor' },
        { name: 'adafruit_pyportal',         description: 'PyPortal helper' },
    ];
}

/**
 * Opens the CircuitPython package manager using circup.
 * Detects USB drive or Web Workflow and builds the correct circup command.
 * @param {string|null} deviceCodeDir  Local code dir (used to find device.cfg)
 * @param {function} runProcess  runPythonProcess-style function(exe, args, onDone)
 * @param {function} findDrive   findCircuitPyDrive() from circuitpyDrive
 * @param {function} getConfig   getConfigValue(path, section, key)
 */
async function openCircuitPythonPackageManager(deviceCodeDir, runProcess, findDrive, getConfig, onAfterInstall) {
    // ── Resolve install target ─────────────────────────────────────────────────
    const drive   = findDrive ? findDrive() : null;

    // Read Web Workflow config from device.cfg
    let wwIp = '', wwPass = '', wwPort = '80';
    if (!drive && deviceCodeDir) {
        const cfgPath = path.join(path.dirname(deviceCodeDir), 'device.cfg');
        try {
            wwIp   = await getConfig(cfgPath, 'remote', 'webworkflow_ip')   || '';
            wwPass = await getConfig(cfgPath, 'remote', 'webworkflow_password') || '';
            wwPort = await getConfig(cfgPath, 'remote', 'webworkflow_port')  || '80';
        } catch (_) {}
    }

    if (!drive && !wwIp) {
        vscode.window.showErrorMessage(
            'No CircuitPython device found.\n' +
            'Connect via USB (CIRCUITPY drive) or configure Wi-Fi in the Dashboard.'
        );
        return;
    }

    const targetLabel = drive
        ? `USB drive (${drive})`
        : `Wi-Fi (${wwIp}:${wwPort})`;

    // ── Build circup path ──────────────────────────────────────────────────────
    const venvFolder = getVenvPythonPathFolder();
    const isWin  = process.platform === 'win32';
    const circup = path.join(venvFolder, isWin ? 'Scripts' : 'bin', isWin ? 'circup.exe' : 'circup');

    // ── Fetch package list ─────────────────────────────────────────────────────
    const packages = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'CircuitPython Package Manager',
        cancellable: false
    }, async (progress) => {
        progress.report({ message: 'Fetching complete library list (may take a few seconds)...' });
        
        // Ensure circup is installed 
        const venvPython = getVenvPythonPath(venvFolder);
        await new Promise(r => exec(`"${venvPython}" -m pip install circup`, () => r()));
        
        return await fetchCircuitPythonPackageIndex();
    });

    const items = packages.map(pkg => ({
        label:    `$(package) ${pkg.name}`,
        detail:   pkg.description || 'Adafruit CircuitPython library',
        pkgName:  pkg.name
    }));

    const selected = await vscode.window.showQuickPick(items, {
        placeHolder: `Search for a CircuitPython library to install on ${targetLabel}`,
        matchOnDetail: true
    });
    if (!selected) return;

    // ── Build circup command args ──────────────────────────────────────────────
    /** @type {string[]} */
    const circupArgs = [];

    if (drive) {
        circupArgs.push('--path', drive);
    } else {
        circupArgs.push('--host', wwIp, '--password', wwPass);
        if (wwPort && wwPort !== '80') circupArgs.push('--port', wwPort);
    }

    circupArgs.push('install', selected.pkgName);

    const confirmed = await vscode.window.showWarningMessage(
        `Install "${selected.pkgName}" on ${targetLabel}?\n\n` +
        `⚠️ Make sure code is NOT running on the device before installing.\n` +
        `Press the Stop button (or Ctrl+C in the REPL) first — CircuitPython locks the filesystem while code.py is active.`,
        { modal: true },
        'Install',
        'Cancel'
    );
    if (confirmed !== 'Install') return;

    runProcess(circup, circupArgs, onAfterInstall || null);
    vscode.window.showInformationMessage(`Installing ${selected.pkgName}… check the output panel.`);
}

module.exports = { openPackageManager, openCircuitPythonPackageManager };
