import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Exercise the real loop without importing the game/network/LLM providers.
let source = await readFile(new URL('../src/agent/self_prompter.js', import.meta.url), 'utf8');
source = source.replace("import settings from './settings.js';", "const settings = { life_goal: 'routine' };")
    .replace("import * as world from './library/world.js';", "const world = { getSurroundingsSummary: () => '' };");
const { SelfPrompter } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);

test('routine idle loop makes zero LLM calls and stops cleanly', async () => {
    let calls = 0;
    const agent = { isIdle: () => true, prompter: {}, hybrid: {
        enabled: () => true, ownsWork: () => false, takeReplan: () => null,
    }, handleMessage: async () => { calls++; } };
    const loop = new SelfPrompter(agent);
    loop.state = 1; loop.prompt = 'routine';
    const run = loop.startLoop();
    setTimeout(() => { loop.interrupt = true; }, 20);
    await run;
    assert.equal(calls, 0);
    assert.equal(loop.loop_active, false);
});

test('blocked event asks for one replan instead of a periodic next command', async () => {
    const messages = [];
    let event = 'Item goal blocked';
    const agent = { isIdle: () => true, prompter: {}, hybrid: {
        enabled: () => true, ownsWork: () => false,
        takeReplan: () => { const result = event; event = null; return result; },
    }, handleMessage: async (...args) => { messages.push(args); loop.interrupt = true; } };
    const loop = new SelfPrompter(agent);
    loop.state = 1; loop.prompt = 'routine';
    await loop.startLoop();
    assert.deepEqual(messages, [['system', 'Item goal blocked', 1]]);
});
