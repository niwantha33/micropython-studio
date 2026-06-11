const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { getVenvPythonPathFolder, getVenvPythonPath } = require('./commonFxn');

function logToFile(msg) {
    // Disabled debug file logging
}

function logMsg(msg) {
    console.log(msg);
    logToFile(msg);
    try {
        const vscode = require('vscode');
        const channel = vscode.window.createOutputChannel('MicroPython IDE');
        channel.appendLine(msg);
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
        this._suspendResolve = null;
        this._resumeResolve = null;
        this._autoResumeTimer = null;
    }

    async connect(portName, baudRate = 115200) {
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

        // Clean up stale daemon holding this port before spawning a new one
        const lockPath = getLockFilePath(portName);
        if (lockPath && fs.existsSync(lockPath)) {
            try {
                const content = fs.readFileSync(lockPath, 'utf8').trim();
                const parts = content.split(':');
                const pid = parseInt(parts[0], 10);
                const type = parts[1];
                if (!isNaN(pid) && isPidRunning(pid)) {
                    if (type === 'daemon') {
                        logMsg(`[ConnectionManager] Killing stale daemon process ${pid} holding port ${portName}`);
                        try {
                            process.kill(pid, 'SIGKILL');
                        } catch (e) {
                            try { process.kill(pid); } catch (err) {}
                        }
                        // wait a brief moment for port release
                        await new Promise(resolve => setTimeout(resolve, 500));
                        // remove the lock file
                        try { fs.unlinkSync(lockPath); } catch (e) {}
                    }
                }
            } catch (err) {
                console.error('[ConnectionManager] Error cleaning up stale daemon lock:', err);
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

            this.daemonProcess.stdout.on('data', (data) => {
                stdoutBuffer += data.toString();
                let newlineIndex;
                while ((newlineIndex = stdoutBuffer.indexOf('\n')) !== -1) {
                    const line = stdoutBuffer.slice(0, newlineIndex).trim();
                    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
                    if (!line) continue;
                    
                    try {
                        const msg = JSON.parse(line);
                        this._handleDaemonMessage(msg, resolve, reject, connected);
                        if (msg.type === 'connected') connected = true;
                    } catch (e) {
                        console.error('Invalid JSON from daemon:', line, e);
                    }
                }
            });

            this.daemonProcess.on('error', (err) => {
                logMsg(`[ConnectionManager] Daemon spawn error: ${err.message}`);
                reject(err);
            });

            this.daemonProcess.stderr.on('data', (data) => {
                console.error(`mpy_daemon stderr: ${data}`);
            });

            this.daemonProcess.on('close', (code) => {
                logMsg(`[ConnectionManager] Daemon closed with code: ${code}`);
                this.isConnected = false;
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
                else this.emit('error', new Error(msg.message));
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
                logMsg(`[ConnectionManager] Daemon suspended successfully`);
                this.isSuspended = true;
                
                // Write a temporary lock file to prevent auto-resume from claiming the port 
                // before the child process (terminal or spawn) can write its own lock
                if (this.portName) {
                    try {
                        const lockPath = getLockFilePath(this.portName);
                        fs.writeFileSync(lockPath, `${process.pid}:suspended_lock`);
                    } catch (err) {
                        console.error('[ConnectionManager] Failed to write suspended lock:', err);
                    }
                }

                if (this._suspendResolve) {
                    this._suspendResolve();
                    this._suspendResolve = null;
                }
                break;
            case 'resumed':
                logMsg(`[ConnectionManager] Daemon resumed successfully`);
                this.isSuspended = false;
                if (this._resumeResolve) {
                    this._resumeResolve();
                    this._resumeResolve = null;
                }
                break;
        }
    }

    async suspend() {
        if (!this.isConnected || !this.daemonProcess) return;
        logMsg(`[ConnectionManager] Suspending connection...`);
        return new Promise((resolve) => {
            this._suspendResolve = () => {
                this.startAutoResumeCheck();
                resolve();
            };
            this.daemonProcess.stdin.write(JSON.stringify({ action: 'suspend' }) + '\n');
        });
    }

    async resume() {
        if (!this.isConnected || !this.daemonProcess) return;
        this.stopAutoResumeCheck();
        logMsg(`[ConnectionManager] Resuming connection...`);
        
        if (this.portName) {
            const lockPath = getLockFilePath(this.portName);
            if (lockPath && fs.existsSync(lockPath)) {
                try {
                    const content = fs.readFileSync(lockPath, 'utf8').trim();
                    const parts = content.split(':');
                    const owner = parts[1] || 'unknown';
                    if (owner === 'suspended_lock') {
                        fs.unlinkSync(lockPath);
                        logMsg(`[ConnectionManager] Removed suspended lock at ${lockPath}`);
                    }
                } catch (err) {
                    console.error('[ConnectionManager] Failed to remove suspended lock on resume:', err);
                }
            }
        }

        return new Promise((resolve) => {
            this._resumeResolve = resolve;
            this.daemonProcess.stdin.write(JSON.stringify({ action: 'resume' }) + '\n');
        });
    }

    async disconnect() {
        this.stopAutoResumeCheck();
        if (!this.isConnected || !this.daemonProcess) return;
        
        return new Promise((resolve) => {
            this.daemonProcess.on('close', () => resolve());
            this.daemonProcess.kill();
        });
    }

    startAutoResumeCheck() {
        if (this._autoResumeTimer) return;
        
        logMsg(`[ConnectionManager] Starting auto-resume check helper...`);
        // Delay the first check to allow the terminal process to spawn and acquire the lock
        setTimeout(() => {
            if (!this.isConnected || !this.isSuspended) {
                this.stopAutoResumeCheck();
                return;
            }
            
            this._autoResumeTimer = setInterval(async () => {
                if (!this.isConnected || !this.isSuspended) {
                    this.stopAutoResumeCheck();
                    return;
                }
                
                const port = this.portName;
                const daemonPid = this.daemonProcess ? this.daemonProcess.pid : null;
                
                const locked = isPortLocked(port, daemonPid);
                logMsg(`[ConnectionManager] Auto-resume check: Port ${port} isLocked = ${locked}`);
                
                if (!locked) {
                    logMsg(`[ConnectionManager] Auto-resume: Port ${port} is no longer locked by another process. Resuming daemon connection automatically!`);
                    this.stopAutoResumeCheck();
                    await this.resume();
                }
            }, 1000);
        }, 1500);
    }

    stopAutoResumeCheck() {
        if (this._autoResumeTimer) {
            logMsg(`[ConnectionManager] Stopping auto-resume check helper...`);
            clearInterval(this._autoResumeTimer);
            this._autoResumeTimer = null;
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
