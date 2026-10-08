'use strict';

// Same marked protocol for MicroPython (RP2/ESP32) and CircuitPython.
// Each AP is JSON encoded to preserve unusual SSIDs and RSSI values.
const BEGIN = 'MPS_WIFI_SCAN_BEGIN';
const END = 'MPS_WIFI_SCAN_END';
const AP = 'MPS_WIFI_AP|';
const ERROR = 'MPS_WIFI_ERROR|';

function buildWifiScanScript() {
  return [
    'import json',
    "print('MPS_WIFI_SCAN_BEGIN')",
    'try:',
    '    try:',
    '        import network',
    '    except ImportError:',
    '        network = None',
    "    if network is not None and hasattr(network, 'WLAN'):",
    '        sta = network.WLAN(network.STA_IF)',
    '        if not sta.active():',
    '            sta.active(True)',
    '        for ap in sta.scan():',
    "            ssid = ap[0].decode('utf-8', 'replace') if isinstance(ap[0], bytes) else str(ap[0])",
    '            if ssid:',
    "                print('MPS_WIFI_AP|' + json.dumps({'ssid': ssid, 'rssi': int(ap[3])}))",
    '    else:',
    '        import wifi',
    '        scanning = wifi.radio.start_scanning_networks()',
    '        try:',
    '            for ap in scanning:',
    '                if ap.ssid:',
    "                    print('MPS_WIFI_AP|' + json.dumps({'ssid': str(ap.ssid), 'rssi': int(ap.rssi)}))",
    '        finally:',
    '            wifi.radio.stop_scanning_networks()',
    'except Exception as e:',
    "    print('MPS_WIFI_ERROR|' + type(e).__name__ + ': ' + str(e))",
    'finally:',
    "    print('MPS_WIFI_SCAN_END')",
  ].join('\n') + '\n';
}

function parseWifiScanOutput(raw) {
  const lines = String(raw || '').split(/\r?\n/).map(x => x.trim());
  const begin = lines.findIndex(l => l === BEGIN);
  const end = lines.findIndex((l, i) => i > begin && l === END);
  if (begin < 0 || end < 0) {
    throw new Error('No complete Wi-Fi scan response from device. Check the REPL COM port and raw device errors.');
  }
  const networks = [];
  for (const line of lines.slice(begin + 1, end)) {
    if (line.startsWith(ERROR)) {
      throw new Error('Board Wi-Fi scan failed: ' + line.slice(ERROR.length).slice(0, 300));
    }
    if (!line.startsWith(AP)) continue;
    let entry;
    try {
      entry = JSON.parse(line.slice(AP.length));
    } catch (_) {
      throw new Error('Board returned a malformed Wi-Fi scan record.');
    }
    if (typeof entry.ssid !== 'string' || !entry.ssid ||
        !Number.isFinite(entry.rssi)) {
      throw new Error('Board returned an invalid Wi-Fi scan record.');
    }
    networks.push({ ssid: entry.ssid, rssi: entry.rssi });
  }
  return networks.sort((a, b) => b.rssi - a.rssi);
}

module.exports = { buildWifiScanScript, parseWifiScanOutput };
