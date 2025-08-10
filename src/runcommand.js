/**
 * runcommand.js
 * run only executable commands 
 * @license MIT
 * @version 1.0
 * @author  Niwantha Meepage 
 */

const {spawn } = require('child_process');

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

// Export the async function
module.exports = { runCommand };