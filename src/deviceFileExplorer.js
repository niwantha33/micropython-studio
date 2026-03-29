/**
 * deviceFileExplorer.js
 * TreeDataProvider that shows files stored on the MicroPython device.
 * Uses `mpremote fs ls` to list files and directories.
 * @license MIT
 * @version 1.0
 * @author  Niwantha Meepage
 */

const vscode = require('vscode');
const { exec } = require('child_process');
const { promisify } = require('util');
const os = require('os');
const fs = require('fs');
const pathMod = require('path');
const { getVenvPythonPathFolder, getVenvPythonPath } = require('./commonFxn');

const execAsync = promisify(exec);

/**
 * Represents a file or directory on the MicroPython device.
 */
class DeviceFileItem extends vscode.TreeItem {
    constructor(name, size, isDirectory, devicePath) {
        super(
            name,
            isDirectory
                ? vscode.TreeItemCollapsibleState.Collapsed
                : vscode.TreeItemCollapsibleState.None
        );

        this.devicePath = devicePath; // full path on device, e.g. '/main.py'
        this.isDirectory = isDirectory;
        this.size = size;

        if (isDirectory) {
            this.iconPath = new vscode.ThemeIcon('folder');
            this.contextValue = 'deviceFolder';
            this.tooltip = `📁 ${devicePath}`;
        } else {
            this.iconPath = this._getFileIcon(name);
            this.contextValue = 'deviceFile';
            this.tooltip = `📄 ${devicePath} (${this._formatSize(size)})`;
            this.description = this._formatSize(size);

            // Click to preview file contents
            this.command = {
                command: 'micropython-ide.readDeviceFile',
                title: 'Read File',
                arguments: [devicePath]
            };
        }
    }

    _getFileIcon(name) {
        if (name.endsWith('.py')) return new vscode.ThemeIcon('file-code');
        if (name.endsWith('.json')) return new vscode.ThemeIcon('json');
        if (name.endsWith('.txt') || name.endsWith('.log')) return new vscode.ThemeIcon('file-text');
        if (name.endsWith('.mpy')) return new vscode.ThemeIcon('file-binary');
        return new vscode.ThemeIcon('file');
    }

    _formatSize(bytes) {
        if (bytes === null || bytes === undefined) return '';
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }
}

/**
 * TreeDataProvider that queries the MicroPython device for its filesystem.
 */
class DeviceFileExplorerProvider {
    constructor() {
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
        this._port = null;
        this._cache = new Map(); // cache directory listings
    }

    /**
     * Set the TreeView instance so we can update its title dynamically.
     * @param {vscode.TreeView<vscode.TreeItem>} treeView
     */
    setTreeView(treeView) {
        this._treeView = treeView;
    }

    /**
     * Update the device port and refresh the tree.
     * @param {string|null} port
     * @param {string|null} deviceCodeDir
     * @param {boolean} isCircuitPython
     */
    setPort(port, deviceCodeDir = null, isCircuitPython = false) {
        this._port = port;
        this._deviceCodeDir = deviceCodeDir;
        this._isCircuitPython = isCircuitPython;
        this._cache.clear();
        if (this._treeView) {
            this._treeView.title = isCircuitPython ? 'Device Files (CircuitPython)' : 'Device Files (MicroPython)';
        }
        this._onDidChangeTreeData.fire();
    }

    /**
     * Force refresh the entire tree.
     */
    refresh() {
        this._cache.clear();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element) {
        return element;
    }

    async getChildren(element) {
        if (!this._port) {
            return [
                new vscode.TreeItem(
                    '$(plug) No device connected',
                    vscode.TreeItemCollapsibleState.None
                )
            ];
        }

        const dirPath = element ? element.devicePath : '/';
        return await this._listDeviceDir(dirPath);
    }

