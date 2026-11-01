import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
const start = source.indexOf('export async function goToGoal(');
const body = source.slice(start, source.indexOf('\nlet _doorInterval', start));

test('a successful non-destructive path reaches goto without a constant assignment error', async () => {
    const calls = [];
    const movements = [];
    const goToGoal = new Function('pf', 'mc', 'log', 'startDoorInterval', 'clearInterval',
        body.replace('export ', '') + '; return goToGoal;')(
        { Movements: class { constructor() { this.blocksCantBreak = new Set(); movements.push(this); } } },
        { getBlockId: () => 1 }, () => {}, () => 42, id => calls.push(['clear', id]));
    const goal = {};
    const bot = { pathfinder: {
        getPathTo: () => ({ status: 'success' }),
        setMovements: move => calls.push(['movements', move]),
        goto: async target => calls.push(['goto', target]),
    } };
    assert.equal(await goToGoal(bot, goal), true);
    assert.equal(calls[0][1], movements[0]);
    assert.deepEqual(calls.slice(1), [['goto', goal], ['clear', 42]]);
});
