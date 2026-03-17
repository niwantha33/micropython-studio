const vscode = require('vscode');
const https = require('https');
const { getVenvPythonPathFolder, getVenvPythonPath } = require('./commonFxn');

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
 * Opens a QuickPick UI allowing the user to search and select a package to install
 * @param {vscode.ExtensionContext} context 
 * @param {string} currentDevicePort The currently connected COM port (e.g. COM3)
 * @param {vscode.Terminal} terminal The active terminal to send the command to
 */
async function openPackageManager(context, currentDevicePort, terminal) {
    if (!currentDevicePort) {
        vscode.window.showWarningMessage('No device connected. Please connect a device and run "Refresh Device Files" first.');
        return;
    }

    if (!terminal) {
        vscode.window.showErrorMessage('Terminal is not available.');
        return;
    }

    try {
        // Show busy indicator while fetching
        const packages = await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "MicroPython Package Manager",
            cancellable: false
        }, async (progress) => {
            progress.report({ message: "Fetching package list from micropython.org..." });
            return await fetchPackageIndex();
        });

        if (packages.length === 0) {
            vscode.window.showInformationMessage('No packages found in the remote index.');
            return;
        }

        // Map list to QuickPick items
        const items = packages.map(pkg => ({
            label: `$(package) ${pkg.name}`,
            description: `v${pkg.version || '1.0.0'}`,
            // Provide a default description if it's missing
            detail: pkg.description || `Official micropython-lib package: ${pkg.name}`,
            pkgName: pkg.name
        }));

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Search for a MicroPython package to install (e.g. umqtt.simple, aioble)',
            matchOnDescription: true,
            matchOnDetail: true
        });

        if (selected) {
            const venvFolder = getVenvPythonPathFolder();
            const venvPython = getVenvPythonPath(venvFolder);

            // Command: mpremote connect <port> mip install <pkg>
            const installCmd = `"${venvPython}" -m mpremote connect ${currentDevicePort} mip install ${selected.pkgName}`;
            
            terminal.show();
            terminal.sendText(installCmd);
            vscode.window.showInformationMessage(`Installing ${selected.pkgName}... Check the terminal for progress.`);
        }
    } catch (err) {
        vscode.window.showErrorMessage(`Failed to load Package Manager: ${err.message}`);
    }
}

module.exports = { openPackageManager };
