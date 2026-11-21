'use strict';

// Native VS Code Debug Adapter Protocol integration.
// Reuses the qualified Studio debugger bridge and its breakpoint/CDC ownership.
// Deliberately does not flash firmware, upload helpers, or claim unsupported DAP capabilities.
const vscode = require('vscode');
const path = require('path');
const {
    connectNativeDebugger, sendNativeCommand, disconnectNativeDebugger
} = require('./mpyDebugger');
const { parseDebuggerReply } = require('./nativeDebugParser');

const DEBUG_TYPE = 'micropython-studio';

class NativeMicroPythonAdapter {
    constructor(context, config, venvPython) {
        this.context = context;
        this.config = config;
        this.venvPython = venvPython;
        this.emitter = new vscode.EventEmitter();
        this.onDidSendMessage = this.emitter.event;
        this.seq = 1;
        this.ready = false;
        this.paused = false;
        this.terminated = false;
        this.connected = false;
        this.location = null;
        this.localNames = [];
        this.locals = [];
        this.globals = [];
        this.frames = [];
        this.breakpoints = new Map();
        this.nextBreakpointId = 1;
    }

    sendEvent(event, body = {}) {
        if (!this.terminated || event === 'terminated') {
            this.emitter.fire({ type: 'event', event, body, seq: this.seq++ });
        }
    }

    respond(request, body = {}, error) {
        this.emitter.fire({
            type: 'response', seq: this.seq++, request_seq: request.seq,
            command: request.command, success: !error, body,
            ...(error ? { message: String(error) } : {})
        });
    }

    terminate() {
        if (this.terminated) return;
        this.terminated = true;
        this.connected = false;
        this.ready = false;
        this.sendEvent('terminated');
    }

    _onBridgeEvent(msg) {
        if (this.terminated) return;
        if (msg.evt === 'pump_ready') {
            this.ready = true;
            this.sendEvent('output', { category: 'console', output: 'MicroPython debug CDC ready (firmware verified handshake).\n' });
        } else if (msg.evt === 'breakpoints') {
            for (const item of msg.items || []) {
                if (!item.fsPath || !Number.isInteger(item.line1)) continue;
                const key = item.fsPath + ':' + item.line1;
                const old = this.breakpoints.get(key);
                if (!old) continue;
                const verified = item.state === 'VERIFIED';
                if (old.verified === verified && old.state === item.state) continue;
                old.verified = verified;
                old.state = item.state;
                this.sendEvent('breakpoint', {
                    reason: 'changed', breakpoint: {
                        id: old.id, verified,
                        source: { name: path.basename(item.fsPath), path: item.fsPath },
                        line: item.line1,
                        message: verified ? 'Verified on MicroPython target' : item.state
                    }
                });
            }
        } else if (msg.evt === 'bp_hit' || msg.evt === 'step_line' || msg.evt === 'exception') {
            // Pauses with no verified source mapping stay address-only; do not invent lines.
            if (msg.evt === 'step_line' && msg.file && Number.isInteger(msg.line) && msg.line > 0) {
                this.location = { path: msg.file, line: msg.line, name: path.basename(msg.file, '.py') };
            } else if (msg.evt !== 'step_line') {
                this.location = msg.location?.path && msg.location.line > 0 ? msg.location : null;
                this.localNames = Array.isArray(msg.localNames) ? msg.localNames : [];
            }
            this.paused = true;
            this.locals = [];
            this.globals = [];
            this.frames = [];
            this.sendEvent('stopped', {
                reason: msg.evt === 'exception' ? 'exception' : msg.evt === 'step_line' ? 'step' : 'breakpoint',
                description: msg.evt === 'exception' ? String(msg.msg || 'Device exception') : undefined,
                threadId: 1, allThreadsStopped: true
            });
            if (msg.evt === 'step_line') {
                sendNativeCommand('call_stack');
            }
        } else if (msg.evt === 'reply' && this.paused) {
            const parsed = parseDebuggerReply(msg.text, this.localNames);
            if (parsed?.kind === 'locals') this.locals = parsed.values;
            if (parsed?.kind === 'globals') this.globals = parsed.values;
            if (parsed?.kind === 'stack') this.frames = parsed.frames;
            if (parsed) this.sendEvent('invalidated', { areas: ['variables', 'stackTrace'], threadId: 1 });
        } else if (msg.evt === 'sent' && ['continue', 'step', 'step_in', 'step_out'].includes(msg.op)) {
            this.paused = false;
            this.sendEvent('continued', { threadId: 1, allThreadsContinued: true });
        } else if (msg.evt === 'transport_lost' || msg.evt === 'error') {
            this.sendEvent('output', { category: 'stderr', output: String(msg.msg || 'Debug transport error') + '\n' });
            if (msg.evt === 'transport_lost') this.terminate();
        } else if (msg.evt === 'closed') {
            this.terminate();
        }
    }

