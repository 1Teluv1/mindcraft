import { spawn, execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { strictFormat, toSinglePrompt } from '../utils/text.js';

const PROVIDERS = {
    cursor: { bin: 'agent' },
    chatgpt: { bin: 'codex' },
    claude: { bin: 'claude' },
};

const TIMEOUT_MS = 180000;

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

function killTree(child) {
    if (!child?.pid) return;
    if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { shell: true, windowsHide: true });
        return;
    }
    child.kill('SIGKILL');
}

function abortError() {
    const error = new Error('CLI request cancelled');
    error.code = 'ABORTED';
    return error;
}

function runCommand(bin, args, { input, cwd, timeoutMs, abort }) {
    if (abort?.aborted) return Promise.reject(abortError());
    const command = [quoteArg(bin), ...args.map(quoteArg)].join(' ');
    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;
        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (abort) abort.child = null;
            fn(value);
        };
        const child = spawn(command, {
            cwd,
            shell: true,
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0' },
        });
        if (abort) abort.child = child;
        if (abort?.aborted) {
            killTree(child);
            finish(reject, abortError());
            return;
        }
        let stdout = '';
        let stderr = '';
        timer = setTimeout(() => {
            killTree(child);
            finish(reject, new Error(`${path.basename(bin)} timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', error => finish(reject, error));
        child.on('close', code => {
            if (abort?.aborted) {
                finish(reject, abortError());
                return;
            }
            finish(resolve, { code, stdout, stderr });
        });
        child.stdin.end(input ?? '');
    });
}

function textFromClaudeStream(stdout) {
    let result = '';
    const bits = [];
    for (const line of String(stdout || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        let event;
        try {
            event = JSON.parse(trimmed);
        } catch {
            continue;
        }
        if (event.type === 'result' && typeof event.result === 'string') result = event.result;
        const content = event.message?.content;
        if (Array.isArray(content)) {
            for (const block of content) {
                if (block.type === 'text' && block.text) bits.push(block.text);
            }
        }
    }
    return cleanText(result || bits.join('\n'));
}

function cleanText(text) {
    return String(text || '')
        .replace(/\u001b\[[0-9;]*m/g, '')
        .replace(/<think>[\s\S]*?<\/think>/g, '')
        .trim();
}

export class AgentCli {
    static prefix = 'cli';

    constructor(model_name, _url, params) {
        this.params = params || {};
        const raw = model_name || '';
        const [provider, ...rest] = raw.split('/').filter(Boolean);
        this.provider = PROVIDERS[provider] ? provider : null;
        this.cliModel = this.params.cli_model || rest.join('/') || null;
        this.tail = Promise.resolve();
        this.foregroundTail = Promise.resolve();
        this.foregroundDepth = 0;
        this.bin = null;
        this.currentRequest = null;
    }

    cancelCurrent() {
        const request = this.currentRequest;
        if (!request) return;
        request.aborted = true;
        if (request.child) killTree(request.child);
    }

    enqueue(job, foreground = false) {
        const tail = foreground ? 'foregroundTail' : 'tail';
        const run = this[tail].then(job, job);
        this[tail] = run.then(() => {}, () => {});
        return run;
    }

    executable() {
        if (this.bin) return this.bin;
        const spec = PROVIDERS[this.provider];
        this.bin = spec ? resolveBin(spec.bin) : null;
        return this.bin;
    }

    async sendRequest(turns, systemMessage, stop_seq = '***', options = null) {
        const cancelPrevious = Boolean(options?.cancelPrevious);
        const foreground = Boolean(options?.foreground);
        return this._complete(turns, systemMessage, stop_seq, null, '도구를 호출하지 말고, 파일을 고치지 말고, 추론을 설명하지 마라. 다음 대사만 출력한다. 대사는 항상 한국어다.', cancelPrevious, foreground);
    }

    async sendVisionRequest(turns, systemMessage, imageBuffer) {
        return this._complete(turns, systemMessage, '***', imageBuffer, '1인칭 스크린샷이 첨부되어 있고 작업 폴더의 view.jpg에도 있다. 첨부가 안 보이면 그 이미지를 읽어라. 파일을 고치지 마라. 설명만 한국어로 출력한다.');
    }

    async _complete(turns, systemMessage, stop_seq, imageBuffer, rule, cancelPrevious = false, foreground = false) {
        if (!this.provider) {
            return '생각이 끊겼어. 다시 해 봐.';
        }
        const messages = strictFormat(turns);
        const system = `${systemMessage}\n로컬 CLI로 답한다. ${rule}`;
        const conversation = toSinglePrompt(messages, null, stop_seq, 'assistant');
        if (foreground) this.foregroundDepth++;
        const abort = { aborted: false, child: null, foreground };
        if (cancelPrevious) {
            this.cancelCurrent();
            this.currentRequest = abort;
        } else if (foreground && this.currentRequest && !this.currentRequest.foreground) {
            this.cancelCurrent();
        }
        try {
            console.log(`Awaiting ${this.provider} CLI${this.cliModel ? ` (${this.cliModel})` : ''}...`);
            const text = await this.enqueue(async () => {
                while (!foreground && this.foregroundDepth > 0) {
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
                if (abort.aborted) throw abortError();
                this.currentRequest = abort;
                return this.dispatch(system, conversation, imageBuffer, abort);
            }, foreground);
            const cut = text.indexOf(stop_seq);
            const res = (cut === -1 ? text : text.slice(0, cut)).trim();
            console.log('Received.');
            return res || '생각이 끊겼어. 다시 해 봐.';
        } catch (error) {
            if (error?.code === 'ABORTED') return '';
            console.error(error);
            return '생각이 끊겼어. 다시 해 봐.';
        } finally {
            if (foreground) this.foregroundDepth = Math.max(0, this.foregroundDepth - 1);
        }
    }

    async dispatch(system, conversation, imageBuffer = null, abort = null) {
        const bin = this.executable();
        if (!bin) {
            const spec = PROVIDERS[this.provider];
            throw new Error(`${this.provider} CLI (${spec.bin}) was not found on PATH.`);
        }
        const cwd = mkdtempSync(path.join(tmpdir(), 'nuri-cli-'));
        try {
            let imagePath = null;
            if (imageBuffer) {
                imagePath = path.join(cwd, 'view.jpg');
                writeFileSync(imagePath, imageBuffer);
            }
            if (this.provider === 'claude') return await this.runClaude(bin, cwd, system, conversation, imagePath, abort);
            if (this.provider === 'chatgpt') return await this.runCodex(bin, cwd, system, conversation, imagePath, abort);
            return await this.runCursor(bin, cwd, system, conversation, abort);
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    }

    async runCursor(bin, cwd, system, conversation, abort = null) {
        const args = ['-p', '--output-format', 'text', '--mode', 'ask', '--trust', '--workspace', cwd];
        if (this.cliModel) args.push('--model', this.cliModel);
        const result = await runCommand(bin, args, {
            input: `${system}\n\n${conversation}`,
            cwd,
            timeoutMs: TIMEOUT_MS,
            abort,
        });
        if (result.code !== 0 && !cleanText(result.stdout)) {
            throw new Error(cleanText(result.stderr) || `agent exited ${result.code}`);
        }
        return cleanText(result.stdout);
    }

    async runClaude(bin, cwd, system, conversation, imagePath = null, abort = null) {
        if (imagePath) {
            const seen = await this.runClaudeImage(bin, cwd, system, conversation, imagePath, abort);
            if (seen) return seen;
            return 'Screenshot captured, but I could not view the image.';
        }
        const systemFile = path.join(cwd, 'system.txt');
        writeFileSync(systemFile, system, 'utf8');
        const args = [
            '-p',
            '--output-format', 'text',
            '--tools', '',
            '--permission-mode', 'plan',
            '--permission-prompts', 'none',
            '--no-session-persistence',
            '--disable-slash-commands',
            '--setting-sources', 'user',
            '--system-prompt-file', systemFile,
        ];
        if (this.cliModel) args.push('--model', this.cliModel);
        const result = await runCommand(bin, args, {
            input: conversation,
            cwd,
            timeoutMs: TIMEOUT_MS,
            abort,
        });
        if (result.code !== 0 && !cleanText(result.stdout)) {
            throw new Error(cleanText(result.stderr) || `claude exited ${result.code}`);
        }
        return cleanText(result.stdout);
    }

    async runClaudeImage(bin, cwd, system, conversation, imagePath, abort = null) {
        const systemFile = path.join(cwd, 'system.txt');
        writeFileSync(systemFile, system, 'utf8');
        const image = readFileSync(imagePath).toString('base64');
        const payload = JSON.stringify({
            type: 'user',
            message: {
                role: 'user',
                content: [
                    { type: 'text', text: conversation },
                    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
                ],
            },
        });
        const args = [
            '-p',
            '--output-format', 'stream-json',
            '--input-format', 'stream-json',
            '--verbose',
            '--tools', '',
            '--permission-mode', 'plan',
            '--permission-prompts', 'none',
            '--no-session-persistence',
            '--disable-slash-commands',
            '--setting-sources', 'user',
            '--system-prompt-file', systemFile,
        ];
        if (this.cliModel) args.push('--model', this.cliModel);
        try {
            const result = await runCommand(bin, args, {
                input: payload,
                cwd,
                timeoutMs: TIMEOUT_MS,
                abort,
            });
            return textFromClaudeStream(result.stdout);
        } catch (error) {
            if (error?.code === 'ABORTED') throw error;
            return '';
        }
    }

    async runCodex(bin, cwd, system, conversation, imagePath = null, abort = null) {
        const outputFile = path.join(cwd, 'last.txt');
        const args = [
            'exec',
            '--ephemeral',
            '--skip-git-repo-check',
            '--ignore-rules',
            '--sandbox', 'read-only',
            '--color', 'never',
            '-C', cwd,
            '-o', outputFile,
        ];
        if (this.cliModel) args.push('-m', this.cliModel);
        if (imagePath) args.push('-i', imagePath);
        args.push('-');
        const result = await runCommand(bin, args, {
            input: `${system}\n\n${conversation}`,
            cwd,
            timeoutMs: TIMEOUT_MS,
            abort,
        });
        let text = '';
        try {
            text = readFileSync(outputFile, 'utf8');
        } catch {
            text = result.stdout;
        }
        if (result.code !== 0 && !cleanText(text)) {
            throw new Error(cleanText(result.stderr) || `codex exited ${result.code}`);
        }
        return cleanText(text);
    }

    async embed() {
        throw new Error('CLI brains do not provide embeddings');
    }
}
