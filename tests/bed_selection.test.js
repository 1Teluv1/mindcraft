import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/agent/library/skills.js', import.meta.url), 'utf8');
const start = source.indexOf('export async function goToBed(');
const end = source.indexOf('\nexport ', start + 1);
const makeSkill = new Function('goToPosition', 'log', source.slice(start, end).replace('export ', '') + '; return goToBed;');

function fixture() {
    const blocks = [true, false, false].map((occupied, index) => ({
        name: 'white_bed', position: { x: index, y: 64, z: 0 },
        getProperties: () => ({ occupied, part: 'head' }),
    }));
    const attempts = [];
    const logs = [];
    const bot = {
        entity: { position: { distanceTo: p => p.x } },
        findBlocks: ({ matching }) => blocks.filter(matching).map(b => b.position),
        blockAt: p => blocks[p.x], modes: { pause() {} },
        sleep: async b => { attempts.push(b.position.x); },
    };
    return { bot, blocks, attempts, logs, run: makeSkill(async () => true, (_, msg) => logs.push(msg)) };
}

test('skips occupied beds, bedrock and duplicate foot halves', async () => {
    const { bot, blocks, attempts, run } = fixture();
    blocks.push({ name: 'bedrock', position: { x: 3 }, getProperties: () => ({}) });
    blocks[2].getProperties = () => ({ part: 'foot' });
    assert.equal(await run(bot), true);
    assert.deepEqual(attempts, [1]);
});

test('tries another bed when nearest bed becomes occupied during sleep attempt', async () => {
    const { bot, attempts, run } = fixture();
    bot.sleep = async b => {
        attempts.push(b.position.x);
        if (b.position.x === 1) throw new Error('the bed is occupied');
    };
    assert.equal(await run(bot), true);
    assert.deepEqual(attempts, [1, 2]);
});

test('reports no free bed and respects interrupts', async () => {
    const { bot, blocks, attempts, logs, run } = fixture();
    bot.interrupt_code = true;
    assert.equal(await run(bot), false);
    bot.interrupt_code = false;
    blocks.forEach(b => { b.getProperties = () => ({ occupied: true, part: 'head' }); });
    assert.equal(await run(bot), false);
    assert.match(logs.at(-1), /빈 침대/);
    assert.deepEqual(attempts, []);
});

test('daytime failure stops without cycling through all beds', async () => {
    const { bot, attempts, run } = fixture();
    bot.sleep = async b => { attempts.push(b.position.x); throw new Error("it's not night and it's not a thunderstorm"); };
    assert.equal(await run(bot), false);
    assert.deepEqual(attempts, [1]);
});
