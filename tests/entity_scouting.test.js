import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
const body = source.slice(source.indexOf('export async function goToNearestEntity'), source.indexOf('export async function goToPlayer'));
function setup({ appear = Infinity, health = 20, interrupt = false } = {}) {
    const moves = [];
    const point = (x, y, z) => ({ x, y, z, clone() { return point(x,y,z); }, offset(a,b,c) { return point(x+a,y+b,z+c); }, floored() { return point(Math.floor(x),Math.floor(y),Math.floor(z)); } });
    const bot = { entity: { position: point(0,64,0) }, health, food: 20, interrupt_code: interrupt,
        blockAt: p => ({ name: p.y < 64 ? 'stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty' }),
        pathfinder: { stop() {} } };
    const entity = { position: point(10,64,10) };
    const world = { getNearestEntityWhere: () => moves.length >= appear ? entity : null };
    const go = async (...args) => { moves.push(args); return true; };
    const search = new Function('world', 'goToPosition', 'log', body.replace('export ', '') + '; return goToNearestEntity;')(world, go, () => {});
    return { bot, moves, search };
}
test('missing entity expands scouting and returns to origin', async () => {
    const { bot, moves, search } = setup();
    assert.equal(await search(bot, 'zombie', 4, 64), false);
    assert.equal(moves.length, 9);
    assert.equal(moves[0][1], 24);
    assert.ok(moves.slice(4,8).some(m => Math.hypot(m[1],m[3]) > 40));
    assert.deepEqual(moves.at(-1).slice(1), [0,64,0,3]);
});
test('entity discovered during scouting stops further waypoints', async () => {
    const { bot, moves, search } = setup({ appear: 1 });
    assert.equal(await search(bot, 'zombie', 4, 64), true);
    assert.equal(moves.length, 2);
    assert.deepEqual(moves.at(-1).slice(1), [10,64,10,4]);
});
test('low health or interruption prevents scouting', async () => {
    for (const options of [{ health: 9 }, { interrupt: true }]) {
        const { bot, moves, search } = setup(options);
        assert.equal(await search(bot, 'zombie', 4, 64), false);
        assert.equal(moves.length, 0);
    }
});
