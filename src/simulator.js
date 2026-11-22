const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { spawn, execFile } = require('child_process');
const { getVenvPythonPath, getVenvPythonPathFolder } = require('./commonFxn');
const https = require('https');

let qemuProcess = null;

// Simulator downloads are allowed only over HTTPS from the approved release hosts.
const TRUSTED_DOWNLOAD_HOSTS = new Set([
    'github.com', 'raw.githubusercontent.com',
    'objects.githubusercontent.com', 'release-assets.githubusercontent.com',
    'github-releases.githubusercontent.com'
]);
const MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024;

function downloadFile(url, dest, redirects = 5) {
    return new Promise((resolve, reject) => {
        let target;
        try { target = new URL(url); }
        catch (error) { reject(error); return; }
        if (target.protocol !== 'https:' || !TRUSTED_DOWNLOAD_HOSTS.has(target.hostname)) {
            reject(new Error('Simulator download URL is not an approved HTTPS host'));
            return;
        }
        const request = https.get(target, (response) => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode) &&
                response.headers.location && redirects > 0) {
                response.resume();
                resolve(downloadFile(new URL(response.headers.location, target).toString(), dest, redirects - 1));
                return;
            }
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error('Simulator download returned HTTP ' + response.statusCode));
                return;
            }
            const length = Number(response.headers['content-length'] || 0);
            if (length > MAX_DOWNLOAD_BYTES) {
                response.destroy();
                reject(new Error('Simulator artifact exceeds download limit'));
                return;
            }
            const temporary = dest + '.partial';
            const output = fs.createWriteStream(temporary, { flags: 'w' });
            let settled = false;
            let size = 0;
            const fail = (error) => {
                if (settled) return;
                settled = true;
                output.destroy();
                response.destroy();
                fs.rm(temporary, { force: true }, () => reject(error));
            };
            response.on('data', chunk => {
                size += chunk.length;
                if (size > MAX_DOWNLOAD_BYTES) fail(new Error('Simulator artifact exceeded download limit'));
            });
            response.on('error', fail);
            output.on('error', fail);
            output.on('finish', () => {
                if (settled) return;
                settled = true;
                output.close(err => {
                    if (err) { fs.rm(temporary, { force: true }, () => reject(err)); return; }
                    fs.rename(temporary, dest, renameErr => {
                        if (renameErr) fs.rm(temporary, { force: true }, () => reject(renameErr));
                        else resolve(dest);
                    });
                });
            });
            response.pipe(output);
        });
        request.setTimeout(30000, () => request.destroy(new Error('Simulator download timed out')));
        request.on('error', reject);
    });
}

// Use Python's validated ZIP extractor, not a shell or unvalidated unzip.
function extractZip(zipPath, destDir) {
    return new Promise((resolve, reject) => {
        const python = getVenvPythonPath(getVenvPythonPathFolder());
        if (!fs.existsSync(python)) {
            reject(new Error('Set up the MicroPython Studio Python environment before starting the simulator.'));
            return;
        }
        const extractor = path.join(__dirname, 'safe_extract.py');
        execFile(python, [extractor, zipPath, destDir], {
            timeout: 120000,
            maxBuffer: 1024 * 1024,
            windowsHide: true
        }, (error, _stdout, stderr) => {
            if (error) reject(new Error('Simulator archive rejected: ' + (stderr || error.message).trim().slice(0, 500)));
            else resolve();
        });
    });
}

async function startSimulator(context, outputChannel, onConnect, onExit) {
    if (qemuProcess) {
        vscode.window.showInformationMessage('Simulator is already running.');
        return;
    }

    const binDir = path.join(context.extensionPath, 'bin');
    const qemuDir = path.join(binDir, 'qemu');
    let qemuBin = '';

    if (process.platform === 'win32') {
        qemuBin = path.join(qemuDir, 'qemu-system-arm.exe');
    } else {
        qemuBin = path.join(qemuDir, 'qemu-system-arm');
    }

    const firmwarePath = path.join(binDir, 'qemu_firmware.elf');

    // 1. Download and extract QEMU if missing
    if (!fs.existsSync(qemuBin)) {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Downloading QEMU simulator (portable)...',
            cancellable: false
        }, async (progress) => {
            if (!fs.existsSync(binDir)) {
                fs.mkdirSync(binDir, { recursive: true });
            }
            const zipPath = path.join(binDir, 'qemu.zip');
            let url = '';
            if (process.platform === 'win32') {
                url = 'https://github.com/niwantha33/micropython_live_dbg_firmware/raw/main/qemu/qemu-portable-win32.zip';
            } else if (process.platform === 'darwin') {
                url = 'https://github.com/niwantha33/micropython_live_dbg_firmware/raw/main/qemu/qemu-portable-macos.zip';
            } else {
                url = 'https://github.com/niwantha33/micropython_live_dbg_firmware/raw/main/qemu/qemu-portable-linux.zip';
            }

            outputChannel.appendLine(`Downloading QEMU from ${url}...`);
            await downloadFile(url, zipPath);
            outputChannel.appendLine(`Extracting QEMU to ${qemuDir}...`);
            progress.report({ message: 'Extracting...' });
            await extractZip(zipPath, qemuDir);
            try { fs.unlinkSync(zipPath); } catch (_) {}
            
            // Set executable permission on non-Windows
            if (process.platform !== 'win32') {
                fs.chmodSync(qemuBin, '755');
            }
        });
    }

    // 2. Download firmware if missing
    if (!fs.existsSync(firmwarePath)) {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Downloading emulation firmware...',
            cancellable: false
        }, async () => {
            const url = 'https://github.com/niwantha33/micropython_live_dbg_firmware/raw/main/qemu/firmware.elf';
            outputChannel.appendLine(`Downloading firmware from ${url}...`);
            await downloadFile(url, firmwarePath);
        });
    }

    // 3. Launch QEMU
    outputChannel.appendLine('Launching QEMU MicroPython simulator...');
    const args = [
        '-machine', 'mps2-an385',
        '-cpu', 'cortex-m3',
        '-kernel', firmwarePath,
        '-serial', 'tcp:127.0.0.1:4444,server,nowait',
        '-nographic',
        '-monitor', 'null',
        '-semihosting'
    ];

    qemuProcess = spawn(qemuBin, args, { cwd: binDir });

    qemuProcess.stdout.on('data', (d) => {
        outputChannel.append(`[QEMU STDOUT] ${d}`);
    });

    qemuProcess.stderr.on('data', (d) => {
        outputChannel.append(`[QEMU STDERR] ${d}`);
    });

    qemuProcess.on('close', (code) => {
        outputChannel.appendLine(`QEMU exited with code ${code}`);
        qemuProcess = null;
        if (onExit) {
            onExit();
        }
    });

    // 4. Automatically connect
    setTimeout(async () => {
        const tcpPort = 'tcp:127.0.0.1:4444';
        await onConnect(tcpPort);
        vscode.window.showInformationMessage('Pico 2 W Simulator started and connected successfully!');
    }, 1500);
}

function stopSimulator() {
    if (qemuProcess) {
        qemuProcess.kill();
        qemuProcess = null;
        vscode.window.showInformationMessage('Simulator stopped.');
    }
}

module.exports = {
    startSimulator,
    stopSimulator
};
