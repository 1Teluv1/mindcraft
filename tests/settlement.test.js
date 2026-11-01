import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ROLES, FOOD, decideSettlement, claimJob, distance } from '../src/agent/npc/settlement.js';
import { SettlementStore } from '../src/agent/npc/settlement_store.js';

const now = 100000;
const home = { x: 0, y: 64, z: 0 };
function member(name = 'Cursor', inventory = {}) {
    return { name, role: 'generalist', inventory, position: home, health: 20, food: 20, nearby: ['oak_log', 'stone'], active: true, at: now };
}
function board(...members) {
    return { base: home, members: Object.fromEntries(members.map(m => [m.name, m])), claims: {}, requests: {}, cooldowns: {}, events: [] };
}

test('all character names share the same default abilities and decisions', () => {
    const inventory = { stone_axe: 1, stone_pickaxe: 1, stone_hoe: 1, wheat_seeds: 8 };
    for (const name of ['Cursor', 'ChatGPT', 'Claude', 'AnotherCharacter']) {
        const self = member(name, { ...inventory }); self.canFarm = true;
        assert.equal(decideSettlement(self, board(self), now).kind, 'farm');
        self.canFarm = false; self.inventory.wheat_seeds = 0;
        assert.equal(decideSettlement(self, board(self), now).item, 'oak_log');
        self.inventory.oak_log = 32; self.inventory.cobblestone = 32;
        assert.equal(decideSettlement(self, board(self), now).item, 'crafting_table');
    }
});

test('roles progress from personal tools to different shared work', () => {
    const gatherer = member('Cursor', { stone_axe: 1, stone_pickaxe: 1 });
    const crafter = member('ChatGPT', { stone_axe: 1, stone_pickaxe: 1, crafting_table: 1 });
    const farmer = member('Claude', { stone_hoe: 1, stone_pickaxe: 1, wheat_seeds: 8 }); farmer.canFarm = true;
    gatherer.role = 'gatherer'; crafter.role = 'crafter'; farmer.role = 'farmer';
    const b = board(gatherer, crafter, farmer);
    assert.equal(decideSettlement(gatherer, b, now).item, 'oak_log');
    assert.equal(decideSettlement(crafter, b, now).kind, 'place');
    assert.equal(decideSettlement(farmer, b, now).kind, 'farm');
    farmer.ripeCrop = 'wheat';
    assert.equal(decideSettlement(farmer, b, now).kind, 'harvest');
});

test('hunger, injury, distance and night override work', () => {
    const self = member('Cursor', { bread: 1 }); const b = board(self);
    self.health = 8; assert.equal(decideSettlement(self, b, now).kind, 'eat');
    self.inventory = {}; assert.equal(decideSettlement(self, b, now).kind, 'rest');
    self.health = 20; self.position = { ...home, x: 60 };
    assert.equal(decideSettlement(self, b, now).kind, 'return');
    self.position = home; self.night = true; self.hasBed = true;
    assert.equal(decideSettlement(self, b, now).kind, 'sleep');
});

test('delivery uses real surplus and ignores stale or paused recipients', () => {
    const self = member('Cursor', { oak_log: 32 }); const friend = member('ChatGPT');
    const b = board(self, friend);
    b.requests.wood = { id: 'wood', to: friend.name, item: 'oak_log', quantity: 8, state: 'open', at: now };
    assert.equal(decideSettlement(self, b, now).kind, 'deliver');
    friend.active = false; assert.notEqual(decideSettlement(self, b, now).kind, 'deliver');
    friend.active = true; friend.at = 0; assert.notEqual(decideSettlement(self, b, now).kind, 'deliver');
    friend.at = now; self.inventory.oak_log = 8;
    assert.notEqual(decideSettlement(self, b, now).kind, 'deliver');
});

test('claims exclude another worker, expire, and respect failure cooldown', () => {
    const b = board(); const job = { key: 'facility:furnace' };
    assert.equal(claimJob(b, job, 'ChatGPT', now), true);
    assert.equal(claimJob(b, job, 'Cursor', now), false);
    assert.equal(claimJob(b, job, 'Cursor', now + 46000), true);
    b.cooldowns['Cursor:facility:furnace'] = now + 100000;
    assert.equal(claimJob(b, job, 'Cursor', now + 47000), false);
});

