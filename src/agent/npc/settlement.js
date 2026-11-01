// Pure settlement decisions: observed state, never conversational promises.
export const ROLES = ['generalist', 'gatherer', 'crafter', 'farmer'];
export const FOOD = ['bread', 'cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'baked_potato', 'carrot', 'apple'];
export const SEEDS = ['wheat_seeds', 'beetroot_seeds', 'carrot', 'potato'];
export const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
export const freshMembers = (board, now) => Object.values(board.members).filter(m => now - m.at < 30000);

export function decideSettlement(self, board, now) {
    const inv = self.inventory;
    const role = self.role;
    const obtain = (item, quantity, project = false) => ({ kind: 'obtain', item, quantity, key: project ? `stock:${item}` : `${self.name}:${item}` });
    if (self.health < 10 || self.food < 6) {
        const food = FOOD.find(item => inv[item] > 0);
        return food ? { kind: 'eat', item: food, key: `${self.name}:eat` } : { kind: 'rest', key: `${self.name}:rest` };
    }
    if (distance(self.position, board.base) > 48) return { kind: 'return', key: `${self.name}:return` };
    if (self.food < 17) {
        const food = FOOD.find(item => inv[item] > 0);
        if (food) return { kind: 'eat', item: food, key: `${self.name}:eat` };
    }
    if (self.night) return { kind: self.hasBed ? 'sleep' : 'rest', key: `${self.name}:night` };
    // Only idle, participating friends donate; player-directed inventories are reserved.
    const request = Object.values(board.requests).find(r => r.to !== self.name && r.state === 'open'
        && now - r.at < 60000 && board.members[r.to]?.active && now - board.members[r.to].at < 30000
        && (inv[r.item] || 0) >= r.quantity + 4);
    if (request) return { kind: 'deliver', item: request.item, quantity: request.quantity, to: request.to,
        request: request.id, key: `delivery:${request.id}` };
    const generalist = !role || role === 'generalist';
    if (generalist && self.ripeCrop) return { kind: 'harvest', item: self.ripeCrop, key: 'farm:harvest' };
    if (generalist && SEEDS.some(item => inv[item]) && self.canFarm) {
        if (!Object.keys(inv).some(item => item.endsWith('_hoe') && inv[item])) return obtain('stone_hoe', 1);
        return { kind: 'farm', item: SEEDS.find(item => inv[item]), key: 'farm:plots' };
    }
    const tools = role === 'farmer' ? ['stone_hoe', 'stone_pickaxe'] : ['stone_pickaxe', 'stone_axe'];
    for (const item of tools) if (!inv[item]) return obtain(item, 1);
    const logs = self.nearby.find(name => /_log$/.test(name));
    if (role === 'gatherer' || generalist) {
        if (logs && (inv[logs] || 0) < 32) return obtain(logs, 32, true);
        if (self.nearby.includes('stone') && (inv.cobblestone || 0) < 32) return obtain('cobblestone', 32, true);
    }
    if (role === 'crafter' || generalist) {
        for (const item of ['crafting_table', 'furnace']) {
            if (self.nearby.includes(item)) continue;
            if (inv[item]) return { kind: 'place', item, key: `facility:${item}` };
            return obtain(item, 1, true);
        }
    }
    if (role === 'farmer' || generalist) {
        if (self.ripeCrop) return { kind: 'harvest', item: self.ripeCrop, key: 'farm:harvest' };
        const seed = SEEDS.find(item => inv[item] > 0);
        if (seed && self.canFarm) return { kind: 'farm', item: seed, key: 'farm:plots' };
        if ((inv.wheat || 0) >= 3 && (inv.bread || 0) < 8) return obtain('bread', Math.min(8, (inv.bread || 0) + Math.floor(inv.wheat / 3)));
        if (!seed && self.nearby.includes('short_grass')) return { kind: 'seeds', item: 'short_grass', key: 'farm:seeds' };
        if (!FOOD.some(item => inv[item] > 0) && self.animals?.includes('cow')) return obtain('cooked_beef', 4);
    }
    // Rotate short excursions around home instead of standing still or wandering forever.
    return { kind: 'scout', key: `${self.name}:scout` };
}

export function claimJob(board, job, name, now) {
    const claim = board.claims[job.key];
    if (claim && claim.until > now && claim.owner !== name) return false;
    if ((board.cooldowns[`${name}:${job.key}`] || 0) > now) return false;
    board.claims[job.key] = { owner: name, until: now + 45000, job };
    return true;
}
