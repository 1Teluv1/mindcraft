import { exec, spawn } from 'child_process';
import { promises as fs } from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { TTSConfig as gptTTSConfig } from '../models/gpt.js';
import { TTSConfig as geminiTTSConfig } from '../models/gemini.js';
import settings from './settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUPERTONIC_SCRIPT = path.join(__dirname, '../tts/supertonic_server.py');

let supertonicProcess = null;
let supertonicStart = null;

let speakingQueue = []; // each item: {text, model, audioData, ready}
let isSpeaking = false;
let currentPlayback = null;

function isSupertonic(model) {
    return typeof model === 'string' && model.startsWith('supertonic/');
}

function ttsPort() {
    return Number(settings.tts_port) || 47821;
}

function pythonBin() {
    return process.env.PYTHON || 'python';
}

function portOpen(port) {
    return new Promise((resolve) => {
        const socket = net.connect({ host: '127.0.0.1', port });
        const done = (open) => {
            socket.removeAllListeners();
            socket.destroy();
            resolve(open);
        };
        socket.once('connect', () => done(true));
        socket.once('error', () => done(false));
    });
}

async function ensureSupertonic() {
    if (await portOpen(ttsPort())) return;
    if (!supertonicStart) {
        supertonicStart = (async () => {
            supertonicProcess = spawn(pythonBin(), [SUPERTONIC_SCRIPT, String(ttsPort())], {
                stdio: ['ignore', 'inherit', 'inherit'],
                windowsHide: true,
            });
            supertonicProcess.on('exit', () => {
                supertonicProcess = null;
                supertonicStart = null;
            });
            for (let i = 0; i < 60; i++) {
                if (await portOpen(ttsPort())) return;
                await new Promise((resolve) => setTimeout(resolve, 500));
            }
            throw new Error('Supertonic TTS server did not start');
        })().catch((err) => {
            supertonicStart = null;
            throw err;
        });
    }
    await supertonicStart;
}

async function synthesizeSupertonic(text, voice, lang) {
    await ensureSupertonic();
    const response = await fetch(`http://127.0.0.1:${ttsPort()}/speak`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice, lang }),
        signal: AbortSignal.timeout(300000),
    });
    if (!response.ok) {
        throw new Error(await response.text());
    }
    const wavPath = path.join(os.tmpdir(), `tts_${Date.now()}_${process.pid}.wav`);
    await fs.writeFile(wavPath, Buffer.from(await response.arrayBuffer()));
    return wavPath;
}

