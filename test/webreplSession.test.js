const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildSessionWebReplScript, parseSessionWebReplResult, buildWebReplStatusScript, parseWebReplStatus, resolveUsbReplPort } = require('../src/webreplSession');

suite('WebREPL session-only dashboard startup', () => {
    test('start script reuses connected WLAN without writing device files', () => {
        const script = buildSessionWebReplScript('testpass');
        assert.ok(script.includes('network.WLAN(network.STA_IF)'));
        assert.ok(script.includes('webrepl.start(password='));
        assert.ok(script.includes('MPS_WEBREPL_OK|'));
        assert.ok(!script.includes('boot.py'));
        assert.ok(!script.includes('webrepl_cfg.py'));
        assert.ok(!script.includes('open('));
    });
    test('parses success through unrelated REPL output', () => {
        assert.strictEqual(parseSessionWebReplResult('>>>\r\nMPS_WEBREPL_OK|10.20.100.198\r\n'), '10.20.100.198');
    });
    test('reports actual Python exceptions and incomplete output', () => {
        assert.throws(
            () => parseSessionWebReplResult('MPS_WEBREPL_ERROR|OSError: no network interface'),
            /no network interface/
        );
        assert.throws(() => parseSessionWebReplResult('>>>'), /did not confirm startup/);
        assert.throws(() => parseSessionWebReplResult('MPS_WEBREPL_OK|999.1.1.1'), /invalid IPv4/);
    });
    test('checks password length before executing code', () => {
        assert.throws(() => buildSessionWebReplScript('abc'), /4–9/);
        assert.throws(() => buildSessionWebReplScript('x'.repeat(10)), /4–9/);
    });
    test('uses active REPL daemon and no boot.py overwrite in dashboard', () => {
        const dash = fs.readFileSync(path.join(__dirname,'..','src','deviceDashboard.js'),'utf8');
        assert.ok(dash.includes('manager.runCodeSilently(code)'));
        assert.ok(dash.includes('parseSessionWebReplResult(raw)'));
        assert.ok(dash.includes('command: "webReplError"'));
        assert.ok(dash.includes("if (msg.command === 'webReplError')"));
        assert.ok(dash.includes('Listener active — boot.py unchanged'));
        assert.ok(dash.includes('if (!running) {'));
        assert.ok(dash.includes('buildWebReplStatusScript()'));
        assert.ok(!dash.includes("with open('boot.py', 'w')"));
        assert.ok(!dash.includes('micro123'));
    });
    test('detects pre-existing WebREPL from a read-only board query', () => {
        const script = buildWebReplStatusScript();
        assert.ok(script.includes('webrepl.listen_s'));
        assert.ok(script.includes('MPS_WEBREPL_STATUS|RUNNING'));
        assert.ok(!script.includes('webrepl.start('));
        assert.ok(!script.includes('webrepl.stop('));
        assert.ok(!script.includes('open('));
        assert.ok(script.includes("\n"));
    });
    test('parse status when listener already running on Pico 2 W', () => {
        const raw = '>>>\r\nMPS_WEBREPL_STATUS|RUNNING|10.20.100.198\r\n';
        assert.deepStrictEqual(parseWebReplStatus(raw), {state:'RUNNING',ip:'10.20.100.198'});
        assert.deepStrictEqual(parseWebReplStatus('MPS_WEBREPL_STATUS|STOPPED|192.168.0.35'), {state:'STOPPED',ip:'192.168.0.35'});
        assert.throws(() => parseWebReplStatus('MPS_WEBREPL_STATUS|RUNNING|999.1.1.1'), /Invalid/);
        assert.throws(() => parseWebReplStatus(''), /did not report/);
    });
    test('uses COM8 shared daemon even when dashboard was switched to ws: URL', () => {
        const manager = {isConnected:true,isSuspended:false,portName:'COM8'};
        assert.strictEqual(resolveUsbReplPort('ws:10.20.100.198,examplepass',manager),'COM8');
        assert.strictEqual(resolveUsbReplPort('COM8',manager),'COM8');
        assert.strictEqual(resolveUsbReplPort('ws:10.20.100.198,examplepass',
            {...manager,isSuspended:true}),null);
        assert.strictEqual(resolveUsbReplPort('ws:10.20.100.198,examplepass',
            {...manager,isConnected:false}),null);
    });
    test('stopping WebREPL sends actual newlines without changing boot.py', () => {
        const dash = fs.readFileSync(path.join(__dirname,'..','src','deviceDashboard.js'),'utf8');
        assert.ok(dash.includes('const stopScript = ['));
        assert.ok(dash.includes('MPS_WEBREPL_STOP_OK'));
        assert.ok(dash.includes('].join("\\n");'));
        assert.ok(!dash.includes("with open('boot.py', 'w')"));
    });
    test('Dashboard tells users WebREPL is optional without touching USB debugging', () => {
        const dash = fs.readFileSync(path.join(__dirname, '..', 'src', 'deviceDashboard.js'), 'utf8');
        const bridge = fs.readFileSync(path.join(__dirname, '..', 'src', 'webrepl_bridge.py'), 'utf8');
        assert.ok(dash.includes('Optional · PC must reach this board on TCP 8266.'));
        assert.ok(dash.includes('USB REPL/debugger work without it.'));
        assert.ok(dash.includes('Checking WebREPL…'));
        assert.ok(!dash.includes('Starting WebREPL daemon…'));
        assert.ok(bridge.includes('WebREPL is optional.'));
        assert.ok(bridge.includes('this PC can reach its IP on TCP 8266'));
        assert.ok(bridge.includes('USB REPL/debugging do not need WebREPL.'));
    });
    test('does not print passwords in configuration logs', () => {
        const cfg = fs.readFileSync(path.join(__dirname,'..','src','commonFxn.js'),'utf8');
        assert.ok(cfg.includes('[REDACTED]'));
        assert.ok(cfg.includes('const displayValue = /password|secret|token|api')); 
        assert.ok(cfg.includes('console.log(`Updated ${key} in [${section}] to "${displayValue}"`)'));
    });
});
