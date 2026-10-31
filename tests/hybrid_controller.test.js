import test from 'node:test';
import assert from 'node:assert/strict';
import { HybridController } from '../src/agent/npc/hybrid_controller.js';

function setup(step) {
    let time = 1000;
    const inventory = {};
    const events = [];
    let calls = 0;
    let idle = true;
    let interrupted = false;
    const io = {
        canAct: () => idle,
        inventory: () => ({ ...inventory }),
        interrupted: () => interrupted,
        chooseGoal: () => ({ name: 'oak_log', quantity: 16 }),
        step: async (...args) => { calls++; await step?.(inventory, ...args); },
        notify: (...args) => events.push(args),
    };
    const controller = new HybridController(io, {}, () => time);
    return { controller, inventory, events, io, calls: () => calls,
        advance: () => { time += 10000; }, idle: value => { idle = value; },
        interrupt: value => { interrupted = value; } };
}

test('prerequisites advance without model requests and completion is reported once', async () => {
    let stage = 0;
    const t = setup(inv => {
        stage++;
        if (stage === 1) inv.oak_log = 2;
        if (stage === 2) { inv.oak_log = 0; inv.stick = 4; }
        if (stage === 3) inv.stone_axe = 1;
    });
    t.controller.setGoal('stone_axe', 1, 'player');
    for (let i = 0; i < 4; i++) { await t.controller.tick(false); t.advance(); }
    assert.equal(t.calls(), 3);
    assert.equal(t.controller.goal, null);
    assert.equal(t.events.length, 1);
    assert.equal(t.events[0][1], 'player');
    assert.equal(t.events[0][2], true);
    assert.equal(t.controller.takeReplan(), null);
});

test('total inventory target requests only the missing quantity', async () => {
    let requested;
    const t = setup((inv, name, quantity) => { requested = quantity; inv[name] += quantity; });
    t.inventory.oak_log = 10;
    t.controller.setGoal('oak_log', 16);
    await t.controller.tick(false);
    assert.equal(requested, 6);
    assert.equal(t.inventory.oak_log, 16);
});

test('three failed steps cause one bounded replan, not endless polling', async () => {
    const t = setup();
    t.controller.setGoal('stone_axe', 1);
    for (let i = 0; i < 3; i++) { await t.controller.tick(false); t.advance(); }
    assert.match(t.controller.takeReplan(), /three attempts/);
    assert.equal(t.controller.takeReplan(), null);
    for (let i = 0; i < 3; i++) { await t.controller.tick(false); t.advance(); }
    assert.equal(t.calls(), 3);
});

test('busy or interrupted work does not count as a failed attempt', async () => {
    const t = setup();
    t.controller.setGoal('stone_axe', 1);
    t.idle(false);
    await t.controller.tick(false);
    assert.equal(t.calls(), 0);
    t.idle(true); t.interrupt(true);
    await t.controller.tick(false);
    assert.equal(t.controller.goal.failures, 0);
});

test('player cancellation during an awaited step cannot resurrect the goal', async () => {
    let finish;
    const t = setup(() => new Promise(resolve => { finish = resolve; }));
    t.controller.setGoal('stone_axe', 1);
    const pending = t.controller.tick(false);
    await t.controller.tick(false);
    assert.equal(t.calls(), 1);
    t.controller.cancel();
    finish(); await pending;
    assert.equal(t.controller.goal, null);
    assert.equal(t.events.length, 0);
});

test('paused input, disabled mode and stopped routine do no work', async () => {
    const t = setup();
    await t.controller.tick(false);
    assert.equal(t.calls(), 0);
    t.controller.pauseForInput();
    await t.controller.tick(true);
    assert.equal(t.calls(), 0);
    t.advance(); t.controller.config.hybrid_autonomy = false;
    await t.controller.tick(true);
    assert.equal(t.calls(), 0);
});

test('invalid targets are rejected and sufficient stock completes without a step', async () => {
    const t = setup();
    assert.throws(() => t.controller.setGoal('oak_log', NaN));
    assert.throws(() => t.controller.setGoal('oak_log', 257));
    t.inventory.oak_log = 16;
    t.controller.setGoal('oak_log', 16);
    await t.controller.tick(false);
    assert.equal(t.calls(), 0);
    assert.equal(t.controller.goal, null);
});

test('routine goals are local and blocked resources are cooled down', async () => {
    const t = setup();
    for (let i = 0; i < 3; i++) { await t.controller.tick(true); t.advance(); }
    assert.equal(t.calls(), 3);
    t.controller.takeReplan();
    await t.controller.tick(true);
    assert.equal(t.calls(), 3);
});
