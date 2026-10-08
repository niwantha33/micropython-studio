const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getVenvPythonPathFolder, getVenvPythonPath } = require('./commonFxn');

let outputChannel = null;

function getOutputChannel() {
    if (!outputChannel) {
        const vscode = require('vscode');
        outputChannel = vscode.window.createOutputChannel('MicroPython IDE');
    }
    return outputChannel;
}

function logToFile() {
    // Disabled debug file logging
}

function logMsg(msg) {
    console.log(msg);
    logToFile(msg);
    try {
        getOutputChannel().appendLine(msg);
    } catch (_) {}
}

function getLockFilePath(port) {
    if (!port) return null;
    const lockName = `mps_lock_${port.replace(/\//g, '_').replace(/\\/g, '_').replace(/:/g, '_')}.lock`;
    return path.join(os.tmpdir(), lockName);
}

function isPidRunning(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
}

function isPortLocked(port, daemonPid) {
    const lockPath = getLockFilePath(port);
    if (!lockPath || !fs.existsSync(lockPath)) {
        return false;
    }
    try {
        const content = fs.readFileSync(lockPath, 'utf8').trim();
        const parts = content.split(':');
        const pid = parseInt(parts[0], 10);
        const owner = parts[1] || 'unknown';
        if (isNaN(pid)) {
            return false;
        }
        if (daemonPid && pid === daemonPid) {
            return false;
        }
        
        // If it's a temporary suspended lock written by the extension,
        // we check the age of the file. If it is older than 8 seconds,
        // we assume the spawned process failed to claim it or start,
        // so we treat it as stale/unlocked.
        if (owner === 'suspended_lock') {
            const stats = fs.statSync(lockPath);
            const ageMs = Date.now() - stats.mtimeMs;
            if (ageMs > 8000) {
                logMsg(`[ConnectionManager] Stale suspended_lock detected (age: ${(ageMs/1000).toFixed(1)}s), ignoring.`);
                return false;
            }
        }
        
        return isPidRunning(pid);
    } catch (err) {
        return false;
    }
}

class ConnectionManager extends EventEmitter {
    constructor() {
        super();
        this.portName = null;
        this.isConnected = false;
        
        this.daemonProcess = null;
        this.isLocked = false;
        this.isSuspended = false;
        
        // Promises for run_code requests
        this._runCodeRequests = new Map();
        this._nextReqId = 1;
        
        // Promises for suspend/resume
        this._suspendPending = null;
        this._resumePending = null;
        this._autoResumeTimer = null;
        this._connectPromise = null;
        this._connectingPort = null;
    }

    async connect(portName, baudRate = 115200) {
        if (this._connectPromise) {
            if (this._connectingPort === portName) return this._connectPromise;
            try { await this._connectPromise; } catch (_) { /* retry the requested port */ }
        }
        this._connectingPort = portName;
        const task = this._connectInternal(portName, baudRate);
        this._connectPromise = task;
        try { return await task; }
        finally {
            if (this._connectPromise === task) {
                this._connectPromise = null;
                this._connectingPort = null;
            }
        }
    }