test('separate stores persist shared state and a held lock prevents mutations', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'npc-settlement-'));
    try {
        const first = new SettlementStore(dir), second = new SettlementStore(dir);
        first.transaction(b => { b.base = home; b.members.Cursor = member(); });
        assert.equal(second.transaction(b => b.members.Cursor.name), 'Cursor');
        writeFileSync(path.join(dir, 'settlement.lock'), JSON.stringify({ pid: process.pid }), 'utf8');
        assert.equal(second.transaction(b => { b.members = {}; }), null);
        assert.equal(JSON.parse(readFileSync(path.join(dir, 'settlement.json'), 'utf8')).members.Cursor.name, 'Cursor');
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('three separate bot processes cannot own the same shared facility job', async t => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'npc-claims-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const storeURL = new URL('../src/agent/npc/settlement_store.js', import.meta.url).href;
    const decisionsURL = new URL('../src/agent/npc/settlement.js', import.meta.url).href;
    const worker = `import { SettlementStore } from ${JSON.stringify(storeURL)};
        import { claimJob } from ${JSON.stringify(decisionsURL)};
        const store = new SettlementStore(process.argv[1]);
        let result = null;
        for (let i = 0; result === null && i < 100; i++) {
            result = store.transaction(b => claimJob(b, { key: 'facility:furnace' }, process.argv[2], Date.now()));
            if (result === null) await new Promise(r => setTimeout(r, 2));
        }
        process.stdout.write(JSON.stringify(result));`;
    const results = await Promise.all(['Cursor', 'ChatGPT', 'Claude'].map(name =>
        promisify(execFile)(process.execPath, ['--input-type=module', '-e', worker, dir, name], { encoding: 'utf8' })));
    assert.equal(results.filter(r => JSON.parse(r.stdout) === true).length, 1);
    assert.equal(results.filter(r => JSON.parse(r.stdout) === false).length, 2);
});

test('an unreadable board is preserved rather than silently reset', t => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'npc-board-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'settlement.json');
    writeFileSync(file, '{broken', 'utf8');
    assert.throws(() => new SettlementStore(dir).transaction(b => { b.base = home; }));
    assert.equal(readFileSync(file, 'utf8'), '{broken');
});

