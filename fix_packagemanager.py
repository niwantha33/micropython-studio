import sys

with open('c:/My-Projects/micropython-studio-py/micropython-studio/src/packageManager.js', 'r', encoding='utf-8') as f:
    content = f.read()

old_1 = "const path = require('path');"
new_1 = "const path = require('path');\nconst { exec } = require('child_process');\nconst { getVenvPythonPathFolder, getVenvPythonPath } = require('./commonFxn');"
content = content.replace("const { getVenvPythonPathFolder, getVenvPythonPath } = require('./commonFxn');", "") # remove the original
content = content.replace(old_1, new_1)

old_2 = '''function fetchCircuitPythonPackageIndex() {
    return new Promise((resolve) => {
        https.get('https://raw.githubusercontent.com/adafruit/Adafruit_CircuitPython_Bundle/refs/heads/main/circuitpython_library_list.md', (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                // Parse markdown table rows: | adafruit_neopixel | ... |
                const pkgs = [];
                for (const line of data.split('\\n')) {
                    const m = line.match(/^\\|\\s*\?([a-zA-Z0-9_\\-]+)\?\\s*\\|/);
                    if (m && !m[1].startsWith('Library')) {
                        pkgs.push({ name: m[1], description: '' });
                    }
                }
                resolve(pkgs.length > 0 ? pkgs : _cpFallbackList());
            });
        }).on('error', () => resolve(_cpFallbackList()));
    });
}'''

new_2 = '''function fetchCircuitPythonPackageIndex(circupExe) {
    return new Promise((resolve) => {
        exec("" show, { maxBuffer: 1024 * 1024 * 5 }, (error, stdout) => {
            if (error) {
                console.error('circup show error:', error.message);
                return resolve(_cpFallbackList());
            }
            const pkgs = [];
            for (const line of stdout.split('\\n')) {
                const trimmed = line.trim();
                const match = trimmed.match(/^([a-zA-Z0-9_\-]+)\\s+\\((.+?)\\)$/);
                if (match) {
                    pkgs.push({ name: match[1], description: Version:  });
                }
            }
            resolve(pkgs.length > 0 ? pkgs : _cpFallbackList());
        });
    });
}'''

content = content.replace(old_2, new_2)

old_3 = '''    // ── Fetch package list ─────────────────────────────────────────────────────
    const packages = await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'CircuitPython Package Manager',
        cancellable: false
    }, async (progress) => {
        progress.report({ message: 'Fetching Adafruit bundle library list…' });
        return await fetchCircuitPythonPackageIndex();
    });'''

new_3 = '''    // ── Build circup path ──────────────────────────────────────────────────────
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
        await new Promise(r => exec("" -m pip install circup, () => r()));
        
        return await fetchCircuitPythonPackageIndex(circup);
    });'''

content = content.replace(old_3, new_3)

old_4 = '''    // ── Build circup command args ──────────────────────────────────────────────
    const venvFolder = getVenvPythonPathFolder();
    const isWin  = process.platform === 'win32';
    const circup = path.join(venvFolder, isWin ? 'Scripts' : 'bin', isWin ? 'circup.exe' : 'circup');

    /** @type {string[]} */
    const circupArgs = [];'''

new_4 = '''    // ── Build circup command args ──────────────────────────────────────────────
    /** @type {string[]} */
    const circupArgs = [];'''

content = content.replace(old_4, new_4)

with open('c:/My-Projects/micropython-studio-py/micropython-studio/src/packageManager.js', 'w', encoding='utf-8') as f:
    f.write(content)

print('Success')
