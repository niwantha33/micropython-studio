'use strict';

const vscode = require('vscode');
const connectionManager = require('./connectionManager');
const { StringDecoder } = require('string_decoder');
const { samePort } = require('./devicePortSelection');
const { onDebugExecutionState, getDebugExecutionState } = require('./debugExecutionState');

let activeTerminal = null;
let activePort = null;
let activeReady = null;

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

    if (activeTerminal && samePort(activePort, devicePort)) {
        activeTerminal.show();
        if (activeReady) await activeReady;
        // Opening an existing Shell after a daemon crash must reconnect it,
        // rather than showing a terminal with permanently dead input/output.
        if (!connectionManager.isConnected) {
            await connectionManager.connect(devicePort);
        }
        if (connectionManager.isConnected && samePort(connectionManager.portName, devicePort)
            && connectionManager.isSuspended) {
            vscode.window.showInformationMessage('REPL is temporarily busy with a device operation. It will be available when the owner resumes it.');
        }
        return;
    }

    if (activeTerminal) {
        // Changing COM ports is an explicit user action. The old terminal
        // detaches its listeners but never disconnects other device features.
        activeTerminal.dispose();
        activeTerminal = null;
        activePort = null;
        activeReady = null;
    }

    const emitter = new vscode.EventEmitter();
    let terminal = null;
    let closed = false;
    const decoder = new StringDecoder('utf8');
    // VS Code creates the PTY asynchronously. A Run action must wait for its
    // receiver and serial connection, or quick print() output is lost.
    let finishReady;
    let failReady;
    const ready = new Promise((resolve, reject) => {
        finishReady = resolve;
        failReady = reject;
    });
    let readySettled = false;
    const readyTimeout = setTimeout(() => {
        settleReady(new Error('REPL terminal did not open within 12 seconds.'));
    }, 12000);
    function settleReady(error) {
        if (readySettled) return;
        readySettled = true;
        clearTimeout(readyTimeout);
        if (error) failReady(error);
        else finishReady();
    }

    const emit = text => { if (!closed) emitter.fire(text); };
    // Serial RX may split a multibyte UTF-8 character between read() calls.
    const onData = data => emit(decoder.write(data));
    const onRunStarted = () => emit(terminalNotice(
        'MCU script running on ' + devicePort + '. Output is live; press Ctrl+C to interrupt.'
    ));
    const onRunFinished = result => {
        if (!result.success) {
            emit(terminalNotice('MCU execution/serial error: ' + result.error +
                '. Reconnect the REPL if no prompt appears.'));
            return;
        }
        if (connectionManager.isConnected && !connectionManager.isSuspended) {
            emit('\r\n>>> ');
        }
    };
    const onDebugState = state => {
        if (!state.replPort || !samePort(state.replPort, devicePort)) return;
        if (state.status === 'paused') {
            const source = state.location?.path
                ? ' at ' + state.location.path.split(/[\\/]/).pop() + ':' + state.location.line : '';
            emit(terminalNotice('MicroPython VM PAUSED by debugger ' + state.debugPort +
                source + '. No new print() output appears until Continue or Step.'));
        } else if (state.status === 'running') {
            emit(terminalNotice('MicroPython VM resumed by debugger; target output can continue.'));
        }
    };
    const debugSubscription = onDebugExecutionState(onDebugState);
    const onConnected = () => {
        emit(terminalNotice(`Connected to ${devicePort}. Press Enter to see the REPL prompt.`));
    };
    const onDisconnected = () => emit(terminalNotice('Device disconnected. Check the selected COM port and USB cable.'));
    const onError = err => emit(terminalNotice(`REPL connection error: ${err.message}`));

    const listeners = [
        ['data', onData], ['connected', onConnected],
        ['disconnected', onDisconnected], ['error', onError],
        ['run-started', onRunStarted], ['run-finished', onRunFinished],
    ];
    for (const [name, listener] of listeners) connectionManager.on(name, listener);

    const pty = {
        onDidWrite: emitter.event,
        open: async () => {
            emit(terminalNotice(`Opening REPL on ${devicePort} (no reset or interrupt sent).`));
            onDebugState(getDebugExecutionState());
            try {
                if (connectionManager.isConnected && samePort(connectionManager.portName, devicePort)) {
                    if (connectionManager.isSuspended)
                        emit(terminalNotice('REPL temporarily busy with another device operation. No reset was sent.'));
                    else onConnected();
                } else {
                    await connectionManager.connect(devicePort);
                }
                settleReady();
            } catch (err) {
                emit(terminalNotice(`Could not connect to ${devicePort}: ${err.message}`));
                settleReady(err);
            }
        },
        close: () => {
            settleReady(new Error('REPL terminal closed before it was ready.'));
            closed = true;
            for (const [name, listener] of listeners) {
                connectionManager.removeListener(name, listener);
            }
            debugSubscription.dispose();
            decoder.end();
            emitter.dispose();
            if (activeTerminal === terminal) {
                activeTerminal = null;
                activePort = null;
                activeReady = null;
            }
        },
        handleInput: async data => {
            if (!connectionManager.isConnected || connectionManager.isSuspended
                || connectionManager.isLocked || !samePort(connectionManager.portName, devicePort)) {
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
    activeReady = ready;
    terminal.show();
    await ready;
}

module.exports = { openDeviceTerminal };
