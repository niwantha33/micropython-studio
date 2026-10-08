const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildWifiScanScript, parseWifiScanOutput } = require('../src/wifiScan');

suite('Dashboard Wi-Fi scan on MicroPython and CircuitPython', () => {
  test('builds both network.WLAN and CircuitPython wifi.radio code', () => {
    const code = buildWifiScanScript();
    assert.ok(code.includes('network.WLAN(network.STA_IF)'));
    assert.ok(code.includes('sta.scan()'));
    assert.ok(code.includes('wifi.radio.start_scanning_networks()'));
    assert.ok(code.includes('wifi.radio.stop_scanning_networks()'));
    assert.ok(code.includes('finally:'));
    assert.ok(code.includes('MPS_WIFI_ERROR|'));
    assert.ok(code.includes('json.dumps('));
  });

  test('parses Pico W or ESP32 RSSI results without losing UTF-8 SSIDs', () => {
    const output = [
      'mpremote: running file', 'MPS_WIFI_SCAN_BEGIN',
      'MPS_WIFI_AP|{"ssid": "Guest|IoT", "rssi": -75}',
      'MPS_WIFI_AP|{"ssid": "Home 🏠", "rssi": -36}',
      'MPS_WIFI_SCAN_END', '>>>',
    ].join('\r\n');
    assert.deepStrictEqual(parseWifiScanOutput(output), [
      { ssid: 'Home 🏠', rssi: -36 },
      { ssid: 'Guest|IoT', rssi: -75 },
    ]);
  });

  test('represents successful scan with zero APs as an empty array', () => {
    assert.deepStrictEqual(
      parseWifiScanOutput('MPS_WIFI_SCAN_BEGIN\nMPS_WIFI_SCAN_END\n'), []
    );
  });

  test('does not misreport ImportError or driver errors as zero networks', () => {
    const raw = 'MPS_WIFI_SCAN_BEGIN\nMPS_WIFI_ERROR|OSError: WLAN driver unavailable\nMPS_WIFI_SCAN_END';
    assert.throws(() => parseWifiScanOutput(raw), /Board Wi-Fi scan failed: OSError/);
    assert.throws(() => parseWifiScanOutput(''), /No complete Wi-Fi scan response/);
    assert.throws(() => parseWifiScanOutput('MPS_WIFI_SCAN_BEGIN'), /No complete Wi-Fi scan response/);
  });

  test('rejects malformed AP JSON and ignores unrelated serial noise', () => {
    assert.throws(
      () => parseWifiScanOutput('MPS_WIFI_SCAN_BEGIN\nMPS_WIFI_AP|wrong\nMPS_WIFI_SCAN_END'),
      /malformed/
    );
    assert.deepStrictEqual(parseWifiScanOutput(
      'MPS_WIFI_SCAN_BEGIN\nTrace: noise\nMPS_WIFI_AP|{"ssid":"IoT","rssi":-60}\nMPS_WIFI_SCAN_END'
    ), [{ssid:'IoT', rssi:-60}]);
  });

  test('dashboard reuses the existing daemon, reports errors and escapes AP labels', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..','src','deviceDashboard.js'),'utf8');
    assert.ok(src.includes('connectionManager.runCodeSilently(scriptContent)'));
    assert.ok(src.includes('connectionManager.portName === devicePort'));
    assert.ok(src.includes('parseWifiScanOutput(raw)'));
    assert.ok(src.includes('command: "wifiScanError"'));
    assert.ok(src.includes("ssidSelect.appendChild(item)"));
    assert.ok(src.includes("error.textContent = 'Scan failed: '"));
    assert.ok(!src.includes('No networks found. Try again.'));
  });

  test('script execution now rejects backend exit failures rather than returning an empty list', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '..','src','deviceDashboard.js'),'utf8');
    assert.ok(src.includes('reject(new Error("Device command failed: " + reason))'));
    assert.ok(src.includes('Device port is busy with a transfer.'));
    assert.ok(src.includes('wsQueue.run(async () => {'));
  });
});
