import { spawn, execFileSync } from 'child_process';
import path from 'path';

const COMMAND_TIMEOUT_MS = 20000;
const CLAUDE_CATALOG_URL = 'https://downloads.claude.ai/model-catalog/v1/catalog.json';

function quoteArg(arg) {
    const text = String(arg);
    if (process.platform === 'win32') {
        return `"${text.replace(/"/g, '""')}"`;
    }
    return `'${text.replace(/'/g, `'\\''`)}'`;
}

function resolveBin(name) {
    const finder = process.platform === 'win32' ? 'where.exe' : 'which';
    let output = '';
    try {
        output = execFileSync(finder, [name], { encoding: 'utf8', windowsHide: true });
    } catch {
        return null;
    }
    const hits = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    return hits.find(hit => /\.(cmd|exe)$/i.test(hit)) || hits[0] || null;
}

function runCommand(bin, args, timeoutMs) {
    const command = [quoteArg(bin), ...args.map(quoteArg)].join(' ');
    return new Promise((resolve, reject) => {
        const child = spawn(command, {
            shell: true,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', TERM: 'dumb' },
        });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            if (child.pid && process.platform === 'win32') {
                spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { shell: true, windowsHide: true });
            } else {
                child.kill('SIGKILL');
            }
            reject(new Error(`${path.basename(bin)} timed out`));
        }, timeoutMs);
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', error => {
            clearTimeout(timer);
            reject(error);
        });
        child.on('close', code => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
    });
}

function parseCursorModels(stdout) {
    const models = [];
    for (const line of String(stdout || '').split(/\r?\n/)) {
        const match = line.match(/^(\S+)\s+-\s+(.+?)\s*$/);
        if (!match) continue;
        models.push({ id: match[1], label: match[2] });
    }
    return models;
}

function parseCodexModels(stdout) {
    const text = String(stdout || '');
    const start = text.indexOf('{');
    if (start === -1) throw new Error('Codex model catalog was not JSON');
    const catalog = JSON.parse(text.slice(start));
    return (catalog.models || [])
        .filter(model => model.slug && model.visibility !== 'hide')
        .map(model => ({ id: model.slug, label: model.display_name || model.slug }));
}

async function listCursorModels() {
    const bin = resolveBin('agent');
    if (!bin) throw new Error('Cursor CLI (agent) was not found on PATH.');
    const result = await runCommand(bin, ['--list-models'], COMMAND_TIMEOUT_MS);
    const models = parseCursorModels(result.stdout);
    if (!models.length) {
        throw new Error((result.stderr || '').trim() || `agent --list-models exited ${result.code}`);
    }
    return models;
}

async function listChatgptModels() {
    const bin = resolveBin('codex');
    if (!bin) throw new Error('ChatGPT CLI (codex) was not found on PATH.');
    let result = await runCommand(bin, ['debug', 'models'], COMMAND_TIMEOUT_MS);
    try {
        const models = parseCodexModels(result.stdout);
        if (models.length) return models;
    } catch {
        result = await runCommand(bin, ['debug', 'models', '--bundled'], COMMAND_TIMEOUT_MS);
    }
    return parseCodexModels(result.stdout);
}

async function listClaudeModels() {
    const response = await fetch(CLAUDE_CATALOG_URL, { signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS) });
    if (!response.ok) throw new Error(`Claude model catalog returned ${response.status}`);
    const catalog = await response.json();
    const configs = catalog.surfaces?.cc?.model_selector_config || [];
    const models = configs[0]?.models || [];
    return models
        .filter(model => model.id)
        .map(model => ({ id: model.id, label: model.name || model.id }));
}

const loaders = {
    cursor: listCursorModels,
    chatgpt: listChatgptModels,
    claude: listClaudeModels,
};

export async function listCliModels(provider) {
    const load = loaders[provider];
    if (!load) return [];
    return load();
}
