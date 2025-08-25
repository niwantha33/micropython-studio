/**
 * runcommand.js
 * run only executable commands 
 * @license MIT
 * @version 1.0
 * @author  Niwantha Meepage 
 */

const vscode = require('vscode');
const { exec, spawn } = require('child_process');
const { getVenvPythonPathFolder, getVenvPythonPath } = require('./commonFxn')

// Helper function to run commands
function runCommand(outputChannel, command, args, cwd) {
    return new Promise((resolve, reject) => {
        outputChannel.appendLine(`Running: ${command} ${args.join(' ')}`);
        console.log(`Running: ${command} ${args.join(' ')}`);

        const process = spawn(command, args, {
            cwd,
            shell: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });

        process.stdout.on('data', (data) => {
            outputChannel.append(data.toString());
        });

        process.stderr.on('data', (data) => {
            outputChannel.append(data.toString());
        });

        process.on('close', (code) => {
            if (code === 0) {
                outputChannel.appendLine('Command completed successfully');
                resolve();
            } else {
                outputChannel.appendLine(`Command failed with code ${code}`);
                reject(new Error(`Process exited with code ${code}`));
            }
        });

        process.on('error', (error) => {
            outputChannel.appendLine(`Command error: ${error.message}`);
            reject(error);
        });
    });
}

/*Example usage*********************************************************************************************
try {
    const result = await runMpremote(outputChannel, ['connect', 'list']);
    console.log('Devices:', result);
} catch (error) {
    if (error.message.includes('Device connection error')) {
        vscode.window.showErrorMessage('No MicroPython device found. Please connect a device.');
    } else {
        vscode.window.showErrorMessage(`mpremote error: ${error.message}`);
    }
}

*************************************************************************************************************/
function runMpremote(outputChannel, args) {
    return new Promise((resolve, reject) => {
        try {
            const venvFolder = getVenvPythonPathFolder();
            const venvPython = getVenvPythonPath(venvFolder);

            // Validate Python executable exists
            if (!venvPython || !require('fs').existsSync(venvPython)) {
                const errorMsg = `Python executable not found: ${venvPython}`;
                console.error(`❌ ${errorMsg}`);
                outputChannel.appendLine(`❌ ${errorMsg}`);
                return reject(errorMsg);
            }

            // Build command with proper quoting for paths with spaces
            const command = `"${venvPython}" -m mpremote ${args.map(arg =>
                arg.includes(' ') ? `"${arg}"` : arg
            ).join(' ')}`;

            console.log(`🔧 Running: ${command}`);
            outputChannel.appendLine(`🔧 Executing: mpremote ${args.join(' ')}`);

            // Set a timeout for the command execution (30 seconds)
            const timeout = setTimeout(() => {
                const errorMsg = 'mpremote command timed out after 30 seconds';
                console.error(`❌ ${errorMsg}`);
                outputChannel.appendLine(`❌ ${errorMsg}`);
                reject(errorMsg);
            }, 30000);

            exec(command, { maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
                // Clear the timeout
                clearTimeout(timeout);

                if (error) {
                    console.error(`❌ mpremote error: ${error.message}`);
                    outputChannel.appendLine(`❌ mpremote error: ${error.message}`);

                    // Check if it's a connection error vs. other error
                    if (stderr && stderr.includes('No device found') ||
                        stderr && stderr.includes('could not open port')) {
                        reject(new Error(`Device connection error: ${stderr.trim()}`));
                    } else {
                        reject(new Error(`Command failed: ${error.message}`));
                    }
                    return;
                }

                // Handle stderr (warnings and non-fatal errors)
                if (stderr && stderr.trim()) {
                    // Filter out common non-error messages
                    const ignorePatterns = [
                        'No device found',
                        'could not open port',
                        'Warning:'
                    ];

                    const relevantStderr = stderr.split('\n').filter(line =>
                        line.trim() && !ignorePatterns.some(pattern => line.includes(pattern))
                    ).join('\n');

                    if (relevantStderr) {
                        console.warn(`⚠️ mpremote stderr: ${stderr.trim()}`);
                        outputChannel.appendLine(`⚠️ mpremote stderr: ${stderr.trim()}`);
                    }
                }

                // Handle stdout
                if (stdout && stdout.trim()) {
                    console.log(`📤 mpremote output: ${stdout.trim()}`);
                    outputChannel.appendLine(`📤 mpremote output:\n${stdout.trim()}`);
                    resolve(stdout.trim());
                } else {
                    // Even with no output, resolve successfully
                    outputChannel.appendLine('✅ Command executed successfully (no output)');
                    resolve('');
                }
            });
        } catch (setupError) {
            console.error(`❌ Setup error: ${setupError.message}`);
            outputChannel.appendLine(`❌ Setup error: ${setupError.message}`);
            reject(setupError);
        }
    });
}

