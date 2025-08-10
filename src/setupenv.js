/**
 * setupenv.js
 * setup virtual environment and install neccessary files 
 * @license MIT
 * @version 1.0
 * @author  Niwantha Meepage 
 */

const vscode = require('vscode');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
// user defined functions 
const  {runCommand} =require('./runcommand');

// Helper: Detect working Python command
async function getPythonCommand() {
    return new Promise((resolve) => {
        exec('python3 --version', (py3Error) => {
            if (!py3Error) {
                resolve('python3');
            } else {
                exec('python --version', (pyError) => {
                    resolve(pyError ? 'python' : 'python3');
                });
            }
        });
    });
}

// Helper: Get Python path[execute] in venv
function getVenvPythonPath(venvPath) {
    const isWindows = process.platform === 'win32';
    return path.join(
        venvPath,
        isWindows ? 'Scripts/python.exe' : 'bin/python'
    );
}
 
async function setupVirtualEnv(context, outputChannel) {    
    const micropythonStudioDir = path.join(os.homedir(), '.micropython-studio');
    const venvFolder = '.venv';
    const venvPath = path.join(micropythonStudioDir, venvFolder);
    const requirementsPath = path.resolve(path.join(context.extensionPath, 'requirements.txt'));

    try {
        // Create base directory
        await fs.mkdir(micropythonStudioDir, { recursive: true });

        // Check if venv already exists
        try {
            await fs.access(venvPath);
            vscode.window.showInformationMessage('MicroPython virtual environment already exists.');
            return getVenvPythonPath(venvPath);
        } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        const pythonExecutable = await getPythonCommand();        
        outputChannel.appendLine('Setting up MicroPython virtual environment...');

        // 1. Create virtual environment
        await runCommand(outputChannel, pythonExecutable, ['-m', 'venv', venvPath], micropythonStudioDir);

        const venvPython = getVenvPythonPath(venvPath);

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

            // Install default packages
            outputChannel.appendLine('requirements.txt not found. Installing default packages.');
            const packages = [
                'pyserial', 'adafruit-ampy', 'rshell', 'esptool',
                'mpremote', 'mpflash', 'micropython-stubber',
                'micropython-rp2-pico_w-stubs', 'code2flow'
            ];
            await runCommand(outputChannel, venvPython, ['-m', 'pip', 'install', ...packages], micropythonStudioDir);
        }
        vscode.window.showInformationMessage('Virtual environment setup complete!');
        return venvPython;
    } catch (error) {
        vscode.window.showErrorMessage(`Virtual environment setup failed: ${error.message}`);
        console.error('Venv setup error:', error);
        throw error;
    }
}

// Export the async function
module.exports = { setupVirtualEnv };