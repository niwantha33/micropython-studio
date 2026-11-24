'use strict';

// One lazily-created output channel shared by the entire extension.
// Duplicate createOutputChannel('MicroPython IDE') calls can result in
// separately selectable Output channels and hide transfer completion.
let channel = null;

function getStudioOutputChannel() {
    if (!channel) {
        const vscode = require('vscode');
        channel = vscode.window.createOutputChannel('MicroPython IDE');
    }
    return channel;
}

module.exports = { getStudioOutputChannel };
