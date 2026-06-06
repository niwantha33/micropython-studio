const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const https = require('https');

let qemuProcess = null;

// Helper to download files following redirects
function downloadFile(url, dest, redirects = 5) {
    return new Promise((resolve, reject) => {
        const req = https.get(url, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
                res.resume();
                return resolve(downloadFile(res.headers.location, dest, redirects - 1));
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error('HTTP ' + res.statusCode));
            }
            const file = fs.createWriteStream(dest);
            res.pipe(file);
            file.on('finish', () => file.close(() => resolve(dest)));
            file.on('error', reject);
        });
        req.on('error', reject);
        req.setTimeout(30000, () => req.destroy(new Error('timeout')));
    });
}

// Helper to extract a zip file natively
function extractZip(zipPath, destDir) {
    return new Promise((resolve, reject) => {
        if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
        }
        let cmd = '';
        if (process.platform === 'win32') {
            cmd = `powershell -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`;
        } else {
            cmd = `unzip -o "${zipPath}" -d "${destDir}"`;
        }
        exec(cmd, (error) => {
            if (error) reject(error);
            else resolve();
        });
    });
}

async function startSimulator(context, outputChannel, onConnect) {
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
        '-nographic'
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
