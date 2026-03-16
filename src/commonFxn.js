/**
 * commonFxn.js
 * Shared utility functions for MicroPython Studio
 * @license MIT
 * @version 2.0
 * @author  Niwantha Meepage
 */

const os = require('os');
const fs = require('fs').promises;
const path = require('path');

/**
 * Get the MicroPython Studio home directory path.
 * @returns {string} Absolute path to ~/.micropython-studio
 */
function getMicropythonStudioPath() {
    return path.join(os.homedir(), '.micropython-studio');
}

/**
 * Get the virtual environment folder path.
 * @returns {string} Absolute path to ~/.micropython-studio/.venv
 */
function getVenvPythonPathFolder() {
    return path.join(getMicropythonStudioPath(), '.venv');
}

/**
 * Get the Python executable path inside the virtual environment.
 * @param {string} venvPath - Path to the venv root folder
 * @returns {string} Absolute path to the python executable
 */
function getVenvPythonPath(venvPath) {
    const isWindows = process.platform === 'win32';
    return path.join(
        venvPath,
        isWindows ? 'Scripts' : 'bin',
        isWindows ? 'python.exe' : 'python'
    );
}

/**
 * Get the path to a tool executable inside the virtual environment.
 * @param {string} venvPath - Path to the venv root folder
 * @param {string} toolName - Tool name without extension (e.g. 'code2flow', 'mpy-cross')
 * @returns {string} Absolute path to the tool executable
 */
function getVenvToolPath(venvPath, toolName) {
    const isWindows = process.platform === 'win32';
    return path.join(
        venvPath,
        isWindows ? 'Scripts' : 'bin',
        isWindows ? `${toolName}.exe` : toolName
    );
}

/**
 * Read a value from a .cfg (INI-style) config file.
 *
 * @example
 * const port = await getConfigValue(
 *     path.join(projectDir, 'device.cfg'),
 *     'device',
 *     'port'
 * );
 *
 * @param {string} configPath - Absolute path to the config file
 * @param {string} section - Section name (e.g. 'device')
 * @param {string} key - Key name (e.g. 'port')
 * @returns {Promise<string|null>} The value, or null if not found
 */
async function getConfigValue(configPath, section, key) {
    try {
        try {
            await fs.access(configPath);
        } catch (error) {
            if (error.code === 'ENOENT') {
                console.log(`Config file doesn't exist yet: ${configPath}`);
                return null;
            }
            throw error;
        }

        const data = await fs.readFile(configPath, 'utf8');
        const lines = data.split(/\r?\n/);

        let inSection = false;

        for (const line of lines) {
            const trimmedLine = line.trim();

            // Skip empty lines and comments
            if (!trimmedLine || trimmedLine.startsWith(';') || trimmedLine.startsWith('#')) {
                continue;
            }

            // Match section header: [device]
            const sectionMatch = trimmedLine.match(/^\[([^\]]+)\]$/);
            if (sectionMatch) {
                inSection = sectionMatch[1] === section;
                continue;
            }

            // If we're in the right section, look for key = value
            if (inSection) {
                const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const keyMatch = trimmedLine.match(new RegExp(`^${escapedKey}\\s*=\\s*(.*)$`));
                if (keyMatch && keyMatch[1] !== undefined) {
                    let value = keyMatch[1].trim();

                    // Remove surrounding quotes if present
                    if ((value.startsWith('"') && value.endsWith('"')) ||
                        (value.startsWith("'") && value.endsWith("'"))) {
                        value = value.slice(1, -1);
                    }

                    return value;
                }
            }
        }

        console.log(`Key '${key}' not found in section '[${section}]'`);
        return null;
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error(`Error reading config: ${err.message}`);
        }
        return null;
    }
}

/**
 * Update a value in a .cfg (INI-style) config file.
 * Creates the section and key if they don't exist.
 *
 * @example
 * await updateCfgComponent(
 *     path.join(projectDir, 'device.cfg'),
 *     'device',
 *     'last_sync',
 *     new Date().toISOString()
 * );
 *
 * @param {string} cfgFilePath - Absolute path to the config file
 * @param {string} section - Section name
 * @param {string} key - Key name
 * @param {string} newValue - New value to set
 */
async function updateCfgComponent(cfgFilePath, section, key, newValue) {
    console.log(`Updating ${cfgFilePath} -> [${section}] ${key} = "${newValue}"`);

    try {
        const data = await fs.readFile(cfgFilePath, 'utf8');
        const lines = data.split(/\r?\n/);

        let inSection = false;
        let keyFound = false;
        let sectionExists = false;

        const newLines = lines.map(line => {
            const trimmedLine = line.trim();

            if (trimmedLine.startsWith('[') && trimmedLine.endsWith(']')) {
                inSection = trimmedLine === `[${section}]`;
                if (inSection) sectionExists = true;
                return line;
            }

            if (inSection && !keyFound) {
                const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const keyMatch = trimmedLine.match(new RegExp(`^${escapedKey}\\s*=`));
                if (keyMatch) {
                    keyFound = true;
                    return `${key} = "${newValue}"`;
                }
            }

            return line;
        });

        // If key wasn't found but section exists, add it at the end of the section
        if (sectionExists && !keyFound) {
            let sectionEndIndex = -1;
            for (let i = 0; i < newLines.length; i++) {
                if (newLines[i].trim() === `[${section}]`) {
                    for (let j = i + 1; j < newLines.length; j++) {
                        if (newLines[j].trim().startsWith('[') && newLines[j].trim().endsWith(']')) {
                            sectionEndIndex = j;
                            break;
                        }
                    }
                    break;
                }
            }

            if (sectionEndIndex === -1) sectionEndIndex = newLines.length;
            newLines.splice(sectionEndIndex, 0, `${key} = "${newValue}"`);
        }
        // If section doesn't exist, add both section and key
        else if (!sectionExists) {
            newLines.push(`[${section}]`, `${key} = "${newValue}"`);
        }

        await fs.writeFile(cfgFilePath, newLines.join('\n'));
        console.log(`Updated ${key} in [${section}] to "${newValue}"`);
    } catch (err) {
        console.error(`Error updating config: ${err.message}`);
        throw err;
    }
}

module.exports = {
    getMicropythonStudioPath,
    getVenvPythonPathFolder,
    getVenvPythonPath,
    getVenvToolPath,
    getConfigValue,
    updateCfgComponent
};