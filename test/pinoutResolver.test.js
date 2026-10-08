const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {resolvePinoutKey} = require('../src/pinoutResolver');

const data = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'resource', 'pinouts', 'pinouts.json'), 'utf8'
));

suite('Board-specific pinout safety', () => {
    test('actual S3 uname overrides generic ESP32 device.cfg', () => {
        assert.strictEqual(resolvePinoutKey('esp32', 'esp32', 'Generic ESP32S3 module with ESP32-S3', data), 'esp32_s3');
    });
    test('C3 and S2 never resolve to classic ESP32', () => {
        assert.strictEqual(resolvePinoutKey('esp32','esp32-c3','Generic ESP32C3',data),'esp32_c3');
        assert.strictEqual(resolvePinoutKey('esp32','esp32-s2','Generic ESP32S2',data),'esp32_s2');
        assert.strictEqual(resolvePinoutKey('esp32','esp32','ESP32-C3-MINI-1',data),'esp32_c3');
    });
    test('Pico W and Pico 2 W resolve correctly by uname', () => {
        assert.strictEqual(resolvePinoutKey('rp2','rp2','Raspberry Pi Pico 2 W with RP2350',data),'rp2350_w');
        assert.strictEqual(resolvePinoutKey('rp2','rp2','Raspberry Pi Pico W with RP2040',data),'rp2_w');
    });
    test('unknown platform cannot silently display first Pico diagram', () => {
        assert.strictEqual(resolvePinoutKey('unknown','','unknown',data),null);
    });
    test('generic reference cannot pass as exact dual-USB C3 carrier pinout', () => {
        assert.strictEqual(data.esp32_c3.reference_only,true);
        assert.strictEqual(data.esp32_c3.left.length,0);
        assert.strictEqual(data.esp32_c3.right.length,0);
        assert.ok(data.esp32_c3.note.includes('unverified'));
    });
    test('30-pin ESP32 and all Pico headers have matching sides', () => {
        assert.strictEqual(data.esp32.left.length,15);
        assert.strictEqual(data.esp32.right.length,15);
        for(const k of ['rp2','rp2_w','rp2350','rp2350_w']) {
            assert.strictEqual(data[k].left.length,20);
            assert.strictEqual(data[k].right.length,20);
        }
    });
});