    /**
     * List files in a directory on the device using mpremote.
     * @param {string} dirPath - Directory path on device (e.g. '/' or '/lib')
     * @returns {Promise<DeviceFileItem[]>}
     */
    async _listDeviceDir(dirPath) {
        // Check cache first
        if (this._cache.has(dirPath)) {
            return this._cache.get(dirPath);
        }

        const venvFolder = getVenvPythonPathFolder();
        const venvPython = getVenvPythonPath(venvFolder);

        // If it's a CircuitPython project and we have a local drive path (e.g. E:\),
        // we can read it directly from the OS much faster and without mpremote errors!
        if (this._isCircuitPython && this._deviceCodeDir) {
            return new Promise((resolve) => {
                try {
                    // Map device path (e.g. '/lib') to the local drive path (e.g. 'E:\lib')
                    const localPath = dirPath === '/' 
                        ? this._deviceCodeDir 
                        : pathMod.join(this._deviceCodeDir, dirPath.replace(/^\//, '').replace(/\//g, pathMod.sep));
                    
                    const items = [];
                    const entries = fs.readdirSync(localPath, { withFileTypes: true });

                    for (const entry of entries) {
                        // Skip hidden system files that CircuitPython auto-creates or Windows adds
                        if (entry.name === 'System Volume Information' || entry.name.startsWith('._')) continue;

                        const isDir = entry.isDirectory();
                        const stat = fs.statSync(pathMod.join(localPath, entry.name));
                        const size = stat.size;
                        const fullPath = dirPath === '/' ? `/${entry.name}` : `${dirPath}/${entry.name}`;
                        
                        items.push(new DeviceFileItem(entry.name, isDir ? null : size, isDir, fullPath));
                    }

                    items.sort((a, b) => {
                        if (a.isDirectory && !b.isDirectory) return -1;
                        if (!a.isDirectory && b.isDirectory) return 1;
                        return String(a.label).localeCompare(String(b.label));
                    });

                    this._cache.set(dirPath, items);
                    resolve(items);
                } catch (error) {
                    console.error(`Local fs direct read error for CP: ${error.message}`);
                    const errItem = new vscode.TreeItem('$(warning) File system unavailable', vscode.TreeItemCollapsibleState.None);
                    resolve([/** @type {any} */ (errItem)]);
                }
            });
        }

        return new Promise((resolve) => {
            const cmd = `"${venvPython}" -m mpremote connect ${this._port} fs ls ${dirPath}`;

            exec(cmd, { timeout: 15000 }, (error, stdout) => {
                if (error) {
                    console.error(`Device ls error: ${error.message}`);
                    const errItem = new vscode.TreeItem(
                        '$(warning) Failed to read device files',
                        vscode.TreeItemCollapsibleState.None
                    );
                    errItem.tooltip = error.message;
                    resolve([/** @type {any} */ (errItem)]);
                    return;
                }

                const items = this._parseListOutput(stdout, dirPath);
                this._cache.set(dirPath, items);
                resolve(items);
            });
        });
    }

    /**
     * Parse the output of `mpremote fs ls`.
     * Format is typically:
     *   ls :
     *          136 boot.py
     *           34 main.py
     *          0 lib/
     *
     * @param {string} output - Raw stdout from mpremote
     * @param {string} parentPath - Parent directory path
     * @returns {DeviceFileItem[]}
     */
    _parseListOutput(output, parentPath) {
        const items = [];
        const lines = output.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('ls')) continue;

            // Match: "  136 boot.py" or "  0 lib/"
            const match = trimmed.match(/^\s*(\d+)\s+(.+)$/);
            if (match) {
                const size = parseInt(match[1], 10);
                let name = match[2].trim();
                const isDir = name.endsWith('/');

                if (isDir) {
                    name = name.slice(0, -1); // remove trailing /
                }

                // Build full device path
                const fullPath = parentPath === '/'
                    ? `/${name}`
                    : `${parentPath}/${name}`;

                items.push(new DeviceFileItem(name, isDir ? null : size, isDir, fullPath));
            }
        }

        // Sort: directories first, then files alphabetically
        items.sort((a, b) => {
            if (a.isDirectory && !b.isDirectory) return -1;
            if (!a.isDirectory && b.isDirectory) return 1;
            return String(a.label).localeCompare(String(b.label));
        });

        return items;
    }

    // ── Drag and Drop Controller ──────────────────────────────────────────────

    get dragMimeTypes() {
        return ['application/vnd.mps-device-file'];
    }

    get dropMimeTypes() {
        return ['application/vnd.mps-device-file'];
    }

    /**
     * Called when the user starts dragging a tree item.
     * We only allow dragging files (not folders — too risky to move recursively).
     */
    handleDrag(source, dataTransfer) {
        const files = source.filter(item => !item.isDirectory);
        if (files.length === 0) return;
        // Store the device paths of dragged files as JSON
        dataTransfer.set(
            'application/vnd.mps-device-file',
            new vscode.DataTransferItem(JSON.stringify(files.map(f => f.devicePath)))
        );
    }

