/**
 * Safe subprocess execution for environment setup and MicroPython tools.
 * Argument arrays are passed directly to the OS: never interpolate user-controlled
 * device names, local paths or script content into a shell command.
 * @license MIT
 */
'use strict';

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const { getVenvPythonPathFolder, getVenvPythonPath } = require('./commonFxn');

const PROCESS_TIMEOUT_MS = 10 * 60 * 1000;
const MPREMOTE_TIMEOUT_MS = 30 * 1000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function assertArguments(command, args) {
    if (typeof command !== 'string' || !command.trim() ||
        !Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
        throw new TypeError('Expected an executable path and an array of string arguments.');
    }
}

/** Run a CLI tool without a command shell and stream bounded output to VS Code. */
function runCommand(outputChannel, command, args, cwd) {
    return new Promise((resolve, reject) => {
        try {
            assertArguments(command, args);
        } catch (err) {
            reject(err);
            return;
        }

        // Do not log arguments; these may contain credentials or private paths.
        outputChannel.appendLine('Running: ' + command + ' (' + args.length + ' arguments)');
        let proc;
        try {
            proc = spawn(command, args, {
                cwd,
                shell: false,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });
        } catch (err) {
            reject(err);
            return;
        }

        let finished = false;
        let outputBytes = 0;
        const settle = (error) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve();
        };
        const timer = setTimeout(() => {
            proc.kill();
            settle(new Error('Command timed out after 10 minutes'));
        }, PROCESS_TIMEOUT_MS);
        const relay = (data) => {
            if (finished) return;
            outputBytes += data.length;
            if (outputBytes > 8 * MAX_OUTPUT_BYTES) {
                proc.kill();
                settle(new Error('Command exceeded the output limit'));
                return;
            }
            outputChannel.append(data.toString());
        };

        proc.stdout.on('data', relay);
        proc.stderr.on('data', relay);
        proc.on('error', (err) => {
            outputChannel.appendLine('Command failed: ' + err.message);
            settle(err);
        });
        proc.on('close', (code, signal) => {
            if (code === 0) {
                outputChannel.appendLine('Command completed successfully');
                settle();
            } else {
                const reason = signal ? 'signal ' + signal : 'exit code ' + code;
                outputChannel.appendLine('Command failed: ' + reason);
                settle(new Error('Process failed: ' + reason));
            }
        });
    });
}

/** Execute python -m mpremote with literal arguments and a hard timeout. */
function runMpremote(outputChannel, args) {
    return new Promise((resolve, reject) => {
        const venvPython = getVenvPythonPath(getVenvPythonPathFolder());
        if (!venvPython || !fs.existsSync(venvPython)) {
            reject(new Error('Python executable not found. Run "Setup Environment" first.'));
            return;
        }
        try {
            assertArguments(venvPython, args);
        } catch (err) {
            reject(err);
            return;
        }
        outputChannel.appendLine('Executing: mpremote (' + args.length + ' arguments)');
        execFile(venvPython, ['-m', 'mpremote', ...args], {
            timeout: MPREMOTE_TIMEOUT_MS,
            maxBuffer: MAX_OUTPUT_BYTES,
            windowsHide: true
        }, (error, stdout, stderr) => {
            if (error) {
                const connectionError = /No device found|could not open port/i.test(stderr || '');
                reject(new Error(connectionError
                    ? 'Device connection error: ' + String(stderr).trim().slice(0, 500)
                    : 'mpremote failed: ' + error.message));
                return;
            }
            if (stderr && stderr.trim()) {
                outputChannel.appendLine('mpremote warning: ' + stderr.trim().slice(0, 1000));
            }
            const result = stdout ? stdout.trim() : '';
            if (result) outputChannel.appendLine('Output:\n' + result);
            resolve(result);
        });
    });
}

/** List connected devices; an absent/unavailable mpremote means no devices. */
async function getConnectedDevices() {
    const venvPython = getVenvPythonPath(getVenvPythonPathFolder());
    if (!venvPython || !fs.existsSync(venvPython)) return [];

    return new Promise((resolve) => {
        execFile(venvPython, ['-m', 'mpremote', 'connect', 'list'], {
            timeout: 10000,
            maxBuffer: MAX_OUTPUT_BYTES,
            windowsHide: true
        }, (error, stdout) => {
            if (error || !stdout) {
                resolve([]);
                return;
            }
            const devices = stdout.split(/\r?\n/).filter(Boolean).map(line => {
                const [port, serial = 'None', vidpid = '0000:0000'] = line.trim().split(/\s+/);
                return { port, serial, vidpid };
            }).filter(item => item.port);
            resolve(devices);
        });
    });
}

module.exports = { runCommand, runMpremote, getConnectedDevices };
