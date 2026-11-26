'use strict';
const vscode = require('vscode');
const fs = require('fs').promises;
const path = require('path');
const { findConfig, within, parseConfig, connectionState, projectRows, runtimeRows } = require('./mcuSidebarModel');
const { samePort } = require('./devicePortSelection');

class InfoTree {
    constructor() {
        this.rows = [];
        this.emitter = new vscode.EventEmitter();
        this.onDidChangeTreeData = this.emitter.event;
    }
    update(rows) {
        if (JSON.stringify(rows) === JSON.stringify(this.rows)) return;
        this.rows = rows;
        this.emitter.fire(undefined);
    }
    getChildren(element) { return element ? [] : this.rows; }
    getTreeItem(row) {
        const [label, value, icon, command] = row;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.id = label;
        item.description = value;
        item.tooltip = label + ': ' + value;
        item.iconPath = new vscode.ThemeIcon(icon);
        if (command) item.command = command === 'micropython-ide.openMcuConfig'
            ? { command, title: label }
            : { command: 'micropython-ide.openMcuRuntimeTool', title: label, arguments: [command] };
        return item;
    }
    dispose() { this.emitter.dispose(); }
}

function registerMcuSidebar(context, { connection, getSelection, memoryAnalyzer }) {
    const project = new InfoTree();
    const runtime = new InfoTree();
    const projectView = vscode.window.createTreeView('micropython-ide-mcu-project', { treeDataProvider: project });
    const runtimeView = vscode.window.createTreeView('micropython-ide-mcu-runtime', { treeDataProvider: runtime });
    let configPath = null;
    let config = null;
    let generation = 0;
    let revision = 0;
    let disposed = false;
    let pending = true;
    let scheduled;
    let lastSelection = null;
    let lastPort = null;

    function selection() {
        const current = getSelection();
        if (current.configPath !== lastSelection || current.port !== lastPort) {
            generation++;
            lastSelection = current.configPath;
            lastPort = current.port;
        }
        return current;
    }
    function selectedHere(current) {
        return !pending && !!configPath && !!current.configPath && path.relative(configPath, current.configPath) === '';
    }
    function getScope() {
        const current = selection();
        if (!selectedHere(current) || !current.port || /^wss?:/i.test(current.port) ||
            !connection.isConnected || connection.isSuspended || connection.isReconnecting ||
            !samePort(connection.portName, current.port)) return null;
        return JSON.stringify([generation, configPath, current.port]);
    }
    function render() {
        if (disposed) return;
        if (pending || !configPath || !config) {
            project.update([]);
            runtime.update([]);
            return;
        }
        const current = selection();
        const selected = selectedHere(current);
        const scope = getScope();
        const cached = memoryAnalyzer.sidebarSample;
        const sample = scope && cached?.scope === scope ? cached.sample : null;
        project.update(projectRows(configPath, config));
        runtime.update(runtimeRows(
            connectionState(connection, selected ? current.port : null),
            vscode.debug.activeDebugSession?.type === 'micropython-studio',
            sample, selected && !!current.port
        ));
        const message = selected ? undefined : 'Refresh the intended MCU project before using device tools.';
        if (runtimeView.message !== message) runtimeView.message = message;
    }
    async function locate() {
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document.uri.scheme === 'file') {
            const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
            if (folder && folder.uri.scheme === 'file') {
                return findConfig(path.dirname(editor.document.uri.fsPath), folder.uri.fsPath);
            }
            return null;
        }
        const folders = (vscode.workspace.workspaceFolders || []).filter(f => f.uri.scheme === 'file');
        const selected = getSelection().configPath;
        const owner = selected && folders.find(f => within(f.uri.fsPath, selected));
        if (owner) return findConfig(path.dirname(selected), owner.uri.fsPath);
        return folders.length === 1 ? findConfig(folders[0].uri.fsPath, folders[0].uri.fsPath) : null;
    }
    async function refresh() {
        const request = ++revision;
        pending = true;
        render();
        let next = null;
        let cfg = null;
        try {
            next = await locate();
            if (next) cfg = parseConfig(await fs.readFile(next, 'utf8'));
        } catch (_) { next = null; }
        if (disposed || request !== revision) return;
        if (configPath !== next || JSON.stringify(config) !== JSON.stringify(cfg)) generation++;
        configPath = next;
        config = cfg;
        pending = false;
        render();
        await vscode.commands.executeCommand('setContext', 'micropythonStudio.hasMcuProject', !!configPath);
    }
    function schedule() {
        if (disposed) return;
        revision++;
        pending = true;
        render();
        clearTimeout(scheduled);
        scheduled = setTimeout(() => { void refresh().catch(() => {}); }, 75);
    }
    const onConnectionChanged = () => { generation++; render(); };
    const events = ['connected', 'disconnected'];
    for (const event of events) connection.on(event, onConnectionChanged);
    const watcher = vscode.workspace.createFileSystemWatcher('**/device.cfg');
    const timer = setInterval(() => {
        // Read already-known host state only. Never poll the MCU.
        if (projectView.visible || runtimeView.visible) render();
    }, 1000);
    const allowed = new Set(['micropython-ide.openMemoryAnalyzer',
        'micropython-ide.openDeviceDashboard', 'micropython-ide.showDebuggerDetails']);
    context.subscriptions.push(project, runtime, projectView, runtimeView, watcher,
        watcher.onDidCreate(schedule), watcher.onDidChange(schedule), watcher.onDidDelete(schedule),
        vscode.window.onDidChangeActiveTextEditor(schedule),
        vscode.workspace.onDidChangeWorkspaceFolders(schedule),
        vscode.debug.onDidStartDebugSession(render), vscode.debug.onDidTerminateDebugSession(render),
        projectView.onDidChangeVisibility(e => { if (e.visible) render(); }),
        runtimeView.onDidChangeVisibility(e => { if (e.visible) render(); }),
        vscode.commands.registerCommand('micropython-ide.refreshMcuSidebar', refresh),
        vscode.commands.registerCommand('micropython-ide.openMcuConfig', async () => {
            if (!pending && configPath) await vscode.window.showTextDocument(vscode.Uri.file(configPath));
        }),
        vscode.commands.registerCommand('micropython-ide.openMcuRuntimeTool', async command => {
            const current = selection();
            if (!allowed.has(command) || !selectedHere(current) || !current.port) return;
            await vscode.commands.executeCommand(command);
        }),
        { dispose() {
            disposed = true;
            revision++;
            clearInterval(timer);
            clearTimeout(scheduled);
            for (const event of events) connection.removeListener(event, onConnectionChanged);
        } }
    );
    schedule();
    return { getScope };
}

module.exports = { registerMcuSidebar };