    /**
     * Called when the user drops onto a tree item (or the root).
     * Moves each dragged file to the target directory.
     */
    async handleDrop(target, dataTransfer) {
        const item = dataTransfer.get('application/vnd.mps-device-file');
        if (!item) return;

        let sourcePaths;
        try {
            sourcePaths = JSON.parse(item.value);
        } catch (_) { return; }

        // Determine destination directory
        let destDir;
        if (!target) {
            destDir = '/';                        // dropped on empty area → root
        } else if (target.isDirectory) {
            destDir = target.devicePath;          // dropped on a folder
        } else {
            // dropped on a file → same directory as that file
            const parts = target.devicePath.split('/');
            parts.pop();
            destDir = parts.join('/') || '/';
        }

        // Normalise trailing slash
        if (destDir !== '/' && destDir.endsWith('/')) {
            destDir = destDir.slice(0, -1);
        }

        let moved = 0;
        for (const srcPath of sourcePaths) {
            const fileName = srcPath.split('/').pop();
            const destPath = destDir === '/' ? `/${fileName}` : `${destDir}/${fileName}`;

            if (srcPath === destPath) continue;   // already in that location

            try {
                if (this._isCircuitPython && this._deviceCodeDir) {
                    const localSrc = pathMod.join(this._deviceCodeDir, srcPath.replace(/^\//, '').replace(/\//g, pathMod.sep));
                    const localDest = pathMod.join(this._deviceCodeDir, destPath.replace(/^\//, '').replace(/\//g, pathMod.sep));
                    fs.renameSync(localSrc, localDest);
                } else {
                    await this._moveFileOnDevice(srcPath, destPath);
                }
                moved++;
            } catch (err) {
                vscode.window.showErrorMessage(
                    `Failed to move ${srcPath} → ${destPath}: ${err.message}`
                );
            }
        }

        if (moved > 0) {
            this.refresh();
        }
    }

    /**
     * Move a single file on the device using os.rename().
     * Writes a temp Python script to avoid shell-quoting issues on Windows.
     */
    _moveFileOnDevice(srcPath, destPath) {
        return new Promise((resolve, reject) => {
            const venvPython = getVenvPythonPath(getVenvPythonPathFolder());

            const code = [
                'import os',
                `os.rename(${JSON.stringify(srcPath)}, ${JSON.stringify(destPath)})`,
                "print('ok')"
            ].join('\n');

            const tmpFile = pathMod.join(os.tmpdir(), 'mps_move.py');
            fs.writeFileSync(tmpFile, code, 'utf8');

            const cmd = `"${venvPython}" -m mpremote connect ${this._port} run "${tmpFile}"`;
            exec(cmd, { timeout: 15000 }, (error, _stdout, stderr) => {
                try { fs.unlinkSync(tmpFile); } catch (_) {}
                if (error || (stderr && stderr.includes('Traceback'))) {
                    reject(new Error(stderr || error?.message || 'Unknown error'));
                } else {
                    resolve();
                }
            });
        });
    }
}

/**
 * Read a file from the device and show it in a VS Code editor.
 * @param {string} port - Device port
 * @param {string} deviceFilePath - Path on device (e.g. '/main.py')
 */
async function readDeviceFile(port, deviceFilePath) {
    if (!port) {
        vscode.window.showWarningMessage('No device connected.');
        return;
    }

    const venvFolder = getVenvPythonPathFolder();
    const venvPython = getVenvPythonPath(venvFolder);

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `Reading ${deviceFilePath} from device...`,
            cancellable: false
        },
        async () => {
            const cmd = `"${venvPython}" -m mpremote connect ${port} fs cat :${deviceFilePath}`;
            try {
                const { stdout } = await execAsync(cmd, { timeout: 15000, maxBuffer: 1024 * 1024 });
                const fileName = deviceFilePath.split('/').pop();
                const lang = fileName.endsWith('.py') ? 'python'
                           : fileName.endsWith('.json') ? 'json' : 'plaintext';
                const doc = await vscode.workspace.openTextDocument({ content: stdout, language: lang });
                await vscode.window.showTextDocument(doc, { preview: true });
            } catch (error) {
                vscode.window.showErrorMessage(`Failed to read ${deviceFilePath}: ${error.message}`);
            }
        }
    );
}

/**
 * Delete a file from the device.
 * @param {string} port - Device port
 * @param {string} deviceFilePath - Path on device
 * @param {DeviceFileExplorerProvider} provider - Provider to refresh after delete
 */
async function deleteDeviceFile(port, deviceFilePath, provider) {
    if (!port) {
        vscode.window.showWarningMessage('No device connected.');
        return;
    }

    const confirm = await vscode.window.showWarningMessage(
        `Delete "${deviceFilePath}" from device? This cannot be undone.`,
        { modal: true },
        'Delete'
    );

    if (confirm !== 'Delete') return;

    if (provider._isCircuitPython && provider._deviceCodeDir) {
        try {
            const localPath = pathMod.join(provider._deviceCodeDir, deviceFilePath.replace(/^\//, '').replace(/\//g, pathMod.sep));
            fs.unlinkSync(localPath);
            vscode.window.showInformationMessage(`Deleted ${deviceFilePath} from device.`);
            provider.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete ${deviceFilePath}: ${error.message}`);
        }
        return;
    }

    const venvFolder = getVenvPythonPathFolder();
    const venvPython = getVenvPythonPath(venvFolder);
    const cmd = `"${venvPython}" -m mpremote connect ${port} fs rm :${deviceFilePath}`;

    exec(cmd, { timeout: 15000 }, (error) => {
        if (error) {
            vscode.window.showErrorMessage(`Failed to delete ${deviceFilePath}: ${error.message}`);
        } else {
            vscode.window.showInformationMessage(`Deleted ${deviceFilePath} from device.`);
            provider.refresh();
        }
    });
}

/**
 * Recursively delete a folder from the device.
 * Uses `mpremote exec` to run a small Python snippet that walks and removes.
 * @param {string} port - Device port
 * @param {string} deviceFolderPath - Path on device (e.g. '/lib')
 * @param {DeviceFileExplorerProvider} provider - Provider to refresh after delete
 */
async function deleteDeviceFolder(port, deviceFolderPath, provider) {
    if (!port) {
        vscode.window.showWarningMessage('No device connected.');
        return;
    }

    const confirm = await vscode.window.showWarningMessage(
        `Delete folder "${deviceFolderPath}" and ALL its contents from device? This cannot be undone.`,
        { modal: true },
        'Delete'
    );
    if (confirm !== 'Delete') return;

    if (provider._isCircuitPython && provider._deviceCodeDir) {
        try {
            const localPath = pathMod.join(provider._deviceCodeDir, deviceFolderPath.replace(/^\//, '').replace(/\//g, pathMod.sep));
            fs.rmSync(localPath, { recursive: true, force: true });
            vscode.window.showInformationMessage(`Deleted folder ${deviceFolderPath} from device.`);
            provider.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete ${deviceFolderPath}: ${error.message}`);
        }
        return;
    }

    const venvFolder = getVenvPythonPathFolder();
    const venvPython = getVenvPythonPath(venvFolder);

    // Write the recursive-delete script to a temp file to avoid shell quoting issues
    const code = [
        'import os',
        'def _rm(p):',
        '    try:',
        '        for e in os.listdir(p):',
        '            _rm(p + "/" + e)',
        '        os.rmdir(p)',
        '    except OSError:',
        '        os.remove(p)',
        `_rm(${JSON.stringify(deviceFolderPath)})`,
        "print('ok')"
    ].join('\n');

    const tmpFile = pathMod.join(os.tmpdir(), 'mps_rmtree.py');
    fs.writeFileSync(tmpFile, code, 'utf8');

    const cmd = `"${venvPython}" -m mpremote connect ${port} run "${tmpFile}"`;

    exec(cmd, { timeout: 30000 }, (error, _stdout, stderr) => {
        try { fs.unlinkSync(tmpFile); } catch (_) {}
        if (error || (stderr && stderr.includes('Traceback'))) {
            const msg = stderr || error?.message || 'Unknown error';
            vscode.window.showErrorMessage(`Failed to delete ${deviceFolderPath}: ${msg}`);
        } else {
            vscode.window.showInformationMessage(`Deleted folder ${deviceFolderPath} from device.`);
            provider.refresh();
        }
    });
}

module.exports = {
    DeviceFileExplorerProvider,
    DeviceFileItem,
    readDeviceFile,
    deleteDeviceFile,
    deleteDeviceFolder
};
