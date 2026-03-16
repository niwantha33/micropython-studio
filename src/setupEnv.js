/**
 * setupEnv.js
 * Virtual environment setup and Python dependency installation
 * @license MIT
 * @version 2.0
 * @author  Niwantha Meepage
 */

const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const { runCommand } = require('./runCommand');
const { getMicropythonStudioPath, getVenvPythonPath } = require('./commonFxn');

/**
 * Detect which Python command is available on this system.
 * Tries 'python3' first (Linux/macOS), then 'python' (Windows).
 *
 * @returns {Promise<string>} The working Python command name
 */
async function getPythonCommand() {
    return new Promise((resolve) => {
        exec('python3 --version', (py3Error) => {
            if (!py3Error) {
                resolve('python3');
            } else {
                exec('python --version', (pyError) => {
                    if (!pyError) {
                        resolve('python');
                    } else {
                        // Neither found — default to 'python' and let the
                        // caller handle the error when it actually fails
                        resolve('python');
                    }
                });
            }
        });
    });
}

/**
 * Set up a Python virtual environment with all MicroPython tools.
 * Creates ~/.micropython-studio/.venv and installs dependencies.
 *
 * @param {vscode.ExtensionContext} context
 * @param {vscode.OutputChannel} outputChannel
 * @returns {Promise<string>} Path to the venv Python executable
 */
async function setupVirtualEnv(context, outputChannel) {
    const micropythonStudioDir = getMicropythonStudioPath();
    const venvPath = path.join(micropythonStudioDir, '.venv');
    const requirementsPath = path.resolve(path.join(context.extensionPath, 'requirements.txt'));

    try {
        // Create base directory
        await fs.mkdir(micropythonStudioDir, { recursive: true });

        // Check if venv already exists
        let venvExists = false;
        try {
            await fs.access(venvPath);
            venvExists = true;
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }

        const venvPython = getVenvPythonPath(venvPath);

        if (venvExists) {
            // Venv already exists — just install/update packages without recreating it
            outputChannel.appendLine('Virtual environment exists. Installing new packages...');
            try {
                await fs.access(requirementsPath);
                await runCommand(
                    outputChannel,
                    venvPython,
                    ['-m', 'pip', 'install', '-r', requirementsPath],
                    micropythonStudioDir
                );
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
                outputChannel.appendLine('requirements.txt not found. Nothing to update.');
            }
        } else {
            const pythonExecutable = await getPythonCommand();
            outputChannel.appendLine('Setting up MicroPython virtual environment...');

            // 1. Create virtual environment
            await runCommand(outputChannel, pythonExecutable, ['-m', 'venv', venvPath], micropythonStudioDir);

            // 2. Upgrade pip
            await runCommand(
                outputChannel,
                venvPython,
                ['-m', 'pip', 'install', '--upgrade', 'pip'],
                micropythonStudioDir
            );

            // 3. Install requirements
            try {
                await fs.access(requirementsPath);
                await runCommand(
                    outputChannel,
                    venvPython,
                    ['-m', 'pip', 'install', '-r', requirementsPath],
                    micropythonStudioDir
                );
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;

                // Fallback: install default packages
                outputChannel.appendLine('requirements.txt not found. Installing default packages.');
                const packages = [
                    'pyserial', 'adafruit-ampy', 'rshell', 'esptool',
                    'mpremote', 'mpflash', 'micropython-stubber',
                    'micropython-rp2-pico_w-stubs', 'code2flow'
                ];
                await runCommand(outputChannel, venvPython, ['-m', 'pip', 'install', ...packages], micropythonStudioDir);
            }
        }

        vscode.window.showInformationMessage(
            venvExists ? 'Packages updated successfully!' : 'Virtual environment setup complete!'
        );
        return venvPython;
    } catch (error) {
        vscode.window.showErrorMessage(`Virtual environment setup failed: ${error.message}`);
        console.error('Venv setup error:', error);
        throw error;
    }
}

module.exports = { setupVirtualEnv };