/**
 * runcommand.js
 * run only executable commands 
 * @license MIT
 * @version 1.0
 * @author  Niwantha Meepage 
 */
const os = require('os');
const fs = require('fs').promises;
const path = require('path');

// Helper: Get Python path in venv
function getVenvPythonPath(venvPath) {
    const isWindows = process.platform === 'win32';
    return path.join(
        venvPath,
        isWindows ? 'Scripts/python.exe' : 'bin/python'
    );
}

// get micropython studio folder locatio 
function getMicropythonStudioPath() {
    const appDataDir = os.homedir();
    return path.join(appDataDir, '.micropython-studio');
}
//  get virtual enviroment path folder 
function getVenvPythonPathFolder() {
    const micropythonStudioDir = getMicropythonStudioPath();
    const venvFolderName = '.venv';
    const venvPathFolder = path.join(micropythonStudioDir, venvFolderName);
    return venvPathFolder;
}

/*_*Example*************************************************************************
await updateCfgComponent(
    path.join(projectDir, 'device.cfg'),
    'device',
    'last_sync',
    new Date().toISOString()
);
************************************************************************************/
async function updateCfgComponent(cfgFilePath, section, key, newValue) {
    console.log(`Updating ${cfgFilePath} -> [${section}] ${key} = "${newValue}"`);

    try {
        // Read the file
        const data = await fs.readFile(cfgFilePath, 'utf8');
        const lines = data.split(/\r?\n/);

        let inSection = false;
        let keyFound = false;
        let sectionExists = false;

        // Process each line
        const newLines = lines.map(line => {
            const trimmedLine = line.trim();

            // Check if we're entering/exiting a section
            if (trimmedLine.startsWith('[') && trimmedLine.endsWith(']')) {
                inSection = trimmedLine === `[${section}]`;
                if (inSection) sectionExists = true;
                return line;
            }

            // If we're in the target section, look for the key
            if (inSection && !keyFound) {
                const keyMatch = trimmedLine.match(new RegExp(`^${key}\\s*=`));
                if (keyMatch) {
                    keyFound = true;
                    return `${key} = "${newValue}"`;
                }
            }

            return line;
        });

        // If key wasn't found but section exists, add it to the end of the section
        if (sectionExists && !keyFound) {
            let sectionEndIndex = -1;
            for (let i = 0; i < newLines.length; i++) {
                if (newLines[i].trim() === `[${section}]`) {
                    // Find the next section or end of file
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

        // Write the updated content back to the file
        await fs.writeFile(cfgFilePath, newLines.join('\n'));
        console.log(`✅ Updated ${key} in [${section}] to "${newValue}"`);

    } catch (err) {
        console.error(`❌ Error updating config: ${err.message}`);
        throw err;
    }
}

/*_*Example*************************************************************************
const devicePort = await getConfigValue(
    path.join(projectDir, 'device.cfg'),
    'device',
    'port'
);

if (devicePort) {
    console.log(`Device port: ${devicePort}`);
} else {
    console.log('Device port not found in config');
}
*************************************************************************************/
async function getConfigValue(configPath, section, key) {
    try {
        // First check if the config file exists
        try {
            await fs.access(configPath);
        } catch (error) {
            if (error.code === 'ENOENT') {
                // File doesn't exist yet, which is normal during project creation
                console.log(`⚠️ Config file doesn't exist yet: ${configPath}`);
                return null;
            }
            throw error; // Re-throw other errors
        }

        // Read the file using fs.promises
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
                const keyMatch = trimmedLine.match(new RegExp(`^${key}\\s*=\\s*(.*)$`));
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

        // Key not found
        console.log(`⚠️ Key '${key}' not found in section '[${section}]'`);
        return null;
    } catch (err) {
        // Only log errors that aren't "file not found"
        if (err.code !== 'ENOENT') {
            console.error(`❌ Error reading config: ${err.message}`);
        }
        return null;
    }
}

module.exports = { getVenvPythonPathFolder, getVenvPythonPath, updateCfgComponent, getConfigValue };