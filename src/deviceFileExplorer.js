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
const fs = require('fs');
const pathMod = require('path');
const { getVenvPythonPathFolder, getVenvPythonPath } = require('./commonFxn');
const wsQueue = require('./wsQueue');

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
        const isLocalDrive = this._deviceCodeDir && /^[A-Za-z]:[/\\]?$/.test(this._deviceCodeDir.replace(/[/\\]+$/, '') + '\\');
        if (this._isCircuitPython && isLocalDrive) {
            try {
                // Map device path (e.g. '/lib') to the local drive path (e.g. 'E:\lib')
                const localPath = dirPath === '/' 
                    ? this._deviceCodeDir 
                    : pathMod.join(this._deviceCodeDir, dirPath.replace(/^\//, '').replace(/\//g, pathMod.sep));
                
                const items = [];
                const entries = fs.readdirSync(localPath, { withFileTypes: true });

                for (const entry of entries) {
                    // Skip hidden system files that CircuitPython auto-creates or Windows adds
                    if (entry.name === 'System Volume Information' || entry.name.startsWith('._') || entry.name.startsWith('.$')) continue;

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
                return items;
            } catch (error) {
                console.error(`Local fs direct read error for CP: ${error.message} - falling back to serial REPL`);
                // fall through to mpremote serial logic below
            }
        }

        const lsOp = async () => {
            const connectionManager = require('./connectionManager');
            if (connectionManager.isConnected && !connectionManager.isSuspended) {
                try {
                    const stdout = await connectionManager.listDir(dirPath);
                    const items = this._parseListOutput(stdout, dirPath);
                    this._cache.set(dirPath, items);
                    return items;
                } catch (err) {
                    console.error(`Direct ls error: ${err.message}`);
                    const errItem = new vscode.TreeItem('$(warning) Failed to read device files', vscode.TreeItemCollapsibleState.None);
                    errItem.tooltip = err.message;
                    return [/** @type {any} */ (errItem)];
                }
            }

            const scriptPath = pathMod.join(__dirname, 'mps_backend.py');
            const cmd = `"${venvPython}" "${scriptPath}" --python "${venvPython}" ls --port "${this._port}" --path "${dirPath}"`;

            let attempts = 0;
            const maxAttempts = 3;

            while (attempts < maxAttempts) {
                const result = await new Promise((resolve) => {
                    exec(cmd, { timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
                        if (error) {
                            const errStr = stderr || error.message;
                            if (errStr.includes('BUSY') && attempts < maxAttempts - 1) {
                                resolve({ retry: true });
                            } else {
                                resolve({ error: errStr });
                            }
                        } else {
                            resolve({ success: true, stdout });
                        }
                    });
                });

                if (result.success) {
                    const items = this._parseListOutput(result.stdout, dirPath);
                    if (items.length === 0 && result.stdout.trim().length > 0) {
                        const warnItem = new vscode.TreeItem('$(error) Parse error (see log)', vscode.TreeItemCollapsibleState.None);
                        warnItem.tooltip = `Raw output: ${result.stdout}`;
                        return [/** @type {any} */ (warnItem)];
                    }
                    this._cache.set(dirPath, items);
                    return items;
                } else if (result.retry) {
                    attempts++;
                    console.warn(`Port ${this._port} is busy. Retry ${attempts}/${maxAttempts} in 1s...`);
                    await new Promise(r => setTimeout(r, 1000));
                    continue;
                } else {
                    console.error(`Device ls error: ${result.error}`);
                    const errItem = new vscode.TreeItem('$(warning) Failed to read device files', vscode.TreeItemCollapsibleState.None);
                    errItem.tooltip = result.error;
                    return [/** @type {any} */ (errItem)];
                }
            }
        };

        return wsQueue.run(lsOp, 'List Files', true);
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
            // Skip headers, empty lines, and noisy prompts
            if (!trimmed || trimmed.startsWith('ls') || trimmed === '>>>') continue;

            if (trimmed.includes('|')) {
                const parts = trimmed.split('|');
                if (parts.length === 3) {
                    const name = parts[0];
                    const isDir = parts[1] === 'True';
                    const size = parseInt(parts[2], 10);
                    const fullPath = parentPath === '/' ? `/${name}` : `${parentPath}/${name}`;
                    items.push(new DeviceFileItem(name, isDir ? null : size, isDir, fullPath));
                    continue;
                }
            }

            // Robust Matcher: handles "   136 boot.py" or " 0 lib/" or "1024 data.bin"
            // Captures digits (size), then whitespace, then everything else (name)
            const match = trimmed.match(/^(\d+)\s+(.+)$/);
            if (match) {
                const size = parseInt(match[1], 10);
                let name = match[2].trim();
                const isDir = name.endsWith('/');

                if (isDir) {
                    name = name.slice(0, -1);
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
     * Routes WS ports through mps_backend.py mv to avoid mpremote WS limitation.
     * Routes all ports through mps_backend.py mv to avoid mpremote WS limitation and DTR resets.
     */
    _moveFileOnDevice(srcPath, destPath) {
        return new Promise((resolve, reject) => {
            const connectionManager = require('./connectionManager');
            if (connectionManager.isConnected && !connectionManager.isSuspended) {
                wsQueue.run(() => connectionManager.renameFile(srcPath, destPath), 'Rename/Move', true).then(resolve, reject);
                return;
            }
            const venvPython = getVenvPythonPath(getVenvPythonPathFolder());
            const scriptPath = pathMod.join(__dirname, 'mps_backend.py');
            const cmd = `"${venvPython}" "${scriptPath}" --python "${venvPython}" mv --port "${this._port}" --src "${srcPath}" --dest "${destPath}"`;

            const moveOp = () => new Promise((res, rej) => {
                exec(cmd, { timeout: 15000 }, (error, _stdout, stderr) => {
                    if (error || (stderr && stderr.includes('Traceback'))) {
                        rej(new Error(stderr || error?.message || 'Unknown error'));
                    } else {
                        res();
                    }
                });
            });
            wsQueue.run(moveOp).then(resolve, reject);
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
            try {
                let content;
                const connectionManager = require('./connectionManager');
                if (connectionManager.isConnected && !connectionManager.isSuspended) {
                    content = await wsQueue.run(() => connectionManager.catFile(deviceFilePath), 'Read File', true);
                } else {
                    const scriptPath = pathMod.join(__dirname, 'mps_backend.py');
                    const cmd = `"${venvPython}" "${scriptPath}" --python "${venvPython}" cat --port "${port}" --path "${deviceFilePath}"`;
                    const execOp = () => execAsync(cmd, { timeout: 15000, maxBuffer: 1024 * 1024 });
                    const { stdout } = await wsQueue.run(execOp);
                    content = Buffer.from(stdout);
                }
                const fileName = deviceFilePath.split('/').pop();
                const lang = fileName.endsWith('.py') ? 'python'
                           : fileName.endsWith('.json') ? 'json' : 'plaintext';
                const doc = await vscode.workspace.openTextDocument({ content: content.toString('utf8'), language: lang });
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

    const connectionManager = require('./connectionManager');
    if (connectionManager.isConnected && !connectionManager.isSuspended) {
        try {
            await wsQueue.run(() => connectionManager.deleteFile(deviceFilePath, false), 'Delete File', true);
            vscode.window.showInformationMessage(`Deleted ${deviceFilePath} from device.`);
            provider.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete ${deviceFilePath}: ${error.message}`);
        }
        return;
    }

    const venvFolder = getVenvPythonPathFolder();
    const venvPython = getVenvPythonPath(venvFolder);
    const scriptPath = pathMod.join(__dirname, 'mps_backend.py');

    const cmd = `"${venvPython}" "${scriptPath}" --python "${venvPython}" rm --port "${port}" --path "${deviceFilePath}"`;

    const rmOp = () => new Promise((resolve) => {
        exec(cmd, { timeout: 15000 }, (error) => {
            if (error) {
                vscode.window.showErrorMessage(`Failed to delete ${deviceFilePath}: ${error.message}`);
            } else {
                vscode.window.showInformationMessage(`Deleted ${deviceFilePath} from device.`);
                provider.refresh();
            }
            resolve();
        });
    });

    wsQueue.run(rmOp);
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

    const connectionManager = require('./connectionManager');
    if (connectionManager.isConnected && !connectionManager.isSuspended) {
        try {
            await wsQueue.run(() => connectionManager.deleteFile(deviceFolderPath, true), 'Delete Folder', true);
            vscode.window.showInformationMessage(`Deleted folder ${deviceFolderPath} from device.`);
            provider.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to delete ${deviceFolderPath}: ${error.message}`);
        }
        return;
    }

    const venvFolder = getVenvPythonPathFolder();
    const venvPython = getVenvPythonPath(venvFolder);
    const scriptPath = pathMod.join(__dirname, 'mps_backend.py');

    const cmd = `"${venvPython}" "${scriptPath}" --python "${venvPython}" rm --port "${port}" --path "${deviceFolderPath}" --recursive`;

    const rmTreeOp = () => new Promise((resolve) => {
        exec(cmd, { timeout: 30000 }, (error, _stdout, stderr) => {
            if (error || (stderr && stderr.includes('Traceback'))) {
                const msg = stderr || error?.message || 'Unknown error';
                vscode.window.showErrorMessage(`Failed to delete ${deviceFolderPath}: ${msg}`);
            } else {
                vscode.window.showInformationMessage(`Deleted folder ${deviceFolderPath} from device.`);
                provider.refresh();
            }
            resolve();
        });
    });

    return wsQueue.run(rmTreeOp);
}

/**
 * Rename a file or folder on the device.
 */
async function renameDeviceFile(port, oldPath, provider) {
    if (!port) return;

    const newName = await vscode.window.showInputBox({
        prompt: `Enter new name for ${oldPath.split('/').pop()}`,
        value: oldPath.split('/').pop()
    });

    if (!newName) return;

    const parent = oldPath.split('/').slice(0, -1).join('/') || '/';
    const newPath = parent === '/' ? `/${newName}` : `${parent}/${newName}`;

    const connectionManager = require('./connectionManager');
    if (connectionManager.isConnected && !connectionManager.isSuspended) {
        try {
            await wsQueue.run(() => connectionManager.renameFile(oldPath, newPath), 'Rename/Move', true);
            provider.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Rename failed: ${error.message}`);
        }
        return;
    }

    const venvPython = getVenvPythonPath(getVenvPythonPathFolder());
    const scriptPath = pathMod.join(__dirname, 'mps_backend.py');
    const cmd = `"${venvPython}" "${scriptPath}" --python "${venvPython}" rename --port "${port}" --src "${oldPath}" --dest "${newPath}"`;

    await wsQueue.run(() => new Promise((resolve) => {
        exec(cmd, (error) => {
            if (error) {
                vscode.window.showErrorMessage(`Rename failed: ${error.message}`);
            } else {
                provider.refresh();
            }
            resolve();
        });
    }));
}

/**
 * Upload a file from PC directly into a specific folder on the device.
 */
async function uploadToDeviceFolder(port, targetFolder, provider) {
    if (!port) return;

    const files = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Upload to Device'
    });

    if (!files || files.length === 0) return;

    const connectionManager = require('./connectionManager');
    if (connectionManager.isConnected && !connectionManager.isSuspended) {
        for (const file of files) {
            try {
                const destPath = targetFolder === '/' ? `/${pathMod.basename(file.fsPath)}` : `${targetFolder}/${pathMod.basename(file.fsPath)}`;
                const buffer = fs.readFileSync(file.fsPath);
                await wsQueue.run(() => connectionManager.writeFile(destPath, buffer), 'Upload File', true);
            } catch (error) {
                vscode.window.showErrorMessage(`Upload failed: ${error.message}`);
            }
        }
        provider.refresh();
        return;
    }

    const venvPython = getVenvPythonPath(getVenvPythonPathFolder());
    const scriptPath = pathMod.join(__dirname, 'mps_backend.py');

    for (const file of files) {
        const cmd = `"${venvPython}" "${scriptPath}" --python "${venvPython}" upload --port "${port}" --source "${file.fsPath}" --dest "${targetFolder}" --overwrite`;
        await wsQueue.run(() => new Promise((resolve) => {
            exec(cmd, (error) => {
                if (error) {
                    vscode.window.showErrorMessage(`Upload failed: ${error.message}`);
                }
                resolve();
            });
        }));
    }
    provider.refresh();
}

/**
 * Create a new folder on the device.
 */
async function newDeviceFolder(port, parentPath, provider) {
    if (!port) return;

    const folderName = await vscode.window.showInputBox({
        prompt: `New folder name in ${parentPath}`,
        placeHolder: 'folder_name'
    });

    if (!folderName) return;

    const newPath = parentPath === '/' ? `/${folderName}` : `${parentPath}/${folderName}`;

    const connectionManager = require('./connectionManager');
    if (connectionManager.isConnected && !connectionManager.isSuspended) {
        try {
            await wsQueue.run(() => connectionManager.makeDir(newPath), 'Create Folder', true);
            provider.refresh();
        } catch (error) {
            vscode.window.showErrorMessage(`Failed to create folder: ${error.message}`);
        }
        return;
    }

    const venvPython = getVenvPythonPath(getVenvPythonPathFolder());
    const scriptPath = pathMod.join(__dirname, 'mps_backend.py');
    const cmd = `"${venvPython}" "${scriptPath}" --python "${venvPython}" mkdir --port "${port}" --path "${newPath}"`;

    await wsQueue.run(() => new Promise((resolve) => {
        exec(cmd, (error) => {
            if (error) {
                vscode.window.showErrorMessage(`Failed to create folder: ${error.message}`);
            } else {
                provider.refresh();
            }
            resolve();
        });
    }));
}

module.exports = {
    DeviceFileExplorerProvider,
    DeviceFileItem,
    readDeviceFile,
    deleteDeviceFile,
    deleteDeviceFolder,
    renameDeviceFile,
    uploadToDeviceFolder,
    newDeviceFolder
};
