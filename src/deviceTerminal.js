const vscode = require('vscode');
const connectionManager = require('./connectionManager');

let activeTerminal = null;
let writeEmitter = null;

/**
 * Open the advanced device terminal natively in the VS Code bottom panel
 */
async function openDeviceTerminal(context, devicePort) {
    if (!devicePort) {
        vscode.window.showErrorMessage('No device port provided.');
        return;
    }

    if (activeTerminal) {
        activeTerminal.show();
        if (connectionManager.isConnected && connectionManager.portName === devicePort) {
            if (connectionManager.isSuspended) {
                await connectionManager.resume();
            }
            return;
        }
    } else {
        writeEmitter = new vscode.EventEmitter();
        
        const pty = {
            onDidWrite: writeEmitter.event,
            open: async () => {
                writeEmitter.fire(`\x1b[38;5;48mConnecting to ${devicePort}...\x1b[0m\r\n`);
                const wasConnected = connectionManager.isConnected;
                try {
                    await connectionManager.connect(devicePort);
                    if (!wasConnected) {
                        // Give the connection a brief moment to settle, then send Ctrl-C and Ctrl-D
                        // to soft-reboot the device and output the standard MicroPython version banner.
                        setTimeout(async () => {
                            try {
                                if (connectionManager.isConnected) {
                                    await connectionManager.write('\r\x03\x04');
                                }
                            } catch (err) {
                                console.error('Failed to trigger initial soft reset:', err);
                            }
                        }, 150);
                    }
                } catch (err) {
                    writeEmitter.fire(`\x1b[38;5;203mFailed to connect: ${err.message}\x1b[0m\r\n`);
                }
            },
            close: () => {
                connectionManager.disconnect();
                activeTerminal = null;
            },
            handleInput: async (data) => {
                if (connectionManager.isLocked || !connectionManager.isConnected) return;
                try {
                    const bytes = Buffer.from(data);
                    for (let i = 0; i < bytes.length; i++) {
                        if (bytes[i] === 127) bytes[i] = 8;
                    }
                    await connectionManager.write(bytes);
                } catch (err) {
                    console.error('Terminal write error:', err);
                }
            }
        };

        activeTerminal = vscode.window.createTerminal({ name: 'MicroPython Shell', pty });
    }

    // Clean up old listeners
    connectionManager.removeAllListeners('data');
    connectionManager.removeAllListeners('connected');
    connectionManager.removeAllListeners('disconnected');
    connectionManager.removeAllListeners('error');

    connectionManager.on('data', (data) => {
        if (writeEmitter) writeEmitter.fire(data.toString('utf8'));
    });

    connectionManager.on('connected', () => {
        if (writeEmitter) writeEmitter.fire(`\x1b[38;5;48m✔ Connected to ${devicePort}\x1b[0m\r\n`);
    });

    connectionManager.on('disconnected', () => {
        if (writeEmitter) writeEmitter.fire(`\x1b[38;5;203m✘ Disconnected\x1b[0m\r\n`);
    });

    connectionManager.on('error', (err) => {
        if (writeEmitter) writeEmitter.fire(`\x1b[38;5;203mTerminal Error: ${err.message}\x1b[0m\r\n`);
    });

    activeTerminal.show();
}

module.exports = { openDeviceTerminal };