    async _connectInternal(portName, baudRate) {
        logMsg(`[ConnectionManager] Connecting to port ${portName}...`);
        if (this.isConnected && this.portName === portName) {
            logMsg(`[ConnectionManager] Already connected to ${portName}`);
            return;
        }
        
        if (this.isConnected) {
            logMsg(`[ConnectionManager] Disconnecting from old port ${this.portName} first`);
            await this.disconnect();
        }

        this.portName = portName;

        // Never kill a live PID from a lock file. It may belong to another
        // Studio window or a legitimate serial owner.
        const lockPath = getLockFilePath(portName);
        if (lockPath && fs.existsSync(lockPath)) {
            try {
                const [pidText, type] = fs.readFileSync(lockPath, 'utf8').trim().split(':');
                const pid = Number.parseInt(pidText, 10);
                if (Number.isInteger(pid) && isPidRunning(pid)) {
                    throw new Error(`Port ${portName} is already owned by PID ${pid} (${type || 'unknown'}). Close the other connection first.`);
                }
                // A dead owner's lock is stale and safe to remove.
                if (Number.isInteger(pid) && pid > 0 && !isPidRunning(pid)) fs.unlinkSync(lockPath);
            } catch (err) {
                if (err.message.startsWith('Port ')) throw err;
                logMsg(`[ConnectionManager] Could not inspect lock: ${err.message}`);
            }
        }

        return new Promise((resolve, reject) => {
            const venvFolder = getVenvPythonPathFolder();
            const pythonPath = getVenvPythonPath(venvFolder);
            const daemonPath = path.join(__dirname, 'mpy_daemon.py');

            logMsg(`[ConnectionManager] Spawning daemon process: ${pythonPath} ${daemonPath}`);
            this.daemonProcess = spawn(pythonPath, [daemonPath]);

            let stdoutBuffer = '';
            let connected = false;
            let settled = false;
            const settle = err => {
                if (settled) return;
                settled = true;
                clearTimeout(startTimeout);
                if (err) reject(err); else resolve();
            };
            const startTimeout = setTimeout(() => {
                settle(new Error(`Timed out connecting to ${portName}. Check COM selection and close other serial tools.`));
                try { this.daemonProcess?.kill(); } catch (_) {}
            }, 10000);

            this.daemonProcess.stdout.on('data', (data) => {
                stdoutBuffer += data.toString();
                let newlineIndex;
                while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
                    const line = stdoutBuffer.slice(0, newlineIndex).trim();
                    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
                    if (!line) continue;
                    
                    try {
                        const msg = JSON.parse(line);
                        this._handleDaemonMessage(msg, () => settle(), err => settle(err), connected);
                        if (msg.type === 'connected') connected = true;
                    } catch (e) {
                        console.error('Invalid JSON from daemon:', line, e);
                    }
                }
            });

            this.daemonProcess.on('error', (err) => {
                logMsg(`[ConnectionManager] Daemon spawn error: ${err.message}`);
                settle(err);
            });

            this.daemonProcess.stderr.on('data', (data) => {
                console.error(`mpy_daemon stderr: ${data}`);
            });

            this.daemonProcess.on('close', (code) => {
                logMsg(`[ConnectionManager] Daemon closed with code: ${code}`);
                const error = new Error(`Serial daemon stopped (exit code ${code}).`);
                if (!connected) settle(error);
                this._daemonGone(error);
                this.daemonProcess = null;
                this.emit('disconnected');
            });

            // Send initialization config
            const vscode = require('vscode');
            const verbose = vscode.workspace.getConfiguration('micropython-studio').get('verboseLogging', false);
            const initConfig = { port: portName, baudrate: baudRate, verbose: verbose };
            logMsg(`[ConnectionManager] Sending initConfig: ${JSON.stringify(initConfig)}`);
            this.daemonProcess.stdin.write(JSON.stringify(initConfig) + '\n');
        });
    }

    _handleDaemonMessage(msg, resolve, reject, connected) {
        switch (msg.type) {
            case 'connected':
                logMsg(`[ConnectionManager] Received 'connected' event from daemon`);
                this.isConnected = true;
                this.isSuspended = false;
                this.emit('connected', msg.port);
                if (!connected) resolve();
                break;
            case 'error':
                logMsg(`[ConnectionManager] Received 'error' from daemon: ${msg.message}`);
                if (!connected) reject(new Error(msg.message));
                else {
                    const error = new Error(msg.message);
                    this._rejectPendingTransitions(error);
                    if (this.listenerCount('error')) this.emit('error', error);
                }
                break;
            case 'terminal_data':
                if (msg.data) {
                    const buf = Buffer.from(msg.data, 'base64');
                    this.emit('data', buf);
                }
                break;
            case 'disconnected':
                logMsg(`[ConnectionManager] Received 'disconnected' event from daemon`);
                this.isSuspended = false;
                this.disconnect();
                break;
            case 'run_result':
                const req = this._runCodeRequests.get(msg.id);
                if (req) {
                    this._runCodeRequests.delete(msg.id);
                    if (msg.success) {
                        req.resolve({ stdout: msg.stdout, stderr: msg.stderr });
                    } else {
                        req.reject(new Error(msg.error));
                    }
                }
                break;
            case 'suspended':
                logMsg('[ConnectionManager] Daemon acknowledged suspension');
                this.isSuspended = true;
                // Do not claim the port on behalf of another active process.
                if (this.portName) {
                    try {
                        fs.writeFileSync(getLockFilePath(this.portName), `${process.pid}:suspended_lock`, { flag: 'wx' });
                    } catch (err) {
                        // Another process may have legitimately acquired its lock.
                        if (err.code !== 'EEXIST') logMsg(`[ConnectionManager] Suspension lock: ${err.message}`);
                    }
                }
                this._resolveTransition('suspend');
                break;
            case 'resumed':
                logMsg('[ConnectionManager] Daemon acknowledged resume');
                this.isSuspended = false;
                this._resolveTransition('resume');
                break;
        }
    }

    _transitionField(action) {
        return action === 'suspend' ? '_suspendPending' : '_resumePending';
    }

    _resolveTransition(action) {
        const key = this._transitionField(action);
        const pending = this[key];
        if (!pending) return;
        this[key] = null;
        clearTimeout(pending.timer);
        pending.resolve();
    }

    _rejectPendingTransitions(error) {
        for (const key of ['_suspendPending', '_resumePending']) {
            const pending = this[key];
            if (!pending) continue;
            this[key] = null;
            clearTimeout(pending.timer);
            pending.reject(error);
        }
    }

    _requestTransition(action) {
        if (!this.daemonProcess || !this.isConnected)
            return Promise.reject(new Error('Cannot change REPL state: daemon is disconnected.'));
        const key = this._transitionField(action);
        if (this[key]) return this[key].promise;
        let resolvePending, rejectPending;
        const promise = new Promise((resolve, reject) => {
            resolvePending = resolve;
            rejectPending = reject;
        });
        const pending = {
            promise,
            resolve: resolvePending,
            reject: rejectPending,
            timer: null,
        };
        this[key] = pending;
        pending.timer = setTimeout(() => {
            if (this[key] !== pending) return;
            this[key] = null;
            rejectPending(new Error(`REPL ${action} timed out waiting for the serial daemon; no success acknowledged.`));
        }, 7000);
        try {
            this.daemonProcess.stdin.write(JSON.stringify({ action }) + '\n', err => {
                if (err && this[key] === pending) {
                    this[key] = null;
                    clearTimeout(pending.timer);
                    rejectPending(err);
                }
            });
        } catch (err) {
            if (this[key] === pending) {
                this[key] = null;
                clearTimeout(pending.timer);
                rejectPending(err);
            }
        }
        return promise;
    }

    async suspend() {
        if (!this.isConnected) return;
        if (this.isSuspended) return;
        await this._requestTransition('suspend');
        // No background auto-resume. The owner of the transfer must
        // explicitly resume after its process has closed.
    }

    _removeOurSuspendedLock() {
        if (!this.portName) return;
        const lock = getLockFilePath(this.portName);
        try {
            const value = fs.readFileSync(lock, 'utf8').trim();
            if (value === `${process.pid}:suspended_lock`) fs.unlinkSync(lock);
        } catch (err) {
            if (err.code !== 'ENOENT') logMsg(`[ConnectionManager] Lock cleanup: ${err.message}`);
        }
    }

    async resume() {
        if (!this.isConnected) return;
        if (!this.isSuspended) return;
        this._removeOurSuspendedLock();
        await this._requestTransition('resume');
    }

    _daemonGone(error) {
        this.stopAutoResumeCheck();
        this.isConnected = false;
        this.isSuspended = false;
        this._rejectPendingTransitions(error);
        this._removeOurSuspendedLock();
        for (const [id, pending] of this._runCodeRequests) {
            this._runCodeRequests.delete(id);
            pending.reject(error);
        }
    }

    async disconnect() {
        this.stopAutoResumeCheck();
        if (!this.daemonProcess) return;
        const daemon = this.daemonProcess;
        if (daemon.exitCode !== null || daemon.killed) return;
        await new Promise(resolve => {
            const deadline = setTimeout(() => {
                try { daemon.kill('SIGKILL'); } catch (_) {}
                resolve();
            }, 2500);
            daemon.once('close', () => {
                clearTimeout(deadline);
                resolve();
            });
            try { daemon.kill(); } catch (_) {
                clearTimeout(deadline);
                resolve();
            }
        });
    }

    // Never auto-reconnect a suspended REPL behind the active upload owner.
    // This method remains for compatibility with legacy call sites.
    startAutoResumeCheck() {}

    stopAutoResumeCheck() {
        if (this._autoResumeTimer) {
            clearInterval(this._autoResumeTimer);
            clearTimeout(this._autoResumeTimer);
            this._autoResumeTimer = null;
        }
    }

    /**
     * Lists files and directories in a directory on the device.
     */
    async listDir(dirPath) {
        const code = `
import os
def l():
    try:
        for f in os.ilistdir(${JSON.stringify(dirPath)}):
            is_dir = (f[1] == 0x4000)
            print('{}|{}|{}'.format(f[0], is_dir, f[3] if len(f)>3 else 0))
    except Exception as e:
        print('LS_ERROR:' + str(e))
l()
        `.trim();
        const res = await this.runCodeSilently(code);
        if (res.stderr && res.stderr.trim()) {
            throw new Error(res.stderr.trim());
        }
        if (res.stdout.includes('LS_ERROR:')) {
            throw new Error(res.stdout.split('LS_ERROR:')[1].trim());
        }
        return res.stdout;
    }

    /**
     * Reads a file from the device using hex-encoding chunked transfer.
     */
    async catFile(deviceFilePath) {
        const code = `
import binascii as _b, sys as _s, time as _t
try:
    _f = open(${JSON.stringify(deviceFilePath)}, 'rb')
    _d = _f.read()
    _f.close()
    print('<<HEXLEN:%d>>' % len(_d))
    print('<<HEXSTART>>')
    _h = _b.hexlify(_d).decode()
    for _i in range(0, len(_h), 128):
        _s.stdout.write(_h[_i:_i+128])
        _s.stdout.write('\\n')
        _t.sleep_ms(3)
    print('<<HEXEND>>')
except Exception as _e:
    print('CAT_ERR:'+str(_e))
        `.trim();
        const res = await this.runCodeSilently(code);
        if (res.stderr && res.stderr.trim()) {
            throw new Error(res.stderr.trim());
        }
        const text = res.stdout;
        if (text.includes('CAT_ERR:')) {
            throw new Error(text.split('CAT_ERR:')[1].trim());
        }
        const lm = text.match(/<<HEXLEN:(\d+)>>/);
        if (!lm) {
            throw new Error("No HEXLEN marker");
        }
        const expected = parseInt(lm[1], 10);
        const startIdx = text.indexOf('<<HEXSTART>>');
        if (startIdx < 0) {
            throw new Error("No HEXSTART marker");
        }
        const hexPart = text.substring(startIdx + '<<HEXSTART>>'.length);
        const hexChars = hexPart.replace(/[^0-9a-fA-F]/g, '');
        const finalHex = hexChars.substring(0, expected * 2);
        return Buffer.from(finalHex, 'hex');
    }

    /**
     * Writes a file to the device using hex-encoding chunked transfer.
     */
    async writeFile(deviceFilePath, buffer) {
        const hexStr = buffer.toString('hex');
        const chunks = [];
        for (let i = 0; i < hexStr.length; i += 1024) {
            chunks.push(hexStr.substring(i, i + 1024));
        }
        const parts = deviceFilePath.split('/');
        parts.pop();
        const parentDir = parts.join('/') || '/';
        
        const code = [
            `import binascii as _b, os as _o`,
            `def _mkdir_p(p):`,
            `    parts = p.strip('/').split('/')`,
            `    acc = ''`,
            `    for part in parts:`,
            `        acc += '/' + part`,
            `        try: _o.mkdir(acc)`,
            `        except: pass`,
            `if ${JSON.stringify(parentDir)} != '/': _mkdir_p(${JSON.stringify(parentDir)})`,
            `try: _o.remove(${JSON.stringify(deviceFilePath)})`,
            `except: pass`,
            `_f=open(${JSON.stringify(deviceFilePath)},'wb')`,
            ...chunks.map(chunk => `_f.write(_b.unhexlify(${JSON.stringify(chunk)}))`),
            `_f.close()`,
            `print('OK_PUT')`
        ].join('\n');
        
        const res = await this.runCodeSilently(code);
        if (res.stderr && res.stderr.trim()) {
            throw new Error(res.stderr.trim());
        }
        if (!res.stdout.includes('OK_PUT')) {
            throw new Error("Write failed: " + res.stdout);
        }
    }

    /**
     * Deletes a file or folder on the device.
     */
    async deleteFile(deviceFilePath, recursive = false) {
        let code = '';
        if (recursive) {
            code = `
import os as _os
def _rm(p):
    try:
        for e in _os.listdir(p):
            _rm(p + '/' + e)
        _os.rmdir(p)
    except OSError:
        _os.remove(p)
try:
    _rm(${JSON.stringify(deviceFilePath)})
    print('OK_RM')
except Exception as e:
    print('RM_ERR:' + str(e))
            `.trim();
        } else {
            code = `
import os
try:
    os.remove(${JSON.stringify(deviceFilePath)})
    print('OK_RM')
except Exception as e:
    print('RM_ERR:' + str(e))
            `.trim();
        }
        const res = await this.runCodeSilently(code);
        if (res.stderr && res.stderr.trim()) {
            throw new Error(res.stderr.trim());
        }
        if (res.stdout.includes('RM_ERR:')) {
            throw new Error(res.stdout.split('RM_ERR:')[1].trim());
        }
        if (!res.stdout.includes('OK_RM')) {
            throw new Error("Delete failed: " + res.stdout);
        }
    }

    /**
     * Creates a directory recursively on the device.
     */
    async makeDir(deviceFolderPath) {
        const code = `
import os
def _mkdir_p(p):
    parts = p.strip('/').split('/')
    acc = ''
    for part in parts:
        acc += '/' + part
        try: os.mkdir(acc)
        except: pass
try:
    _mkdir_p(${JSON.stringify(deviceFolderPath)})
    print('OK_MKDIR')
except Exception as e:
    print('MKDIR_ERR:' + str(e))
        `.trim();
        const res = await this.runCodeSilently(code);
        if (res.stderr && res.stderr.trim()) {
            throw new Error(res.stderr.trim());
        }
        if (res.stdout.includes('MKDIR_ERR:')) {
            throw new Error(res.stdout.split('MKDIR_ERR:')[1].trim());
        }
        if (!res.stdout.includes('OK_MKDIR')) {
            throw new Error("Mkdir failed: " + res.stdout);
        }
    }

    /**
     * Renames/moves a file or folder on the device.
     */
    async renameFile(srcPath, destPath) {
        const code = `
import os
try:
    os.rename(${JSON.stringify(srcPath)}, ${JSON.stringify(destPath)})
    print('OK_RENAME')
except Exception as e:
    print('RENAME_ERR:' + str(e))
        `.trim();
        const res = await this.runCodeSilently(code);
        if (res.stderr && res.stderr.trim()) {
            throw new Error(res.stderr.trim());
        }
        if (res.stdout.includes('RENAME_ERR:')) {
            throw new Error(res.stdout.split('RENAME_ERR:')[1].trim());
        }
        if (!res.stdout.includes('OK_RENAME')) {
            throw new Error("Rename failed: " + res.stdout);
        }
    }

    /**
     * Writes user terminal input to the device
     */
    async write(data) {
        if (!this.isConnected || !this.daemonProcess) return;
        
        const b64 = Buffer.isBuffer(data) ? data.toString('base64') : Buffer.from(data).toString('base64');
        const cmd = {
            action: 'terminal_input',
            data: b64
        };
        this.daemonProcess.stdin.write(JSON.stringify(cmd) + '\n');
    }

    /**
     * Executes code programmatically via raw paste in the background daemon.
     */
    async runCodeSilently(codeString) {
        if (!this.isConnected || !this.daemonProcess) throw new Error('Not connected');

        const reqId = this._nextReqId++;
        
        const cmd = {
            action: 'run_code',
            id: reqId,
            code: codeString
        };

        return new Promise((resolve, reject) => {
            this._runCodeRequests.set(reqId, { resolve, reject });
            this.daemonProcess.stdin.write(JSON.stringify(cmd) + '\n');
        });
    }

    /**
     * Executes code in the foreground terminal (streams output, supports infinite loops).
     */
    async runInTerminal(codeString) {
        if (!this.isConnected || !this.daemonProcess) throw new Error('Not connected');

        const cmd = {
            action: 'run_in_terminal',
            code: codeString
        };
        this.daemonProcess.stdin.write(JSON.stringify(cmd) + '\n');
    }
}

const connectionManager = new ConnectionManager();
module.exports = connectionManager;
