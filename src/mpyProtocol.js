const connectionManager = require('./connectionManager');
const { EventEmitter } = require('events');

class MpyProtocol extends EventEmitter {
    constructor(connManager) {
        super();
        this.conn = connManager;
        
        // Output buffer for programmatic execution
        this._in_raw_repl = false;
        this._buffer = Buffer.alloc(0);
        this._waitingForPrompt = false;
        this._promptResolve = null;

        this.conn.on('data', (data) => {
            if (this._in_raw_repl) {
                this._buffer = Buffer.concat([this._buffer, data]);
                if (this._waitingForPrompt && this._buffer.toString('utf8').endsWith('>')) {
                    this._waitingForPrompt = false;
                    if (this._promptResolve) {
                        const res = this._promptResolve;
                        this._promptResolve = null;
                        res();
                    }
                }
            } else {
                // Not programmatic, emit normal terminal data
                // Only if the connection isn't locked by a background task, 
                // but we let connectionManager or caller handle UI routing
                this.emit('terminal_data', data);
            }
        });
    }

    /**
     * Reads until a specific ending sequence is found.
     */
    async _readUntil(endingBytes, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.conn.removeListener('data', onData);
                reject(new Error('Timeout waiting for: ' + endingBytes.toString('hex')));
            }, timeoutMs);

            const onData = () => {
                if (this._buffer.includes(endingBytes)) {
                    clearTimeout(timeout);
                    this.conn.removeListener('data', onData);
                    resolve();
                }
            };

            if (this._buffer.includes(endingBytes)) {
                clearTimeout(timeout);
                resolve();
            } else {
                this.conn.on('data', onData);
            }
        });
    }

    async enterRawRepl(softReset = true) {
        this._in_raw_repl = true;
        this._buffer = Buffer.alloc(0);

        // ctrl-C: interrupt any running program
        await this.conn.write(Buffer.from('\r\x03'));
        await new Promise(r => setTimeout(r, 100)); // drain time

        // ctrl-A: enter raw REPL
        await this.conn.write(Buffer.from('\r\x01'));

        if (softReset) {
            await this._readUntil(Buffer.from('raw REPL; CTRL-B to exit\r\n>'));
            this._buffer = Buffer.alloc(0);
            
            // ctrl-D: soft reset
            await this.conn.write(Buffer.from('\x04'));
            await this._readUntil(Buffer.from('soft reboot\r\n'));
        }

        await this._readUntil(Buffer.from('raw REPL; CTRL-B to exit\r\n'));
        this._buffer = Buffer.alloc(0);
    }

    async exitRawRepl() {
        await this.conn.write(Buffer.from('\r\x02')); // ctrl-B: enter friendly REPL
        this._in_raw_repl = false;
    }

    /**
     * Execute python code via the raw paste protocol (\x05A\x01)
     */
    async execRawPaste(codeString) {
        const codeBytes = Buffer.from(codeString, 'utf8');

        // Wait for prompt
        await this._readUntil(Buffer.from('>'));
        this._buffer = Buffer.alloc(0);

        // Enter raw paste mode
        await this.conn.write(Buffer.from('\x05A\x01'));
        
        await this._readUntil(Buffer.from('R\x01'), 2000);
        
        // Next 2 bytes are window size (little endian)
        // Wait until we have at least 2 bytes past the 'R\x01'
        while (this._buffer.length < this._buffer.indexOf(Buffer.from('R\x01')) + 4) {
            await new Promise(r => setTimeout(r, 10));
        }

        const idx = this._buffer.indexOf(Buffer.from('R\x01'));
        const windowSize = this._buffer.readUInt16LE(idx + 2);
        
        this._buffer = this._buffer.subarray(idx + 4);

        let windowRemain = windowSize;
        let i = 0;

        while (i < codeBytes.length) {
            // Process any flow-control ACKs
            while (windowRemain === 0 || this._buffer.length > 0) {
                if (this._buffer.length === 0) {
                    await new Promise(r => setTimeout(r, 5));
                    continue;
                }
                const b = this._buffer[0];
                this._buffer = this._buffer.subarray(1);
                
                if (b === 0x01) {
                    windowRemain += windowSize;
                } else if (b === 0x04) {
                    // Abort
                    await this.conn.write(Buffer.from('\x04'));
                    throw new Error('Device aborted raw paste');
                } else {
                    throw new Error('Unexpected byte in raw paste: ' + b);
                }
            }

            const chunk = codeBytes.subarray(i, Math.min(i + windowRemain, codeBytes.length));
            await this.conn.write(chunk);
            windowRemain -= chunk.length;
            i += chunk.length;
        }

        // Indicate end of code
        await this.conn.write(Buffer.from('\x04'));

        // Wait for acknowledgment of end of data
        await this._readUntil(Buffer.from('\x04'));
        this._buffer = Buffer.alloc(0); // clear past ack

        // Now wait for execution output
        // Output format: <stdout>\x04<stderr>\x04>
        await this._readUntil(Buffer.from('\x04'));
        const outIdx = this._buffer.indexOf(Buffer.from('\x04'));
        const stdoutBuf = this._buffer.subarray(0, outIdx);
        // "OK" prefix might be prepended by MicroPython before stdout
        let stdout = stdoutBuf.toString('utf8');
        if (stdout.startsWith('OK')) stdout = stdout.substring(2);

        this._buffer = this._buffer.subarray(outIdx + 1);

        await this._readUntil(Buffer.from('\x04'));
        const errIdx = this._buffer.indexOf(Buffer.from('\x04'));
        const stderr = this._buffer.subarray(0, errIdx).toString('utf8');
        
        this._buffer = this._buffer.subarray(errIdx + 1);

        return { stdout, stderr };
    }

    /**
     * Helper to lock the port, run a command silently, and return output.
     */
    async runCodeSilently(codeString) {
        const release = await this.conn.acquireLock();
        try {
            await this.enterRawRepl(false);
            const result = await this.execRawPaste(codeString);
            await this.exitRawRepl();
            return result;
        } finally {
            release();
        }
    }
}

const mpyProtocol = new MpyProtocol(connectionManager);
module.exports = mpyProtocol;
