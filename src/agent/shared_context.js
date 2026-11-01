import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync, openSync, closeSync, unlinkSync, statSync } from 'fs';
import path from 'path';
import { parseCoreFacts, renderCoreFacts } from './history.js';

const RECENT_LIMIT = 30;
const SUMMARY_CHUNK = 10;
const DEDUP_MS = 4000;
const LOCK_WAIT_MS = 8000;
const STALE_LOCK_MS = 15000;
const STALE_PENDING_MS = 180000;
const COMPRESS_BACKOFF_MS = 60000;
const LINE_LIMIT = 500;

const commandRegex = /!(\w+)(?:\(((?:-?\d+(?:\.\d+)?|true|false|"[^"]*")(?:\s*,\s*(?:-?\d+(?:\.\d+)?|true|false|"[^"]*"))*)\))?/;

let summarizer = null;
let running = false;

function location() {
    const dir = process.env.SHARED_CONTEXT_DIR || path.join(process.cwd(), 'bots', 'shared');
    return {
        dir,
        file: path.join(dir, 'context.json'),
        lock: path.join(dir, 'context.lock'),
        histories: path.join(dir, 'histories'),
    };
}

function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function emptyData() {
    return { recent: [], core: [], memory: '', pending: null, pending_at: 0, compress_after: 0 };
}

function cleanLine(line) {
    if (!line || typeof line.speaker !== 'string' || typeof line.text !== 'string') return null;
    const speaker = line.speaker.trim();
    const text = line.text.trim();
    if (!speaker || !text) return null;
    return { speaker, text: text.slice(0, LINE_LIMIT), at: Number(line.at) || Date.now() };
}

function normalize(data) {
    const core = parseCoreFacts(JSON.stringify(Array.isArray(data?.core) ? data.core : []));
    const recent = Array.isArray(data?.recent) ? data.recent.map(cleanLine).filter(Boolean) : [];
    const pending = Array.isArray(data?.pending) ? data.pending.map(cleanLine).filter(Boolean) : null;
    return {
        recent,
        core,
        memory: renderCoreFacts(core),
        pending: pending && pending.length > 0 ? pending : null,
        pending_at: Number(data?.pending_at) || 0,
        compress_after: Number(data?.compress_after) || 0,
    };
}

function readData() {
    const { file } = location();
    try {
        if (!existsSync(file)) return emptyData();
        const raw = readFileSync(file, 'utf8');
        if (!raw.trim()) return emptyData();
        return normalize(JSON.parse(raw));
    } catch (err) {
        console.error('Shared conversation file is unreadable:', err.message);
        return null;
    }
}

function writeData(data) {
    const { dir, file } = location();
    mkdirSync(dir, { recursive: true });
    const body = JSON.stringify(normalize(data), null, 2);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, body);
    copyFileSync(tmp, file);
    try { unlinkSync(tmp); } catch { /* the real file is already in place */ }
}

function withLock(fn) {
    const { dir, lock } = location();
    mkdirSync(dir, { recursive: true });
    const started = Date.now();
    while (Date.now() - started < LOCK_WAIT_MS) {
        let fd;
        try {
            fd = openSync(lock, 'wx');
        } catch (err) {
            if (err.code !== 'EEXIST') throw err;
            try {
                if (Date.now() - statSync(lock).mtimeMs > STALE_LOCK_MS) unlinkSync(lock);
            } catch { /* another process took the lock */ }
            sleepSync(40);
            continue;
        }
        try {
            return fn();
        } finally {
            try { closeSync(fd); } catch { /* already closed */ }
            try { unlinkSync(lock); } catch { /* already released */ }
        }
    }
    console.error('Shared conversation lock timed out.');
    return null;
}

