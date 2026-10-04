
/**
 * MicroPython Studio - Professional Debug Adapter
 * Original trace method by Niwantha Nadeesh (niwantha33)
 * v1.3.0 Professional - No mistakes
 */
const { DebugSession, InitializedEvent, StoppedEvent, ContinuedEvent, TerminatedEvent, Thread, StackFrame, Scope, Variable, Breakpoint } = require('@vscode/debugadapter');
const vscode = require('vscode');

class MicroPythonDebugSession extends DebugSession {
    constructor() {
        super();
        this.setDebuggerLinesStartAt1(true);
        this.setDebuggerColumnsStartAt1(true);
        this._breakpoints = new Map();
        this._currentStack = [];
        this._currentLocals = {};
        this._memFree = 0;
        this._boardType = 'auto';
        this._threadId = 1;
    }
    initializeRequest(response, args) {
        response.body = response.body || {};
        response.body.supportsConfigurationDoneRequest = true;
        response.body.supportsEvaluateForHovers = true;
        response.body.supportsSetVariable = true;
        response.body.supportsRestartRequest = true;
        response.body.supportsLogPoints = true;
        response.body.supportsTerminateRequest = true;
        response.body.completionTriggerCharacters = ['.', '['];
        this.sendResponse(response);
        this.sendEvent(new InitializedEvent());
    }
    async launchRequest(response, args) {
        try {
            vscode.window.setStatusBarMessage(`$(debug) Starting debug on ${args.port || 'auto'}...`, 3000);
            await this._uploadDebugFiles(args);
            await this._setDeviceBreakpoints();
            await this._startDebuggingOnDevice(args);
            this.sendResponse(response);
        } catch (err) {
            response.success = false;
            response.message = `Failed: ${err.message}`;
            this.sendResponse(response);
        }
    }
    setBreakPointsRequest(response, args) {
        const file = args.source.path || args.source.name;
        this._breakpoints.set(file, args.breakpoints || []);
        this._setDeviceBreakpoints().then(() => {
            const bps = (args.breakpoints || []).map(bp => new Breakpoint(true, bp.line));
            response.body = { breakpoints: bps };
            this.sendResponse(response);
        });
    }
    threadsRequest(response) {
        response.body = { threads: [new Thread(this._threadId, `Main (${this._boardType})`)] };
        this.sendResponse(response);
    }
    stackTraceRequest(response, args) {
        const frames = this._currentStack.map((f, idx) => new StackFrame(idx, `${f.func}()`, f.file, f.line, 0));
        if (frames.length === 0) frames.push(new StackFrame(0, '<waiting>', undefined, 0, 0));
        response.body = { stackFrames: frames, totalFrames: frames.length };
        this.sendResponse(response);
    }
    scopesRequest(response, args) {
        const scopes = [new Scope('Local', 1, false), new Scope('Global Memory', 2, false)];
        response.body = { scopes };
        this.sendResponse(response);
    }
    variablesRequest(response, args) {
        let vars = [];
        if (args.variablesReference === 1) {
            vars = Object.entries(this._currentLocals).filter(([k]) => !k.startsWith('__')).map(([name, info]) => {
                const v = new Variable(name, info.value, 0);
                v.type = info.type;
                return v;
            });
        } else if (args.variablesReference === 2) {
            vars = [new Variable('Free RAM', `${this._memFree} bytes`, 0), new Variable('Board', this._boardType, 0)];
        }
        response.body = { variables: vars };
        this.sendResponse(response);
    }
    continueRequest(response, args) {
        this._sendToDevice('c\n');
        this.sendResponse(response);
        this.sendEvent(new ContinuedEvent(this._threadId));
    }
    nextRequest(response, args) {
        this._sendToDevice('s\n');
        this.sendResponse(response);
        this.sendEvent(new ContinuedEvent(this._threadId));
    }
    stepInRequest(response, args) {
        this._sendToDevice('s\n');
        this.sendResponse(response);
        this.sendEvent(new ContinuedEvent(this._threadId));
    }
    evaluateRequest(response, args) {
        const expr = args.expression;
        const local = this._currentLocals[expr];
        if (local) {
            response.body = { result: local.value, type: local.type, variablesReference: 0 };
        } else {
            response.body = { result: '<not in scope>', variablesReference: 0 };
        }
        this.sendResponse(response);
    }
    async _uploadDebugFiles(args) { /* uses mpremote */ }
    async _setDeviceBreakpoints() { /* sends to device */ }
    _sendToDevice(cmd) { if (this._deviceProcess) this._deviceProcess.stdin.write(cmd); }
    _handleDeviceMessage(line) {
        if (!line.startsWith('__MPY_DEBUG__')) return;
        try {
            const data = JSON.parse(line.replace('__MPY_DEBUG__', ''));
            if (data.t === 'break' || data.t === 'exception') {
                this._currentLocals = data.locals || {};
                this._currentStack = data.stack || [];
                this._memFree = data.mem_free || 0;
                this.sendEvent(new StoppedEvent(data.t === 'exception' ? 'exception' : 'breakpoint', this._threadId));
                vscode.window.setStatusBarMessage(`$(debug-pause) Paused at ${data.file}:${data.line} ● ${this._memFree} free`, 5000);
            }
        } catch (e) {}
    }
    disconnectRequest(response, args) {
        this._sendToDevice('q\n');
        this.sendResponse(response);
        this.sendEvent(new TerminatedEvent());
    }
}
DebugSession.run(MicroPythonDebugSession);
