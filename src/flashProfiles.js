'use strict';

/**
 * Board-specific offsets for a SINGLE official MicroPython full .bin image,
 * not generic ESP-IDF bootloader/partition/app bundles.
 * https://micropython.org/download/ESP32_GENERIC/
 * https://micropython.org/download/ESP32_GENERIC_S3/
 * https://micropython.org/download/ESP32_GENERIC_C3/
 * https://micropython.org/download/ESP32_GENERIC_C6/
 * https://micropython.org/download/ESP8266_GENERIC/
 *
 * For unverified chips, require the existing Advanced interface and explicit
 * address selection. Never silently guess an offset for a bootloader.
 */
const SIMPLE_PROFILES = Object.freeze({
    esp32:   { label: 'ESP32 (classic)', offset: '0x1000', board: 'ESP32_GENERIC' },
    esp32s2: { label: 'ESP32-S2', offset: '0x1000', board: 'ESP32_GENERIC_S2' },
    esp32s3: { label: 'ESP32-S3', offset: '0x0', board: 'ESP32_GENERIC_S3' },
    esp32c3: { label: 'ESP32-C3', offset: '0x0', board: 'ESP32_GENERIC_C3' },
    esp32c6: { label: 'ESP32-C6', offset: '0x0', board: 'ESP32_GENERIC_C6' },
    esp8266: { label: 'ESP8266', offset: '0x0', board: 'ESP8266_GENERIC' }
});

function getSimpleFlashProfile(chip) {
    return Object.prototype.hasOwnProperty.call(SIMPLE_PROFILES, chip)
        ? SIMPLE_PROFILES[chip] : null;
}

function prepareSimpleFirmwareRows(chip, savedRows) {
    const profile = getSimpleFlashProfile(chip);
    if (!profile) throw new Error('No verified one-image profile for this chip. Use Advanced Flashing.');
    const first = Array.isArray(savedRows) && savedRows[0] ? savedRows[0] : {};
    // The address is always determined by the chosen chip, never a stale
    // globalState saved offset from a different device.
    return [
        { enabled: true, path: typeof first.path === 'string' ? first.path : '', offset: profile.offset },
        { enabled: false, path: '', offset: '0x0' },
        { enabled: false, path: '', offset: '0x8000' },
        { enabled: false, path: '', offset: '0xe000' }
    ];
}

module.exports = { SIMPLE_PROFILES, getSimpleFlashProfile, prepareSimpleFirmwareRows };