function playWav(wavPath) {
    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';
    const quoted = wavPath.replace(/'/g, "''");
    const cmd = isWin
        ? `powershell.exe -NoProfile -Command "Add-Type -AssemblyName System; $p = New-Object System.Media.SoundPlayer '${quoted}'; $p.PlaySync(); $p.Dispose()"`
        : isMac
        ? `afplay ${JSON.stringify(wavPath)}`
        : `aplay ${JSON.stringify(wavPath)}`;
    return new Promise((resolve) => {
        currentPlayback = exec(cmd, async (err) => {
            currentPlayback = null;
            if (err && err.killed !== true && err.signal !== 'SIGTERM') console.error('[TTS] play error', err);
            try { await fs.unlink(wavPath); } catch {}
            resolve();
        });
    });
}

export function stopSpeaking() {
    speakingQueue = [];
    if (currentPlayback && !currentPlayback.killed) currentPlayback.kill();
}

export function speak(text, speak_model) {
    if (!settings.speak) return;
    const model = speak_model || 'system';

    const item = { text, model, audioData: null, ready: null };

    if (model === 'system' || isSupertonic(model)) {
        item.ready = Promise.resolve();
    } else {
    item.ready = fetchRemoteAudio(text, model)
        .then(data => { item.audioData = data; })
        .catch(err => { item.error = err; });
    }

    speakingQueue.push(item);
    if (!isSpeaking) processQueue();
}

async function fetchRemoteAudio(txt, model) {
    function getModelUrl(prov) {
        if (prov === 'openai') return gptTTSConfig.baseUrl;
        if (prov === 'google') return geminiTTSConfig.baseUrl;
        return 'https://api.openai.com/v1';
    }

    let prov, mdl, voice, url;
    if (typeof model === 'string') {
        [prov, mdl, voice] = model.split('/');
        url = getModelUrl(prov);
    } else {
        prov = model.api;
        mdl = model.model;
        voice = model.voice;
        url = model.url || getModelUrl(prov);
    }

    if (prov === 'openai') {
        return gptTTSConfig.sendAudioRequest(txt, mdl, voice, url);
    } else if (prov === 'google') {
        return geminiTTSConfig.sendAudioRequest(txt, mdl, voice, url);
    }
    else {
        throw new Error(`TTS Provider ${prov} is not supported.`);
    }
}

async function processQueue() {
    isSpeaking = true;
    if (speakingQueue.length === 0) {
        isSpeaking = false;
        return;
    }
    const item = speakingQueue.shift();
    const { text: txt, model, audioData } = item;
    if (txt.trim() === '' || !settings.speak) {
        isSpeaking = false;
        processQueue();
        return;
    }

    const isWin = process.platform === 'win32';
    const isMac = process.platform === 'darwin';

    // wait for preprocessing if needed
    try {
        await item.ready;
        if (item.error) throw item.error;
    } catch (err) {
        console.error('[TTS] preprocess error', err);
        isSpeaking = false;
        processQueue();
        return;
    }

    if (isSupertonic(model)) {
        const [, lang, voice] = model.split('/');
        try {
            const wavPath = await synthesizeSupertonic(txt, voice || 'M1', lang || 'ko');
            if (!settings.speak) {
                try { await fs.unlink(wavPath); } catch {}
            } else {
                await playWav(wavPath);
            }
        } catch (err) {
            console.error('[TTS] supertonic error', err);
        }
        isSpeaking = false;
        processQueue();
        return;
    }

    if (model === 'system') {
        // system TTS
        const cmd = isWin
            ? `powershell -NoProfile -Command "Add-Type -AssemblyName System.Speech; \
            $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate=2; \
            $s.Speak('${txt.replace(/'/g,"''")}'); $s.Dispose()"`
            : isMac
            ? `say "${txt.replace(/"/g,'\\"')}"`
            : `espeak "${txt.replace(/"/g,'\\"')}"`;

        exec(cmd, err => {
            if (err) console.error('TTS error', err);
            isSpeaking = false;
            processQueue();
        });

    } 
    else {
        // audioData was already fetched in speak()
        const audioData = item.audioData;

        if (!audioData) {
            console.error('[TTS] No audio data ready');
            isSpeaking = false;
            processQueue();
            return;
        }

        try {
            if (isWin) {
                const tmpPath = path.join(os.tmpdir(), `tts_${Date.now()}.mp3`);
                await fs.writeFile(tmpPath, Buffer.from(audioData, 'base64'));

                const player = spawn('ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', tmpPath], {
                    stdio: 'ignore', windowsHide: true
                });
                player.on('error', async (err) => {
                    console.error('[TTS] ffplay error', err);
                    try { await fs.unlink(tmpPath); } catch {}
                    isSpeaking = false;
                    processQueue();
                });
                player.on('exit', async () => {
                    try { await fs.unlink(tmpPath); } catch {}
                    isSpeaking = false;
                    processQueue();
                });

            } else {
                const player = spawn('ffplay', ['-nodisp','-autoexit','pipe:0'], {
                    stdio: ['pipe','ignore','ignore']
                });
                player.stdin.write(Buffer.from(audioData, 'base64'));
                player.stdin.end();
                player.on('exit', () => {
                    isSpeaking = false;
                    processQueue();
                });
            }
        } catch (e) {
            console.error('[TTS] Audio error', e);
            isSpeaking = false;
            processQueue();
        }
    }
}
