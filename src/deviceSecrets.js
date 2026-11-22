'use strict';

/**
 * Project-scoped credentials stored in VS Code's OS-backed SecretStorage.
 * Existing plaintext device.cfg values are migrated on first use.
 *
 * Credentials are keyed by a hash of the absolute project config path, so
 * projects using different boards do not overwrite each other's passwords.
 */
const crypto = require('crypto');
const path = require('path');
const { getConfigValue, updateCfgComponent } = require('./commonFxn');

let secrets;
const ALLOWED_KEYS = new Set(['webrepl_password', 'webworkflow_password']);

function initializeSecretStorage(context) {
    if (!context || !context.secrets) {
        throw new Error('VS Code SecretStorage is required for device credentials.');
    }
    secrets = context.secrets;
}

function secretKey(cfgPath, key) {
    if (!ALLOWED_KEYS.has(key)) {
        throw new Error('Unsupported credential key: ' + key);
    }
    const hash = crypto.createHash('sha256').update(path.resolve(cfgPath)).digest('hex');
    return 'micropython-studio.device.' + hash + '.' + key;
}

function getStorage() {
    if (!secrets) throw new Error('SecretStorage is unavailable until extension activation.');
    return secrets;
}

/** Return the stored secret, removing any legacy plaintext copy from device.cfg. */
async function getDeviceSecret(cfgPath, key) {
    const storage = getStorage();
    const id = secretKey(cfgPath, key);
    let saved = await storage.get(id);
    const legacy = await getConfigValue(cfgPath, 'remote', key);

    // Earlier versions also wrote "ws:ip,password" into [device] port.
    // Preserve its password during the one-time migration and scrub the field.
    let embedded = null;
    if (key === 'webrepl_password') {
        const oldPort = await getConfigValue(cfgPath, 'device', 'port');
        const match = typeof oldPort === 'string' && /^ws:[^,]+,(.*)$/.exec(oldPort);
        if (match) {
            embedded = match[1];
            // Scrub only after the credential has been securely stored.
        }
    }
    if (legacy || embedded) {
        if (!saved) {
            saved = legacy || embedded;
            await storage.store(id, saved);
        }
        if (legacy) await updateCfgComponent(cfgPath, 'remote', key, '');
    }
    if (embedded !== null) await updateCfgComponent(cfgPath, 'device', 'port', 'NOT_SET');
    return saved || '';
}

/** Save secrets in VS Code's secure store, never in project configuration. */
async function setDeviceSecret(cfgPath, key, value) {
    const storage = getStorage();
    const id = secretKey(cfgPath, key);
    if (typeof value !== 'string') throw new TypeError('Credential must be a string.');
    if (value) await storage.store(id, value);
    else await storage.delete(id);
    // Clean up previously saved plaintext on successful secure storage.
    const legacy = await getConfigValue(cfgPath, 'remote', key);
    if (legacy) await updateCfgComponent(cfgPath, 'remote', key, '');
}

module.exports = { initializeSecretStorage, getDeviceSecret, setDeviceSecret };
