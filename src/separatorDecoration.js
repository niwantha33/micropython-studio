const vscode = require('vscode');

class SeparatorDecorationProvider {
    provideTextDocumentDecoration(uri) {
        if (uri.scheme !== 'file') return [];
        
        return [
            {
                range: new vscode.Range(0, 0, 0, 0),
                renderOptions: {
                    after: {
                        contentText: '──────────────────────',
                        color: 'rgba(128, 128, 128, 0.5)',
                        margin: '0 0 0 1em',
                        fontStyle: 'italic'
                    }
                }
            }
        ];
    }
}

function activate(context) {
    const separatorDecorationProvider = new SeparatorDecorationProvider();
    vscode.window.registerDecorationProvider(separatorDecorationProvider);
}

module.exports = { activate };