function passCommandMpremoteTerminal(mpremoteTerminal, RemoteDevicePort) {

    if (RemoteDevicePort == null) {
        vscode.window.showErrorMessage("Failed to open device communication port");
        vscode.window.showWarningMessage("Right click on the 'main' folder click Refresh command");
    }

    const venvFolder = getVenvPythonPathFolder();
    const venvPython = getVenvPythonPath(venvFolder);

    try {
        // Check if terminal exists and is still valid
        if (mpremoteTerminal) {
            // For VSCode API, we check if the terminal is still valid
            // by checking if it has been disposed or has an exit status
            const isTerminalValid =
                mpremoteTerminal.exitStatus === undefined ||
                mpremoteTerminal.exitStatus === null;

            if (isTerminalValid) {
                return mpremoteTerminal;
            }
        }

        // Create a new terminal if none exists or the existing one is invalid
        mpremoteTerminal = vscode.window.createTerminal({
            name: "MicroPython-Studio",
            shellPath: venvPython,
            shellArgs: ["-m", "mpremote", 'connect', `${RemoteDevicePort}`],
            hideFromUser: false  // Changed to false to make it visible to users
        });

        // Show the terminal to the user
        mpremoteTerminal.show(true);

        return mpremoteTerminal;
    } catch (error) {
        mpremoteTerminal
        console.error("Failed to create MicroPython terminal:", error);
        vscode.window.showErrorMessage("Failed to create MicroPython terminal: " + error.message);

        // Fallback: create a basic terminal
        return vscode.window.createTerminal("MicroPython Studio Fallback Terminal");
    }
}


async function detectAndConfirmDevice(config) {

    const venvFolder = getVenvPythonPathFolder();
    const venvPython = getVenvPythonPath(venvFolder);

    return new Promise(async (resolve) => {
        try {
            const command = `${venvPython} -m mpremote connect list`;

            exec(command, async (error, stdout, stderr) => {
                if (error) {
                    // Show error but don't block project creation
                    vscode.window.showWarningMessage(
                        "Could not detect connected devices. You can configure the port later in device.cfg",
                        "OK"
                    );

                    // Return default values
                    resolve({
                        port: null,
                        vidpid: null,
                        confirmed: false
                    });
                    return;
                }

                let copyVidpid = null;
                const lines = stdout.trim().split('\n').filter(Boolean);
                const devices = lines.map(line => {
                    const [port, , vidpid] = line.trim().split(/\s+/);
                    let mcuType = 'Unknown';

                    if (vidpid === '2e8a:0005') {
                        mcuType = `${config.selectedMcuTarget}`;
                        copyVidpid = vidpid;
                    } else if (vidpid.includes('10c4') || vidpid.includes('0403')) {
                        mcuType = 'ESP32';
                        copyVidpid = vidpid;
                    } else if (vidpid.includes('0483')) {
                        mcuType = 'STM32';
                        copyVidpid = vidpid;
                    }

                    return {
                        label: port,
                        description: mcuType,
                        vidpid: vidpid
                    };
                });

                if (devices.length > 0) {
                    // Devices found - ask user to confirm
                    const selected = await vscode.window.showQuickPick(devices, {
                        placeHolder: 'Select your MicroPython device (or press Escape to skip)'
                    });

                    if (selected) {
                        // User selected a device
                        const confirm = await vscode.window.showInformationMessage(
                            `Use ${selected.label} as your device port?`,
                            "Yes", "No"
                        );

                        if (confirm === "Yes") {
                            resolve({
                                port: selected.label,
                                vidpid: selected.vidpid,
                                confirmed: true
                            });
                        } else {
                            // User said no, treat as no device
                            resolve({
                                port: null,
                                vidpid: null,
                                confirmed: false
                            });
                        }
                    } else {
                        // User pressed Escape
                        resolve({
                            port: null,
                            vidpid: null,
                            confirmed: false
                        });
                    }
                } else {
                    // No devices found
                    vscode.window.showInformationMessage(
                        "No MicroPython devices detected. You can configure the port later in device.cfg",
                        "OK"
                    );

                    resolve({
                        port: null,
                        vidpid: null,
                        confirmed: false
                    });
                }
            });
        } catch (error) {
            console.error("Device detection error:", error);

            // Show error but don't block project creation
            vscode.window.showWarningMessage(
                "Error during device detection. You can configure the port later in device.cfg",
                "OK"
            );

            resolve({
                port: null,
                vidpid: null,
                confirmed: false
            });
        }
    });
}



async function getConnectedDevices() {

    const venvFolder = getVenvPythonPathFolder();
    const venvPython = getVenvPythonPath(venvFolder);
    return new Promise((resolve) => {
        const command = `${venvPython} -m mpremote connect list`;

        exec(command, (error, stdout, stderr) => {
            if (error) {
                resolve([]); // Return empty array if no devices found
                return;
            }

            const lines = stdout.trim().split('\n').filter(Boolean);
            const devices = lines.map(line => {
                const [port, , vidpid] = line.trim().split(/\s+/);
                return { port, vidpid };
            });

            resolve(devices);
        });
    });
}

// Export the async function
module.exports = { runCommand, runMpremote, passCommandMpremoteTerminal, detectAndConfirmDevice, getConnectedDevices };