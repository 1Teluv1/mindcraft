import test from 'node:test';
import assert from 'node:assert/strict';
import { PlayerTether } from '../src/agent/npc/player_tether.js';

function fixture(distance = 60) {
    const sent = [];
    const agent = {
        bot: { username: 'NPC', entity: { position: { distanceTo: p => p.distance } },
            players: { Steve: { entity: { position: { distance } } } }, chat: command => sent.push(command) },
        actions: { executing: true, currentActionLabel: 'action:followPlayer' },
        self_prompter: { isActive: () => false },
    };
    const tether = new PlayerTether();
    return { agent, sent, tick: (now = 0, settings = {}) => tether.update(agent, settings, n => n === 'OtherNPC', now) };
}

test('distant working NPC requests teleport without cheat mode; retries are throttled', () => {
    const { tick, sent } = fixture();
    assert.equal(tick(), true);
    assert.equal(tick(500), false);
    assert.equal(tick(15000), true);
    assert.deepEqual(sent, ['/tp @s Steve', '/tp @s Steve']);
});

test('near humans prevent teleport, bots are excluded', () => {
    const { agent, tick, sent } = fixture(48);
    agent.bot.players.OtherNPC = { entity: { position: { distance: 1 } } };
    assert.equal(tick(), false);
    agent.bot.players.Steve.entity.position.distance = 49;
    assert.equal(tick(), true);
    assert.deepEqual(sent, ['/tp @s Steve']);
});

test('tracking loss recovers by username but offline players are forgotten', () => {
    const { agent, tick, sent } = fixture(10);
    tick();
    agent.bot.players.Steve.entity = null;
    assert.equal(tick(), true);
    delete agent.bot.players.Steve;
    assert.equal(tick(20000), false);
    assert.equal(sent.length, 1);
});

test('stay, stopped agents, tasks and disabled tether do not teleport', () => {
    const { agent, tick, sent } = fixture();
    agent.actions.currentActionLabel = 'action:stay';
    assert.equal(tick(), false);
    agent.actions.currentActionLabel = null;
    agent.actions.executing = false;
    assert.equal(tick(), false);
    agent.self_prompter.isActive = () => true;
    assert.equal(tick(0, { player_teleport_distance: 0 }), false);
    assert.equal(tick(0, { task: {} }), false);
    assert.equal(tick(), true);
    assert.equal(sent.length, 1);
});
