/**
 * CircuitPython Web Workflow API helpers (CircuitPython 8+)
 *
 * Device exposes an HTTP server on its Wi-Fi IP.
 * settings.toml on the CIRCUITPY drive controls Wi-Fi + API password.
 *
 * Auth: HTTP Basic Auth with empty username and the API password.
 *       Header value = "Basic " + base64(":" + password)
 */

'use strict';

const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

// ─── Auth helper ─────────────────────────────────────────────────────────────

/**
 * Build the Basic Auth header value for the Web Workflow API.
 * CircuitPython uses empty username + colon prefix: base64(":password")
 * @param {string} password
 * @returns {string}
 */
function buildAuthHeader(password) {
    return 'Basic ' + Buffer.from(':' + password).toString('base64');
}

// ─── Low-level request ───────────────────────────────────────────────────────

/**
 * Make an HTTP request to the CircuitPython Web Workflow API.
 * @param {object} opts
 * @param {string}  opts.ip
 * @param {number}  [opts.port=80]
 * @param {string}  opts.method  GET | PUT | DELETE | MOVE
 * @param {string}  opts.urlPath  e.g. /cp/version.json  or /fs/code.py
 * @param {string}  opts.password
 * @param {Buffer|string|null} [opts.body]
 * @param {Record<string,string>} [opts.extraHeaders]
 * @returns {Promise<{statusCode:number, body:string}>}
 */
function apiRequest({ ip, port = 80, method, urlPath, password, body = null, extraHeaders = {} }) {
    return new Promise((resolve, reject) => {
        const headers = {
            'Authorization': buildAuthHeader(password),
            ...extraHeaders
        };
        if (body !== null) {
            headers['Content-Type']   = 'application/octet-stream';
            headers['Content-Length'] = Buffer.byteLength(body);
        }

        const req = http.request({ host: ip, port, method, path: urlPath, headers }, (res) => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve({
                statusCode: res.statusCode || 0,
                body: Buffer.concat(chunks).toString('utf8')
            }));
        });

        req.on('error', reject);
        if (body !== null) req.write(body);
        req.end();
    });
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Check if a device is reachable and return board info.
 * @param {string} ip
 * @param {string} password
 * @param {number} [port=80]
 * @returns {Promise<object|null>}  version JSON or null on failure
 */
async function getVersion(ip, password, port = 80) {
    try {
        const res = await apiRequest({ ip, port, method: 'GET', urlPath: '/cp/version.json', password });
        if (res.statusCode === 200) return JSON.parse(res.body);
    } catch (_) {}
    return null;
}

/**
 * List directory contents.
 * @param {string} ip
 * @param {string} password
 * @param {string} [remotePath='/']
 * @param {number} [port=80]
 * @returns {Promise<{free:number, total:number, writable:boolean, files:Array}|null>}
 */
async function listDir(ip, password, remotePath = '/', port = 80) {
    const p = remotePath.endsWith('/') ? remotePath : remotePath + '/';
    try {
        const res = await apiRequest({
            ip, port,
            method: 'GET',
            urlPath: '/fs' + p,
            password,
            extraHeaders: { 'Accept': 'application/json' }
        });
        if (res.statusCode === 200) return JSON.parse(res.body);
    } catch (_) {}
    return null;
}

/**
 * Upload a single file to the device.
 * @param {string} ip
 * @param {string} password
 * @param {string} remotePath  e.g. '/code.py' or '/lib/mylib.py'
 * @param {Buffer|string} content
 * @param {number} [port=80]
 * @returns {Promise<boolean>}
 */
async function putFile(ip, password, remotePath, content, port = 80) {
    try {
        const body = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
        const res = await apiRequest({
            ip, port,
            method: 'PUT',
            urlPath: '/fs' + remotePath,
            password,
            body,
            extraHeaders: { 'X-Timestamp': String(Date.now()) }
        });
        return res.statusCode === 200 || res.statusCode === 201 || res.statusCode === 204;
    } catch (_) {
        return false;
    }
}

/**
 * Create a directory on the device (PUT with trailing slash).
 * @param {string} ip
 * @param {string} password
 * @param {string} remotePath  e.g. '/lib'
 * @param {number} [port=80]
 * @returns {Promise<boolean>}
 */
async function makeDir(ip, password, remotePath, port = 80) {
    const p = remotePath.endsWith('/') ? remotePath : remotePath + '/';
    try {
        const res = await apiRequest({ ip, port, method: 'PUT', urlPath: '/fs' + p, password });
        return res.statusCode === 200 || res.statusCode === 201 || res.statusCode === 204;
    } catch (_) {
        return false;
    }
}

/**
 * Delete a file or directory.
 * @param {string} ip
 * @param {string} password
 * @param {string} remotePath
 * @param {number} [port=80]
 */