    _sourceBreakpoints(request) {
        const args = request.arguments || {};
        const file = args.source?.path;
        if (!file || !file.endsWith('.py')) {
            this.respond(request, { breakpoints: (args.breakpoints || []).map(bp => ({
                verified: false, line: bp.line, message: 'Only local Python sources can be debugged.'
            })) });
            return;
        }
        const input = args.breakpoints || [];
        const desired = new Map(input.map(bp => [bp.line, bp]));
        const existing = vscode.debug.breakpoints.filter(bp =>
            bp instanceof vscode.SourceBreakpoint && bp.location.uri.fsPath === file);
        const remove = existing.filter(bp => !desired.has(bp.location.range.start.line + 1));
        if (remove.length) vscode.debug.removeBreakpoints(remove);
        const add = input.filter(bp => !existing.some(old =>
            old.location.range.start.line + 1 === bp.line)).map(bp => new vscode.SourceBreakpoint(
            new vscode.Location(vscode.Uri.file(file), new vscode.Position(Math.max(0, bp.line - 1), 0)),
            true, bp.condition, bp.hitCondition, bp.logMessage
        ));
        if (add.length) vscode.debug.addBreakpoints(add);
        const result = input.map(bp => {
            const key = file + ':' + bp.line;
            const record = this.breakpoints.get(key) || { id: this.nextBreakpointId++, verified: false, state: 'PENDING' };
            this.breakpoints.set(key, record);
            return {
                id: record.id, verified: record.verified, line: bp.line,
                source: { name: path.basename(file), path: file },
                message: record.verified ? 'Verified on target' : 'Awaiting target breakpoint registration'
            };
        });
        for (const key of this.breakpoints.keys()) {
            if (key.startsWith(file + ':') && !desired.has(Number(key.slice(file.length + 1)))) this.breakpoints.delete(key);
        }
        this.respond(request, { breakpoints: result });
    }