export function spokenLine(message) {
    let text = String(message || '').replace(/\(FROM OTHER BOT\)/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if (/you are self-prompting/i.test(text) || /^recent behaviors log:/i.test(text)) return '';
    const match = text.match(commandRegex);
    if (!match) return text.slice(0, LINE_LIMIT);
    const spoken = text.slice(0, match.index).trim();
    return (spoken || `*${match[1]}*`).slice(0, LINE_LIMIT);
}

export function note(speaker, text) {
    const lineText = spokenLine(text);
    const name = String(speaker || '').trim();
    if (!name || !lineText) return;
    try {
        withLock(() => {
            const data = readData();
            if (!data) return;
            const now = Date.now();
            const duplicate = data.recent.slice(-12).some(item =>
                item.speaker === name && item.text === lineText && now - item.at < DEDUP_MS
            );
            if (duplicate) return;
            data.recent.push({ speaker: name, text: lineText, at: now });
            writeData(data);
        });
    } catch (err) {
        console.error('Failed to record shared chat:', err.message);
    }
}

function sameChunk(left, right) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((line, index) => {
        const other = right[index];
        return line.at === other.at && line.speaker === other.speaker && line.text === other.text;
    });
}

function takeChunk() {
    return withLock(() => {
        const data = readData();
        if (!data) return null;
        const now = Date.now();
        if (data.pending) {
            if (now - data.pending_at < STALE_PENDING_MS) return null;
            data.pending_at = now;
            writeData(data);
            return { memory: data.memory, chunk: data.pending };
        }
        if (data.compress_after && now < data.compress_after) return null;
        if (data.recent.length <= RECENT_LIMIT) return null;
        const chunk = data.recent.splice(0, SUMMARY_CHUNK);
        data.pending = chunk;
        data.pending_at = now;
        writeData(data);
        return { memory: data.memory, chunk };
    });
}

function finishChunk(chunk, facts) {
    withLock(() => {
        const data = readData();
        if (!data || !sameChunk(data.pending, chunk)) return;
        if (facts.length > 0) {
            data.core = facts;
            data.memory = renderCoreFacts(facts);
            data.pending = null;
            data.pending_at = 0;
            data.compress_after = 0;
        } else {
            data.recent = chunk.concat(data.recent);
            data.pending = null;
            data.pending_at = 0;
            data.compress_after = Date.now() + COMPRESS_BACKOFF_MS;
        }
        writeData(data);
    });
}

function appendHistory(chunk) {
    try {
        const { histories } = location();
        mkdirSync(histories, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = path.join(histories, `${stamp}.json`);
        writeFileSync(file, JSON.stringify(chunk, null, 2));
    } catch (err) {
        console.error('Failed to archive shared chat:', err.message);
    }
}

async function compress() {
    if (!summarizer) return false;
    const job = takeChunk();
    if (!job) return false;
    console.log('Storing shared conversation...');
    let facts = [];
    try {
        const turns = job.chunk.map(line => ({ role: 'user', content: `${line.speaker}: ${line.text}` }));
        const response = await summarizer(turns, job.memory);
        facts = parseCoreFacts(response);
    } catch (err) {
        console.error('Shared conversation summary failed:', err.message);
        facts = [];
    }
    finishChunk(job.chunk, facts);
    if (facts.length > 0) {
        appendHistory(job.chunk);
        console.log(`Shared facts: ${facts.length}`);
    }
    const data = readData();
    return !!data && data.recent.length > RECENT_LIMIT;
}

export function bindSummarizer(fn) {
    summarizer = fn;
    scheduleCompress();
}

export function scheduleCompress() {
    if (running || !summarizer) return;
    running = true;
    (async () => {
        try {
            let again = true;
            for (let round = 0; again && round < 3; round++)
                again = await compress();
        } catch (err) {
            console.error('Shared conversation compress failed:', err.message);
        } finally {
            running = false;
        }
    })();
}

export function renderForPrompt() {
    try {
        const data = withLock(() => readData());
        if (!data) return { memory: '', recent: '' };
        const lines = [...(data.pending || []), ...data.recent];
        return {
            memory: data.memory || '',
            recent: lines.map(line => `${line.speaker}: ${line.text}`).join('\n'),
        };
    } catch (err) {
        console.error('Failed to read shared conversation:', err.message);
        return { memory: '', recent: '' };
    }
}
