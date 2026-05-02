const fs = require('fs');
const path = require('path');

/**
 * Recursively find all .py files in a directory, ignoring hidden folders and common venv/build folders.
 */
function findPythonFiles(dir, fileList = []) {
    if (!fs.existsSync(dir)) return fileList;
    const files = fs.readdirSync(dir);
    
    for (const file of files) {
        // Skip hidden directories and common virtual environments
        if (file.startsWith('.') || file === 'node_modules' || file === 'venv' || file === '.venv' || file === 'build') {
            continue;
        }
        
        const filePath = path.join(dir, file);
        if (fs.statSync(filePath).isDirectory()) {
            findPythonFiles(filePath, fileList);
        } else if (file.endsWith('.py')) {
            fileList.push(filePath);
        }
    }
    return fileList;
}

/**
 * Scan a workspace for hardware pin usage.
 * @param {string} workspacePath 
 * @returns {Object} Map of pin numbers to usage details
 */
function scanWorkspacePins(workspacePath) {
    const pyFiles = findPythonFiles(workspacePath);
    const pinMap = {};
    
    for (const filePath of pyFiles) {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        
        lines.forEach((line, index) => {
            const lineNum = index + 1;
            const cleanLine = line.trim();
            
            // Skip comments
            if (cleanLine.startsWith('#')) return;
            
            // Capture variable name from assignment (e.g. "led = Pin(...)" -> "led")
            const varMatch = cleanLine.match(/^(\w+)\s*=/);
            const varName = varMatch ? varMatch[1] : '';
            
            // 1. Basic Pin Match: Pin(15) or Pin(15, Pin.OUT) or machine.Pin(15)
            // Group 1: Pin number, Group 2: mode (optional)
            const pinRegex = /(?:machine\.)?Pin\s*\(\s*(\d+|"[^"]+"|'[^']+')(?:\s*,\s*(?:mode=)?(?:machine\.)?Pin\.([A-Z_]+))?/g;
            let match;
            while ((match = pinRegex.exec(cleanLine)) !== null) {
                const pinNum = match[1].replace(/^['"]|['"]$/g, '');
                let mode = match[2] ? match[2] : "USED";
                
                // Contextual overrides (if the line also contains PWM, ADC, etc)
                if (cleanLine.includes('PWM')) mode = "PWM";
                else if (cleanLine.includes('ADC')) mode = "ADC";
                
                // Store unless overridden by a more specific protocol later
                if (!pinMap[pinNum] || mode !== "USED") {
                    pinMap[pinNum] = { mode, file: path.basename(filePath), line: lineNum, varName };
                }
            }
            
            // 2. I2C SCL/SDA Match: I2C(..., scl=Pin(5), sda=Pin(4))
            if (cleanLine.includes('I2C')) {
                const sclMatch = /scl\s*=\s*(?:machine\.)?Pin\s*\(\s*(\d+|"[^"]+"|'[^']+')\s*\)/.exec(cleanLine);
                if (sclMatch) {
                    const pinNum = sclMatch[1].replace(/^['"]|['"]$/g, '');
                    pinMap[pinNum] = { mode: "I2C_SCL", file: path.basename(filePath), line: lineNum, varName };
                }
                const sdaMatch = /sda\s*=\s*(?:machine\.)?Pin\s*\(\s*(\d+|"[^"]+"|'[^']+')\s*\)/.exec(cleanLine);
                if (sdaMatch) {
                    const pinNum = sdaMatch[1].replace(/^['"]|['"]$/g, '');
                    pinMap[pinNum] = { mode: "I2C_SDA", file: path.basename(filePath), line: lineNum, varName };
                }
            }
            
            // 3. SPI SCK/MOSI/MISO Match
            if (cleanLine.includes('SPI')) {
                const sckMatch = /sck\s*=\s*(?:machine\.)?Pin\s*\(\s*(\d+|"[^"]+"|'[^']+')\s*\)/.exec(cleanLine);
                if (sckMatch) {
                    const pinNum = sckMatch[1].replace(/^['"]|['"]$/g, '');
                    pinMap[pinNum] = { mode: "SPI_SCK", file: path.basename(filePath), line: lineNum, varName };
                }
                const mosiMatch = /mosi\s*=\s*(?:machine\.)?Pin\s*\(\s*(\d+|"[^"]+"|'[^']+')\s*\)/.exec(cleanLine);
                if (mosiMatch) {
                    const pinNum = mosiMatch[1].replace(/^['"]|['"]$/g, '');
                    pinMap[pinNum] = { mode: "SPI_MOSI", file: path.basename(filePath), line: lineNum, varName };
                }
                const misoMatch = /miso\s*=\s*(?:machine\.)?Pin\s*\(\s*(\d+|"[^"]+"|'[^']+')\s*\)/.exec(cleanLine);
                if (misoMatch) {
                    const pinNum = misoMatch[1].replace(/^['"]|['"]$/g, '');
                    pinMap[pinNum] = { mode: "SPI_MISO", file: path.basename(filePath), line: lineNum, varName };
                }
            }
        });
    }
    
    return pinMap;
}

module.exports = {
    scanWorkspacePins
};
