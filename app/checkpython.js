// ../app/checkpython.js
const { exec } = require('child_process'); // child_process is a Node.js built-in module, so require is fine here.

// Function 1: Python availability check
function checkPythonAvailability(vscode) { // 👈 Accept vscode as an argument
    exec('python --version', (err) => {
        if (err) {
            vscode.window.showWarningMessage(
                'Python not found in PATH. Try installing Python or using python3.'
            );
        }
    });
}