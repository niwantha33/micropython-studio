'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { getVenvPythonPath, getVenvPythonPathFolder } = require('./commonFxn');

let qemuProcess = null;
let connectTimer = null;
const MAX_DOWNLOAD_BYTES = 400 * 1024 * 1024;
const ALLOWED_HOSTS = new Set([
    'github.com', 'objects.githubusercontent.com',
    'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com'
]);
const SHA256 = /^[0-9a-f]{64}$/i;

function validateAsset(asset, kind) {
    if (!asset || typeof asset.url !== 'string' ||
        typeof asset.sha256 !== 'string' || !SHA256.test(asset.sha256)) {
        throw new Error('Unverified simulator ' + kind + ': missing a pinned SHA-256 checksum.');
    }
    let parsed;
    try { parsed = new URL(asset.url); }
    catch (_) { throw new Error('Invalid simulator download URL.'); }
    if (parsed.protocol !== 'https:' || !ALLOWED_HOSTS.has(parsed.hostname)) {
        throw new Error('Simulator assets must come from an approved HTTPS release host.');
    }
    // Checksum verification is mandatory even for release-tag URLs.
    return asset;
}

function loadVerifiedManifest(context) {
    const file = path.join(context.extensionPath, 'resource', 'simulator-manifest.json');
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (_) { throw new Error('Simulator is unavailable: no approved asset manifest is installed.'); }
    if (manifest.enabled !== true) {
        throw new Error('Simulator is disabled until verified QEMU and firmware releases are qualified. ' +
            String(manifest.reason || '').slice(0, 250));
    }
    const platform = manifest.platforms && manifest.platforms[process.platform];
    const qemu = validateAsset(platform, 'QEMU');
    const firmware = validateAsset(manifest.firmware, 'firmware');
    if (!SHA256.test(qemu.executableSha256 || '')) {
        throw new Error('Unverified simulator: QEMU executable checksum is missing.');
    }
    return { qemu, firmware };
}

/** Stream and verify the *entire* artifact, including files cached from older runs. */
function verifySha256(filePath, expected) {
    return new Promise((resolve, reject) => {
        if (!SHA256.test(expected || '')) {
            reject(new Error('Missing pinned checksum'));
            return;
        }
        const stream = fs.createReadStream(filePath);
        const digest = crypto.createHash('sha256');
        let size = 0;
        stream.on('data', chunk => {
            size += chunk.length;
            if (size > MAX_DOWNLOAD_BYTES) {
                stream.destroy(new Error('Simulator artifact exceeds limit'));
            } else {
                digest.update(chunk);
            }
        });
        stream.on('error', reject);
        stream.on('end', () => {
            if (digest.digest('hex').toLowerCase() === expected.toLowerCase()) resolve();
            else reject(new Error('Simulator artifact SHA-256 mismatch: refusing to execute'));
        });
    });
}

