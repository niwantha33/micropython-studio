/**
 * runCommand.js
 * Process spawning and mpremote command execution
 * @license MIT
 * @version 2.0
 * @author  Niwantha Meepage
 */

const { exec, spawn } = require('child_process');
const fs = require('fs');
const { getVenvPythonPathFolder, getVenvPythonPath } = require('./commonFxn');

/**
 * Run a command as a child process with output piped to a VS Code OutputChannel.
 *
 * @param {vscode.OutputChannel} outputChannel - VS Code output channel for logging
 * @param {string} command - Executable to run
 * @param {string[]} args - Command arguments
 * @param {string} cwd - Working directory
 * @returns {Promise<void>}
 */
function runCommand(outputChannel, command, args, cwd) {
    return new Promise((resolve, reject) => {
        outputChannel.appendLine(`Running: ${command} ${args.join(' ')}`);

        const proc = spawn(command, args, {
            cwd,
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        proc.stdout.on('data', (data) => {
            outputChannel.append(data.toString());
        });

        proc.stderr.on('data', (data) => {
            outputChannel.append(data.toString());
        });

        proc.on('close', (code) => {
            if (code === 0) {
                outputChannel.appendLine('Command completed successfully');
                resolve();
            } else {
                outputChannel.appendLine(`Command failed with code ${code}`);
                reject(new Error(`Process exited with code ${code}`));
            }
        });

        proc.on('error', (error) => {
            outputChannel.appendLine(`Command error: ${error.message}`);
            reject(error);
        });
    });
}

/**
 * Run an mpremote command using the virtual environment Python.
 *
 * @param {vscode.OutputChannel} outputChannel - VS Code output channel
 * @param {string[]} args - Arguments to pass to `python -m mpremote`
 * @returns {Promise<string>} stdout from the command
 */
function runMpremote(outputChannel, args) {
    return new Promise((resolve, reject) => {
        const venvFolder = getVenvPythonPathFolder();
        const venvPython = getVenvPythonPath(venvFolder);

        // Validate Python executable exists
        if (!venvPython || !fs.existsSync(venvPython)) {
            const errorMsg = `Python executable not found: ${venvPython}. Run "Setup Environment" first.`;
            console.error(errorMsg);
            outputChannel.appendLine(`Error: ${errorMsg}`);
            return reject(new Error(errorMsg));
        }

        // Build command with proper quoting for paths with spaces
        const command = `"${venvPython}" -m mpremote ${args.map(arg =>
            arg.includes(' ') ? `"${arg}"` : arg
        ).join(' ')}`;

        outputChannel.appendLine(`Executing: mpremote ${args.join(' ')}`);

        let child = null;
        const timeout = setTimeout(() => {
            if (child) child.kill();
            const errorMsg = 'mpremote command timed out after 30 seconds';
            outputChannel.appendLine(`Error: ${errorMsg}`);
            reject(new Error(errorMsg));
        }, 30000);

        child = exec(command, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
            clearTimeout(timeout);

            if (error) {
                outputChannel.appendLine(`mpremote error: ${error.message}`);

                if (stderr && (stderr.includes('No device found') || stderr.includes('could not open port'))) {
                    reject(new Error(`Device connection error: ${stderr.trim()}`));
                } else {
                    reject(new Error(`Command failed: ${error.message}`));
                }
                return;
            }

            // Log warnings from stderr (non-fatal)
            if (stderr && stderr.trim()) {
                const ignorePatterns = ['No device found', 'could not open port', 'Warning:'];
                const relevantStderr = stderr.split('\n')
                    .filter(line => line.trim() && !ignorePatterns.some(p => line.includes(p)))
                    .join('\n');

                if (relevantStderr) {
                    outputChannel.appendLine(`Warning: ${stderr.trim()}`);
                }
            }

            if (stdout && stdout.trim()) {
                outputChannel.appendLine(`Output:\n${stdout.trim()}`);
                resolve(stdout.trim());
            } else {
                outputChannel.appendLine('Command executed successfully (no output)');
                resolve('');
            }
        });
    });
}

/**
 * Get list of connected MicroPython devices via mpremote.
 *
 * @returns {Promise<Array<{port: string, vidpid: string}>>}
 */
async function getConnectedDevices() {
    const venvFolder = getVenvPythonPathFolder();
    const venvPython = getVenvPythonPath(venvFolder);

    return new Promise((resolve) => {
        const command = `"${venvPython}" -m mpremote connect list`;

        exec(command, (error, stdout) => {
            if (error) {
                resolve([]);
                return;
            }

            const lines = stdout.trim().split('\n').filter(Boolean);
            const devices = lines.map(line => {
                const parts = line.trim().split(/\s+/);
                const port = parts[0];
                const vidpid = parts[2] || '0000:0000';
                return { port, vidpid };
            });

            resolve(devices);
        });
    });
}

module.exports = {
    runCommand,
    runMpremote,
    getConnectedDevices
};