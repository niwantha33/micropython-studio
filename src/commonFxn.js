const os = require('os');
const path = require('path');

// Helper: Get Python path in venv
function getVenvPythonPath(venvPath) {
    const isWindows = process.platform === 'win32';
    return path.join(
        venvPath,
        isWindows ? 'Scripts/python.exe' : 'bin/python'
    );
}
//  get virtual enviroment path folder 
function getVenvPythonPathFolder() {
    const appDataDir = os.homedir();
    const micropythonStudioDir = path.join(appDataDir, '.micropython-studio');
    const venvFolderName = '.venv';
    const venvPathFolder = path.join(micropythonStudioDir, venvFolderName);
    return venvPathFolder;
}

module.exports = { getVenvPythonPathFolder, getVenvPythonPath };