    async handleMessage(request) {
        if (!request || request.type !== 'request') return;
        const args = request.arguments || {};
        try {
            switch (request.command) {
                case 'initialize':
                    this.respond(request, {
                        supportsConfigurationDoneRequest: true,
                        supportsEvaluateForHovers: true,
                        supportsTerminateRequest: true,
                        supportsInvalidatedEvent: true,
                        supportsStepBack: false,
                        supportsSetVariable: false,
                        supportsRestartRequest: false
                    });
                    this.sendEvent('initialized');
                    break;
                case 'launch':
                case 'attach':
                    if (!this.config.debugPort) throw new Error('Dedicated debugger COM port is required.');
                    connectNativeDebugger(this.context, this.config.debugPort, this.venvPython, evt => this._onBridgeEvent(evt));
                    this.connected = true;
                    this.respond(request);
                    break;
                case 'configurationDone':
                    this.respond(request);
                    break;
                case 'setBreakpoints':
                    this._sourceBreakpoints(request);
                    break;
                case 'setExceptionBreakpoints':
                    this.respond(request, { breakpoints: [] });
                    break;
                case 'threads':
                    this.respond(request, { threads: [{ id: 1, name: 'MicroPython VM' }] });
                    break;
                case 'stackTrace': {
                    const frames = [];
                    if (this.paused) {
                        if (this.location) {
                            frames.push({
                                id: 1, name: this.location.name || 'MicroPython',
                                line: this.location.line, column: 1,
                                source: { name: path.basename(this.location.path), path: this.location.path }
                            });
                        } else {
                            frames.push({ id: 1, name: 'Paused (source not mapped)', line: 0, column: 0 });
                        }
                        // The firmware supplies VM function pointers, but not always source locations.
                        for (let i = 1; i < this.frames.length && i < 32; i++) {
                            const frame = this.frames[i];
                            frames.push({ id: i + 1, name: 'VM function 0x' + frame.fun.toString(16) +
                                ' / ip 0x' + frame.ip.toString(16), line: 0, column: 0 });
                        }
                    }
                    this.respond(request, { stackFrames: frames, totalFrames: frames.length });
                    break;
                }
                case 'scopes':
                    this.respond(request, { scopes: [
                        { name: 'Locals', variablesReference: 1, expensive: false },
                        { name: 'Globals', variablesReference: 2, expensive: true }
                    ] });
                    break;
                case 'variables':
                    this.respond(request, { variables: args.variablesReference === 1 ? this.locals :
                        args.variablesReference === 2 ? this.globals : [] });
                    break;
                case 'evaluate': {
                    const expression = String(args.expression || '').trim();
                    const variable = [...this.locals, ...this.globals].find(v => v.name === expression);
                    if (!this.paused || !/^[A-Za-z_]\w*$/.test(expression) || !variable) {
                        this.respond(request, { result: '<not available: read-only variable lookup>', variablesReference: 0 });
                    } else {
                        this.respond(request, { result: variable.value, variablesReference: 0 });
                    }
                    break;
                }
                case 'continue':
                case 'next':
                case 'stepIn':
                case 'stepOut': {
                    const op = { continue: 'continue', next: 'step', stepIn: 'step_in', stepOut: 'step_out' }[request.command];
                    if (!this.ready || !this.paused || !sendNativeCommand(op)) {
                        throw new Error('Debugger is not ready or the target is not paused.');
                    }
                    this.respond(request, request.command === 'continue' ? { allThreadsContinued: true } : {});
                    break;
                }
                case 'disconnect':
                case 'terminate':
                    this.respond(request);
                    disconnectNativeDebugger();
                    this.terminate();
                    break;
                case 'pause':
                    throw new Error('Pause is not supported by this firmware; stop at a breakpoint instead.');
                default:
                    this.respond(request, {}, 'Unsupported debug adapter request: ' + request.command);
            }
        } catch (error) {
            this.respond(request, {}, error.message || String(error));
            if (request.command === 'launch' || request.command === 'attach') this.terminate();
        }
    }

    dispose() {
        if (!this.terminated && this.connected) disconnectNativeDebugger();
        this.terminate();
        this.emitter.dispose();
    }
}

function registerNativeDebugger(context, getReplPort, getPython) {
    const provider = {
        provideDebugConfigurations() {
            return [{ name: 'MicroPython Studio: Native Debugger', type: DEBUG_TYPE,
                request: 'launch', replPort: getReplPort() || '', debugPort: '' }];
        },
        async resolveDebugConfiguration(_folder, config) {
            if (!config.type) config.type = DEBUG_TYPE;
            if (!config.request) config.request = 'launch';
            if (!config.name) config.name = 'MicroPython Studio: Native Debugger';
            if (!config.replPort) config.replPort = getReplPort() || '';
            const repl = String(config.replPort || '').trim();
            if (!repl || repl === '-' || repl.startsWith('ws:')) {
                vscode.window.showErrorMessage('Select the USB REPL/upload port first. Native debugging uses a separate debug CDC.');
                return undefined;
            }
            if (!config.debugPort) config.debugPort = await vscode.window.showInputBox({
                prompt: 'MicroPython debugger CDC port (different from REPL)',
                placeHolder: 'e.g. COM13'
            });
            const debugPort = String(config.debugPort || '').trim();
            if (!debugPort) return undefined;
            if (debugPort.toUpperCase() === repl.toUpperCase()) {
                vscode.window.showErrorMessage('Debugger CDC must be different from the REPL/upload COM port.');
                return undefined;
            }
            config.replPort = repl;
            config.debugPort = debugPort;
            return config;
        }
    };
    context.subscriptions.push(vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, provider));
    context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
        createDebugAdapterDescriptor(session) {
            return new vscode.DebugAdapterInlineImplementation(
                new NativeMicroPythonAdapter(context, session.configuration, getPython()));
        }
    }));
}

module.exports = { registerNativeDebugger, NativeMicroPythonAdapter, DEBUG_TYPE };
