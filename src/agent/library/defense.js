// Damage sources are supplied by Mineflayer's entityHurt event (1.20+).
export function trackAttackers(bot, isHostile) {
    bot.on('entityHurt', (entity, source) => {
        if (entity?.id !== bot.entity?.id || source?.id === bot.entity.id || source?.type === 'player' || !isHostile(source)) return;
        bot.recentAttacker = { id: source.id, time: Date.now() };
    });
    bot.on('death', () => { bot.recentAttacker = null; });
}

export function recentAttacker(bot, isHostile) {
    const record = bot.recentAttacker;
    const entity = record && bot.entities[record.id];
    if (!entity || entity.isValid === false || entity.type === 'player' || !isHostile(entity) || Date.now() - record.time > 10000) return null;
    return bot.entity.position.distanceTo(entity.position) <= 32 ? entity : null;
}

export function defenseTarget(bot, isHostile, range = 8) {
    return recentAttacker(bot, isHostile) || bot.nearestEntity(entity =>
        entity.id !== bot.entity.id && entity.isValid !== false && entity.type !== 'player' && isHostile(entity) && bot.entity.position.distanceTo(entity.position) < range);
}

export async function canStartDefense(bot, enemy, isHostile, isClearPath) {
    // Do not make a damage response or an in-range strike wait for a complete path.
    return enemy && (enemy === recentAttacker(bot, isHostile) ||
        bot.entity.position.distanceTo(enemy.position) <= 3.5 || await isClearPath(bot, enemy));
}
