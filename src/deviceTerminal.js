'use strict';

const vscode = require('vscode');
const connectionManager = require('./connectionManager');
const { StringDecoder } = require('string_decoder');

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
            vscode.window.showInformationMessage('REPL is temporarily busy with a device operation. It will be available when the owner resumes it.');
        } else if (!connectionManager.isConnected) {
            // Keep one terminal per port but allow explicit Shell clicks to
            // recover a disconnected USB daemon without closing the tab.
            try {
                await connectionManager.connect(devicePort);
            } catch (err) {
                vscode.window.showErrorMessage('Cannot reconnect REPL: ' + err.message);
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
    const utf8Decoder = new StringDecoder('utf8');
    let terminal = null;
    let closed = false;

    const emit = text => { if (!closed) emitter.fire(text); };
    const onData = data => emit(utf8Decoder.write(data));
    const onConnected = () => {
        emit(terminalNotice(`Connected to ${devicePort}. Press Enter for >>>. If your script is running, press Ctrl+C to interrupt it. Opening Shell does not reset the board.`));
    };
    const onReconnecting = () => emit(terminalNotice('USB connection interrupted. Attempting to restore COM without resetting the board...'));
    const onDisconnected = () => emit(terminalNotice('Device disconnected. Click Shell to reconnect, or verify the USB cable and COM port.'));
    const onError = err => emit(terminalNotice(`REPL connection error: ${err.message}`));

    const listeners = [
        ['data', onData], ['connected', onConnected],
        ['disconnected', onDisconnected], ['reconnecting', onReconnecting], ['error', onError],
    ];
    for (const [name, listener] of listeners) connectionManager.on(name, listener);

    const pty = {
        onDidWrite: emitter.event,
        open: async () => {
            emit(terminalNotice(`Opening REPL on ${devicePort} (no reset or interrupt sent).`));
            try {
                if (connectionManager.isConnected && connectionManager.portName === devicePort) {
                    if (connectionManager.isSuspended)
                        emit(terminalNotice('REPL temporarily busy with another device operation. No reset was sent.'));
                    else onConnected();
                } else {
                    await connectionManager.connect(devicePort);
                }
            } catch (err) {
                emit(terminalNotice(`Could not connect to ${devicePort}: ${err.message}`));
            }
        },
        close: () => {
            emit(utf8Decoder.end());
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