const runtimeSource = readFileSync(new URL('../src/agent/npc/settlement_runtime.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '').replace('export class SettlementRuntime', 'class SettlementRuntime');
function runtimeSetup(t, self, extraSkills = {}) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'npc-simulation-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const config = { settlement_simulation: true };
    const world = { getInventoryCounts: () => self.inventory };
    const Runtime = new Function('path', 'createHash', 'SettlementStore', 'ROLES', 'FOOD', 'decideSettlement', 'claimJob', 'distance', 'world', 'skills', 'settings', 'setTimeout',
        runtimeSource + '\nreturn SettlementRuntime;')(path, createHash, SettlementStore, ROLES, FOOD, decideSettlement, claimJob, distance, world, extraSkills, config, fn => queueMicrotask(fn));
    const messages = [], actions = [];
    const agent = { name: self.name, bot: { entity: { position: home }, players: {}, health: 20, food: 20 },
        history: { add() {}, save() {} }, openChat: text => messages.push(text),
        requestInterrupt() { this.interrupted = true; },
        actions: { currentActionLabel: '', runAction: async (label, fn) => { actions.push(label); await fn(); return {}; } } };
    const runtime = new Runtime(agent);
    runtime.store = new SettlementStore(dir);
    runtime.store.transaction(b => Object.assign(b, board(self)));
    runtime.board = board(self); runtime.snapshot = self;
    return { runtime, agent, messages, actions, config };
}

test('routine chooses and records an item goal, completion survives a new store', async t => {
    const self = member(); const { runtime } = runtimeSetup(t, self);
    assert.equal(await runtime.routine(), false);
    assert.deepEqual(runtime.candidate(), { name: 'stone_pickaxe', quantity: 1 });
    runtime.finish(true);
    const persisted = new SettlementStore(runtime.store.directory).transaction(b => b.events.at(-1));
    assert.equal(persisted.job.item, 'stone_pickaxe'); assert.equal(persisted.success, true);
});

test('shared material shortage asks a friend and donor selects actual delivery', async t => {
    const self = member('ChatGPT'); const friend = member('Cursor', { cobblestone: 32 });
    self.at = friend.at = Date.now();
    const { runtime, messages } = runtimeSetup(t, self);
    runtime.store.transaction(b => { b.members.Cursor = friend; });
    assert.equal(await runtime.routine(), true);
    assert.equal(runtime.candidate(), null); assert.equal(messages.length, 1);
    const b = runtime.store.transaction(b => structuredClone(b));
    assert.equal(decideSettlement(friend, b, Date.now()).kind, 'deliver');
    runtime.nextDecision = 0; await runtime.routine();
    assert.equal(messages.length, 1); // no repeated request chatter
});

test('hungry friend requests spare food before returning to ordinary work', async t => {
    const self = member('ChatGPT'); self.food = 8;
    const friend = member('Claude', { bread: 8 }); self.at = friend.at = Date.now();
    const { runtime } = runtimeSetup(t, self);
    runtime.store.transaction(b => { b.members.Claude = friend; });
    await runtime.routine();
    const request = runtime.store.transaction(b => Object.values(b.requests)[0]);
    assert.equal(request.item, 'bread'); assert.equal(request.quantity, 2);
});

test('paused routine does nothing and cancellation releases work', async t => {
    const self = member(); const { runtime, agent } = runtimeSetup(t, self);
    self.active = false; await runtime.routine(); assert.equal(runtime.current, null);
    self.active = true; await runtime.routine();
    const job = runtime.current; assert.ok(job);
    agent.actions.currentActionLabel = 'itemGoal:next'; runtime.cancel();
    assert.equal(runtime.current, null); assert.equal(agent.interrupted, true);
    assert.equal(runtime.store.transaction(b => b.claims[job.key]), undefined);
});

test('user assigned roles persist and can be cleared to free living', t => {
    const { runtime } = runtimeSetup(t, member('Cursor'));
    assert.equal(runtime.assignRole('farmer').success, true);
    assert.equal(runtime.snapshot.role, 'farmer');
    const reopened = new SettlementStore(runtime.store.directory);
    assert.equal(reopened.transaction(b => b.assignments.Cursor), 'farmer');
    assert.equal(runtime.assignRole('generalist').success, true);
    assert.equal(reopened.transaction(b => b.assignments.Cursor), 'generalist');
    assert.equal(runtime.assignRole('invented-job').success, false);
    assert.equal(reopened.transaction(b => b.assignments.Cursor), 'generalist');
});

test('failed job cools down and next idle turn scouts instead of retrying', async t => {
    const self = member(); const { runtime } = runtimeSetup(t, self);
    await runtime.routine(); runtime.finish(false); runtime.nextDecision = 0;
    let executed;
    runtime.execute = async job => { executed = job.kind; return true; };
    await runtime.routine(); assert.equal(executed, 'scout');
});

test('delivery succeeds only after sender loses items AND recipient inventory increases', async t => {
    for (const received of [false, true]) {
        const self = member('Cursor', { oak_log: 32 });
        const friend = member('ChatGPT'); self.at = friend.at = Date.now();
        let runtime;
        const setup = runtimeSetup(t, self, { goToPlayer: async () => true });
        setup.agent.bot.toss = async () => {
            self.inventory.oak_log -= 8;
            if (received) runtime.store.transaction(b => {
                b.members.ChatGPT.inventory.oak_log = 8; b.members.ChatGPT.at = friend.at + 1;
            });
        };
        runtime = setup.runtime;
        setup.agent.bot.entity.position = { distanceTo: () => 2.5 };
        setup.agent.bot.players.ChatGPT = { entity: { position: { offset: () => ({}) } } };
        setup.agent.bot.inventory = { items: () => [{ name: 'oak_log', type: 1, metadata: null }] };
        setup.agent.bot.lookAt = async () => {};
        runtime.store.transaction(b => { b.members.ChatGPT = friend; });
        const result = await runtime.execute({ kind: 'deliver', item: 'oak_log', quantity: 8, to: 'ChatGPT' });
        assert.equal(result, received);
    }
});
