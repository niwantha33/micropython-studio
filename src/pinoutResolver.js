'use strict';

// Board identity is not the same as sys.platform: rp2 covers RP2040/RP2350
// and esp32 covers S2/S3/C3/other ESP32 targets. Prefer the actual MCU model.
function resolvePinoutKey(platform, mcuFromCfg, machineStr, data) {
    const pinouts = data || {};
    const known = key => Object.prototype.hasOwnProperty.call(pinouts, key);
    const machine = String(machineStr || '').toLowerCase();
    const cfg = String(mcuFromCfg || '').toLowerCase().trim();
    const sys = String(platform || '').toLowerCase().trim();

    const patterns = [
        [/pico[\s_-]*2[\s_-]*w|rp2350[\s_-]*w/, 'rp2350_w'],
        [/pico[\s_-]*2|rp2350/, 'rp2350'],
        [/pico[\s_-]*w|rp2040[\s_-]*w/, 'rp2_w'],
        [/pico|rp2040/, 'rp2'],
        [/esp32[\s_-]*s3/, 'esp32_s3'],
        [/esp32[\s_-]*s2/, 'esp32_s2'],
        [/esp32[\s_-]*c3/, 'esp32_c3'],
        [/esp8266/, 'esp8266'],
        [/stm32.*f4/, 'stm32_f4'],
        [/samd51/, 'samd51'],
        [/samd21/, 'samd21'],
        [/nrf52840/, 'nrf52840'],
        [/mimxrt1010/, 'mimxrt1010'],
    ];
    const match = str => {
        for (const [re,key] of patterns) if (re.test(str) && known(key)) return key;
        return null;
    };
    // An explicit exact board configuration beats a generic machine family.
    if (known(cfg) && !['rp2','esp32'].includes(cfg)) return cfg;
    // A specific chip identity reported by firmware beats generic "esp32" cfg.
    const actual = match(machine);
    if (actual) return actual;
    const configured = match(cfg);
    if (configured) return configured;
    if (known(cfg)) return cfg;
    if (known(sys)) return sys;
    // Never silently display an unrelated Pico pinout for unknown hardware.
    return null;
}

module.exports = {resolvePinoutKey};
