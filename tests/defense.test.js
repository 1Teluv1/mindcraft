import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { trackAttackers, recentAttacker, defenseTarget, canStartDefense } from '../src/agent/library/defense.js';

const hostile = entity => entity?.type === 'mob';
function setup() {
    const bot = new EventEmitter();
    bot.entity = { id: 1, position: { distanceTo: p => Math.abs(p.x) } };
    bot.entities = {};
    bot.nearestEntity = predicate => Object.values(bot.entities).filter(predicate).sort((a,b) => a.position.x - b.position.x)[0] || null;
    trackAttackers(bot, hostile);
    return bot;
}
const mob = (id, x, type = 'mob') => ({ id, type, name: 'skeleton', position: { x } });

test('damage source outside the ordinary eight-block radius becomes the priority target', () => {
    const bot = setup();
    bot.entities[2] = mob(2, 18);
    bot.entities[3] = mob(3, 3);
    bot.emit('entityHurt', bot.entity, bot.entities[2]);
    assert.equal(defenseTarget(bot, hostile).id, 2);
});

test('recent damage and in-range enemies bypass path completion', async () => {
    const bot = setup();
    const enemy = bot.entities[2] = mob(2, 18);
    bot.emit('entityHurt', bot.entity, enemy);
    const blocked = () => { throw new Error('Path preflight must not be called'); };
    assert.equal(await canStartDefense(bot, enemy, hostile, blocked), true);
    bot.recentAttacker = null;
    enemy.position.x = 2;
    assert.equal(await canStartDefense(bot, enemy, hostile, blocked), true);
    enemy.position.x = 7;
    assert.equal(await canStartDefense(bot, enemy, hostile, async () => false), false);
});

test('players, unrelated damage, gone and stale sources are never retaliation targets', () => {
    const bot = setup();
    const player = bot.entities[2] = mob(2, 2, 'player');
    bot.emit('entityHurt', bot.entity, player);
    assert.equal(recentAttacker(bot, hostile), null);
    bot.emit('entityHurt', player, mob(3, 2));
    assert.equal(recentAttacker(bot, hostile), null);
    const enemy = bot.entities[3] = mob(3, 40);
    bot.emit('entityHurt', bot.entity, enemy);
    assert.equal(recentAttacker(bot, hostile), null);
    enemy.position.x = 4;
    bot.recentAttacker.time -= 11000;
    assert.equal(recentAttacker(bot, hostile), null);
    bot.emit('entityHurt', bot.entity, enemy);
    delete bot.entities[3];
    assert.equal(recentAttacker(bot, hostile), null);
});

test('death clears the previous attacker', () => {
    const bot = setup();
    const enemy = bot.entities[2] = mob(2, 3);
    bot.emit('entityHurt', bot.entity, enemy);
    bot.emit('death');
    assert.equal(bot.recentAttacker, null);
});

// Run the actual combat function with controlled plugin I/O, without loading game clients.
const skills = await readFile(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
const start = skills.indexOf('export async function defendSelf(');
const end = skills.indexOf('\nexport ', start + 1);
const source = skills.slice(start, end).replace('export async function', 'async function');
const createDefense = new Function('defenseTarget', 'mc', 'equipHighestAttack', 'log', 'setTimeout', `${source}; return defendSelf;`);

test('melee combat starts PVP without awaiting an approach or retreat and cleans up', async () => {
    const bot = setup();
    bot.entities[2] = mob(2, 1);
    const events = [];
    bot.modes = { pause: name => events.push(`pause:${name}`), unpause: name => events.push(`unpause:${name}`) };
    bot.pathfinder = { goto: () => { throw new Error('Combat must let PVP own pursuit'); } };
    bot.pvp = { attack: async enemy => { events.push('attack'); delete bot.entities[enemy.id]; }, stop: async () => events.push('stop') };
    const defend = createDefense(defenseTarget, { isHostile: hostile }, async () => events.push('equip'), () => {}, fn => fn());
    assert.equal(await defend(bot), true);
    assert.ok(events.includes('attack'));
    assert.ok(events.includes('stop'));
    assert.ok(events.includes('unpause:self_defense'));
});

test('combat plugin errors still stop PVP and release defensive mode pauses', async () => {
    const bot = setup();
    bot.entities[2] = mob(2, 2);
    const resumed = [];
    let stopped = false;
    bot.modes = { pause: () => {}, unpause: name => resumed.push(name) };
    bot.pvp = { attack: async () => { throw new Error('plugin failure'); }, stop: async () => { stopped = true; } };
    const defend = createDefense(defenseTarget, { isHostile: hostile }, async () => {}, () => {}, fn => fn());
    await assert.rejects(defend(bot), /plugin failure/);
    assert.ok(stopped);
    assert.deepEqual(resumed, ['self_defense', 'cowardice']);
});