function downloadFile(url, dest, sha256, redirects = 5) {
    return new Promise((resolve, reject) => {
        if (!SHA256.test(sha256 || '')) {
            reject(new Error('No pinned checksum for simulator download'));
            return;
        }
        let target;
        try { target = new URL(url); }
        catch (err) { reject(err); return; }
        if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) {
            reject(new Error('Simulator download URL is not an approved HTTPS host'));
            return;
        }
        const request = https.get(target, response => {
            if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
                response.resume();
                if (!response.headers.location || redirects <= 0) {
                    reject(new Error('Simulator download exceeded redirect limit'));
                    return;
                }
                resolve(downloadFile(new URL(response.headers.location, target).toString(),
                    dest, sha256, redirects - 1));
                return;
            }
            if (response.statusCode !== 200) {
                response.resume();
                reject(new Error('Simulator download HTTP ' + response.statusCode));
                return;
            }
            const length = Number(response.headers['content-length'] || 0);
            if (length > MAX_DOWNLOAD_BYTES) {
                response.destroy();
                reject(new Error('Simulator download exceeds limit'));
                return;
            }
            const temporary = dest + '.' + crypto.randomBytes(8).toString('hex') + '.partial';
            const output = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
            const hash = crypto.createHash('sha256');
            let size = 0;
            let settled = false;
            const fail = err => {
                if (settled) return;
                settled = true;
                output.destroy();
                response.destroy();
                fs.rm(temporary, { force: true }, () => reject(err));
            };
            response.on('data', chunk => {
                if (settled) return;
                size += chunk.length;
                if (size > MAX_DOWNLOAD_BYTES) {
                    fail(new Error('Simulator download exceeds limit'));
                } else {
                    hash.update(chunk);
                }
            });
            output.on('error', fail);
            response.on('error', fail);
            output.on('finish', () => {
                if (settled) return;
                if (hash.digest('hex').toLowerCase() !== sha256.toLowerCase()) {
                    fail(new Error('Simulator artifact checksum mismatch'));
                    return;
                }
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

function extractZip(zipPath, destDir) {
    return new Promise((resolve, reject) => {
        const python = getVenvPythonPath(getVenvPythonPathFolder());
        if (!fs.existsSync(python)) {
            reject(new Error('Run MicroPython Studio Setup Environment before starting the simulator.'));
            return;
        }
        const extractor = path.join(__dirname, 'safe_extract.py');
        execFile(python, [extractor, zipPath, destDir], {
            timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true
        }, (error, _stdout, stderr) => {
            if (error) reject(new Error('Simulator archive rejected: ' +
                String(stderr || error.message).trim().slice(0, 500)));
            else resolve();
        });
    });
}

async function startSimulator(context, outputChannel, onConnect, onExit) {
    if (qemuProcess) {
        vscode.window.showInformationMessage('Simulator is already running.');
        return;
    }
    // Fail *before* downloading or executing any old unverified binary.
    const assets = loadVerifiedManifest(context);
    const binDir = path.join(context.extensionPath, 'bin');
    const qemuDir = path.join(binDir, 'qemu');
    const qemuBin = path.join(qemuDir,
        process.platform === 'win32' ? 'qemu-system-arm.exe' : 'qemu-system-arm');
    const firmwarePath = path.join(binDir, 'qemu_firmware.elf');
    fs.mkdirSync(binDir, { recursive: true });

    if (fs.existsSync(qemuBin)) {
        await verifySha256(qemuBin, assets.qemu.executableSha256);
    } else {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Downloading verified QEMU simulator',
            cancellable: false
        }, async progress => {
            const zipPath = path.join(binDir, 'qemu.zip');
            try {
                await downloadFile(assets.qemu.url, zipPath, assets.qemu.sha256);
                progress.report({ message: 'Validating and extracting...' });
                await extractZip(zipPath, qemuDir);
                await verifySha256(qemuBin, assets.qemu.executableSha256);
                if (process.platform !== 'win32') fs.chmodSync(qemuBin, 0o755);
            } finally {
                try { fs.rmSync(zipPath, { force: true }); } catch (_) {}
            }
        });
    }

    if (fs.existsSync(firmwarePath)) {
        await verifySha256(firmwarePath, assets.firmware.sha256);
    } else {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Downloading verified emulation firmware',
            cancellable: false
        }, () => downloadFile(assets.firmware.url, firmwarePath, assets.firmware.sha256));
    }

    outputChannel.appendLine('Launching verified QEMU simulator with semihosting disabled.');
    const args = [
        '-machine', 'mps2-an385',
        '-cpu', 'cortex-m3',
        '-kernel', firmwarePath,
        '-serial', 'tcp:127.0.0.1:4444,server,nowait',
        '-nographic',
        '-monitor', 'null'
    ];
    const child = spawn(qemuBin, args, { cwd: binDir, shell: false, windowsHide: true });
    qemuProcess = child;
    child.stdout?.on('data', data => outputChannel.append('[QEMU STDOUT] ' + data));
    child.stderr?.on('data', data => outputChannel.append('[QEMU STDERR] ' + data));
    child.on('error', error => {
        outputChannel.appendLine('QEMU failed: ' + error.message);
        if (qemuProcess === child) qemuProcess = null;
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
        onExit?.();
    });
    child.on('close', code => {
        outputChannel.appendLine('QEMU exited with code ' + code);
        if (qemuProcess === child) qemuProcess = null;
        if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
        onExit?.();
    });
    connectTimer = setTimeout(async () => {
        connectTimer = null;
        if (qemuProcess !== child || child.exitCode !== null) return;
        try {
            await onConnect('tcp:127.0.0.1:4444');
            if (qemuProcess === child) vscode.window.showInformationMessage('Simulator connected.');
        } catch (error) {
            outputChannel.appendLine('Simulator connection failed: ' + error.message);
        }
    }, 1500);
}

function stopSimulator() {
    if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
    if (qemuProcess) {
        const child = qemuProcess;
        qemuProcess = null;
        child.kill();
        vscode.window.showInformationMessage('Simulator stopped.');
    }
}

module.exports = { startSimulator, stopSimulator, verifySha256, loadVerifiedManifest };
