'use strict';

const vscode = require('vscode');
const connectionManager = require('./connectionManager');

let activeTerminal = null;
let activePort = null;

function terminalNotice(message) {
    return `\x1b[90m${message}\x1b[0m\r\n`;
}

/**
 * Open a passive, interactive REPL: opening/closing the VS Code panel
 * must never send Ctrl-C, Ctrl-D, run code or reset the MCU.
 *
 * The connection manager is shared with the file browser/other features,
 * so closing the terminal only unsubscribes this terminal's listeners.
 */
async function openDeviceTerminal(_context, devicePort) {
    if (!devicePort) {
        vscode.window.showErrorMessage('Choose the MicroPython REPL port first.');
        return;
    }

    if (activeTerminal && activePort === devicePort) {
        activeTerminal.show();
        if (connectionManager.isConnected && connectionManager.portName === devicePort
            && connectionManager.isSuspended) {
            try {
                await connectionManager.resume();
            } catch (err) {
                vscode.window.showWarningMessage(`REPL resume failed: ${err.message}`);
            }
        }
        return;
    }

    if (activeTerminal) {
        // Changing COM ports is an explicit user action. The old terminal
        // detaches its listeners but never disconnects other device features.
        activeTerminal.dispose();
        activeTerminal = null;
        activePort = null;
    }

    const emitter = new vscode.EventEmitter();
    let terminal = null;
    let closed = false;

    const emit = text => { if (!closed) emitter.fire(text); };
    const onData = data => emit(data.toString('utf8'));
    const onConnected = () => {
        emit(terminalNotice(`Connected to ${devicePort}. Press Enter to see the REPL prompt.`));
    };
    const onDisconnected = () => emit(terminalNotice('Device disconnected. Check the selected COM port and USB cable.'));
    const onError = err => emit(terminalNotice(`REPL connection error: ${err.message}`));

    const listeners = [
        ['data', onData], ['connected', onConnected],
        ['disconnected', onDisconnected], ['error', onError],
    ];
    for (const [name, listener] of listeners) connectionManager.on(name, listener);

    const pty = {
        onDidWrite: emitter.event,
        open: async () => {
            emit(terminalNotice(`Opening REPL on ${devicePort} (no reset or interrupt sent).`));
            try {
                if (connectionManager.isConnected && connectionManager.portName === devicePort) {
                    if (connectionManager.isSuspended) await connectionManager.resume();
                    else onConnected();
                } else {
                    await connectionManager.connect(devicePort);
                }
            } catch (err) {
                emit(terminalNotice(`Could not connect to ${devicePort}: ${err.message}`));
            }
        },
        close: () => {
            closed = true;
            for (const [name, listener] of listeners) {
                connectionManager.removeListener(name, listener);
            }
            emitter.dispose();
            if (activeTerminal === terminal) {
                activeTerminal = null;
                activePort = null;
            }
        },
        handleInput: async data => {
            if (!connectionManager.isConnected || connectionManager.isSuspended
                || connectionManager.isLocked || connectionManager.portName !== devicePort) {
                emit(terminalNotice('REPL is unavailable while another operation owns the serial port.'));
                return;
            }
            try {
                // Match backspace behaviour expected by MicroPython friendly REPL.
                const bytes = Buffer.from(data);
                for (let i = 0; i < bytes.length; ++i) {
                    if (bytes[i] === 127) bytes[i] = 8;
                }
                await connectionManager.write(bytes);
            } catch (err) {
                emit(terminalNotice(`Cannot send REPL input: ${err.message}`));
            }
        }
    };

    terminal = vscode.window.createTerminal({ name: `MicroPython REPL (${devicePort})`, pty });
    activeTerminal = terminal;
    activePort = devicePort;
    terminal.show();
}

module.exports = { openDeviceTerminal };