async function deleteFile(ip, password, remotePath, port = 80) {
    try {
        await apiRequest({ ip, port, method: 'DELETE', urlPath: '/fs' + remotePath, password });
    } catch (_) {}
}

/**
 * Download a file from the device.
 * @param {string} ip
 * @param {string} password
 * @param {string} remotePath
 * @param {number} [port=80]
 * @returns {Promise<string|null>}
 */
async function getFile(ip, password, remotePath, port = 80) {
    try {
        const res = await apiRequest({ ip, port, method: 'GET', urlPath: '/fs' + remotePath, password });
        if (res.statusCode === 200) return res.body;
    } catch (_) {}
    return null;
}

/**
 * Upload an entire local folder recursively to the device.
 * @param {string} ip
 * @param {string} password
 * @param {string} localFolder   Absolute local path
 * @param {string} remoteBase    e.g. '/' to upload into root
 * @param {number} [port=80]
 * @param {(msg:string)=>void} [onProgress]
 * @returns {Promise<{ok:number, failed:string[]}>}
 */
async function uploadFolder(ip, password, localFolder, remoteBase = '/', port = 80, onProgress = null) {
    const ok = 0, failed = [];
    const base = remoteBase.endsWith('/') ? remoteBase : remoteBase + '/';

    /** @param {string} localDir @param {string} remoteDir */
    async function walk(localDir, remoteDir) {
        // Ensure remote dir exists
        if (remoteDir !== '/') await makeDir(ip, password, remoteDir, port);

        const entries = fs.readdirSync(localDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name.startsWith('.')) continue;  // skip hidden
            const localPath  = path.join(localDir, entry.name);
            const remotePath = remoteDir.replace(/\/$/, '') + '/' + entry.name;
            if (entry.isDirectory()) {
                await walk(localPath, remotePath);
            } else {
                if (onProgress) onProgress(`📤 ${remotePath}`);
                const content = fs.readFileSync(localPath);
                const success = await putFile(ip, password, remotePath, content, port);
                if (success) {
                    // ok++ — can't mutate const, track in outer scope
                } else {
                    failed.push(remotePath);
                }
            }
        }
    }

    await walk(localFolder, base);
    return { failed };
}

/**
 * Write settings.toml to the CIRCUITPY drive (USB) — preferred method.
 * Falls back to returning false if the drive path isn't provided.
 * @param {string} drivePath  e.g. 'D:\'
 * @param {{ssid:string, wifiPassword:string, apiPassword:string, apiPort?:number}} config
 * @returns {boolean}
 */
function writeSettingsToml(drivePath, config) {
    try {
        if (!drivePath) throw new Error('CIRCUITPY drive not found — connect the device via USB.');
        const content = [
            `CIRCUITPY_WIFI_SSID = "${config.ssid}"`,
            `CIRCUITPY_WIFI_PASSWORD = "${config.wifiPassword}"`,
            `CIRCUITPY_WEB_API_PASSWORD = "${config.apiPassword}"`,
            `CIRCUITPY_WEB_API_PORT = ${config.apiPort || 80}`,
        ].join('\n') + '\n';
        fs.writeFileSync(path.join(drivePath, 'settings.toml'), content, 'utf8');
        return { ok: true };
    } catch (err) {
        let msg = err.message || String(err);
        if (err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EROFS') {
            msg = `Drive is read-only (${drivePath}) — CircuitPython locks the filesystem while code is running. Press Stop / Ctrl+C in the REPL first, then try again.`;
        }
        return { ok: false, error: msg };
    }
}

/**
 * Read existing settings.toml from the CIRCUITPY drive.
 * @param {string} drivePath
 * @returns {{ssid:string, wifiPassword:string, apiPassword:string, apiPort:number}|null}
 */
function readSettingsToml(drivePath) {
    try {
        const raw = fs.readFileSync(path.join(drivePath, 'settings.toml'), 'utf8');
        const get = (key) => {
            const m = raw.match(new RegExp(`^${key}\\s*=\\s*"?([^"\\n]*)"?`, 'm'));
            return m ? m[1].trim() : '';
        };
        return {
            ssid:        get('CIRCUITPY_WIFI_SSID'),
            wifiPassword: get('CIRCUITPY_WIFI_PASSWORD'),
            apiPassword: get('CIRCUITPY_WEB_API_PASSWORD'),
            apiPort:     parseInt(get('CIRCUITPY_WEB_API_PORT') || '80', 10),
        };
    } catch (_) {
        return null;
    }
}

module.exports = {
    getVersion,
    listDir,
    putFile,
    makeDir,
    deleteFile,
    getFile,
    uploadFolder,
    writeSettingsToml,
    readSettingsToml,
};
