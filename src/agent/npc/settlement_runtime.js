import path from 'node:path';
import { createHash } from 'node:crypto';
import { SettlementStore } from './settlement_store.js';
import { ROLES, FOOD, decideSettlement, claimJob, distance } from './settlement.js';
import * as world from '../library/world.js';
import * as skills from '../library/skills.js';
import settings from '../settings.js';

export class SettlementRuntime {
    constructor(agent) {
        this.agent = agent;
        this.current = null;
        this.nextSnapshot = 0;
        this.nextDecision = 0;
        this.lastSpeech = 0;
        this.scoutIndex = 0;
        this.board = null;
        this.snapshot = null;
    }

    enabled() { return settings.settlement_simulation === true && !settings.task; }

    refresh(active) {
        if (!this.enabled() || Date.now() < this.nextSnapshot) return;
        this.nextSnapshot = Date.now() + 3000;
        const bot = this.agent.bot;
        const dimension = String(bot.game.dimension);
        const worldKey = `${settings.host}:${settings.port}:${dimension}:${settings.settlement_world_id || 'default'}`;
        if (worldKey !== this.worldKey) {
            if (this.worldKey) this.agent.hybrid.cancel();
            this.worldKey = worldKey;
            this.current = null;
            this.store = new SettlementStore(path.join(process.cwd(), 'bots', 'shared', 'settlements', createHash('sha256').update(worldKey).digest('hex').slice(0, 16)));
        }
        const nearby = world.getNearbyBlockTypes(bot);
        const crops = bot.findBlocks({ matching: b => ['wheat', 'carrots', 'potatoes', 'beetroots'].includes(b.name)
            && b.getProperties().age >= (b.name === 'beetroots' ? 3 : 7), maxDistance: 16, count: 1 });
        const farm = bot.findBlocks({ matching: b => ['dirt', 'grass_block', 'farmland'].includes(b.name)
            && bot.blockAt(b.position.offset(0, 1, 0))?.name === 'air', maxDistance: 12, count: 1 });
        const self = {
            name: this.agent.name, role: settings.settlement_roles?.[this.agent.name] || 'generalist',
            inventory: world.getInventoryCounts(bot), health: bot.health, food: bot.food,
            position: { x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z },
            nearby, animals: world.getNearbyEntityTypes(bot), night: bot.time.timeOfDay >= 13000 && bot.time.timeOfDay < 23000,
            hasBed: nearby.some(n => n.endsWith('_bed')), canFarm: farm.length > 0,
            ripeCrop: crops.length ? bot.blockAt(crops[0])?.name : null,
            active: !!active, at: Date.now(), action: this.current || null,
        };
        this.snapshot = self;
        try {
            this.board = this.store.transaction(board => {
                self.role = board.assignments?.[self.name] || self.role;
                board.base ||= { ...self.position };
                board.members[self.name] = self;
                if (this.current && board.claims[this.current.key]?.owner === self.name)
                    board.claims[this.current.key].until = Date.now() + 45000;
                for (const [key, request] of Object.entries(board.requests))
                    if (Date.now() - request.at > 120000) delete board.requests[key];
                for (const [key, claim] of Object.entries(board.claims))
                    if (claim.until < Date.now()) delete board.claims[key];
                for (const [key, until] of Object.entries(board.cooldowns))
                    if (until < Date.now()) delete board.cooldowns[key];
                return structuredClone(board);
            });
        } catch (error) { this.board = null; console.error('Settlement snapshot:', error.message); }
    }

    context() {
        if (!this.enabled() || !this.board || !this.snapshot) return '';
        return `공동 생활 상태(실측): 역할=${this.snapshot.role}, 거점=${JSON.stringify(this.board.base)}\n`
            + Object.values(this.board.members).filter(m => Date.now() - m.at < 30000)
                .map(m => `${m.name}: ${m.role}, ${m.active ? '자율 생활 중' : '개인 요청/대기 중'}, 작업=${JSON.stringify(m.action)}, 재고=${JSON.stringify(m.inventory)}`).join('\n')
            + '\n모든 캐릭터는 같은 능력을 가진다. 역할은 사용자만 지정한다. generalist는 자유 생활이며 주변 필요에 따라 채집·제작·농사를 모두 한다. 사용자의 역할 지정은 !setRole로 저장한다. 없는 완료 사실을 말하거나 같은 일을 중복 지시하지 않는다. 사용자 부탁이 우선이다.';
    }

    assignRole(role) {
        if (!ROLES.includes(role)) return { success: false, message: '역할은 generalist(자유), gatherer(채집), crafter(제작), farmer(농사) 중 하나여야 해.' };
        if (!this.store) return { success: false, message: '월드 상태를 아직 읽지 못했어. 잠시 뒤 다시 지정해 줘.' };
        const saved = this.store.transaction(board => {
            board.assignments ||= {};
            board.assignments[this.agent.name] = role;
            return true;
        });
        if (!saved) return { success: false, message: '공유 상태가 사용 중이야. 잠시 뒤 다시 지정해 줘.' };
        if (this.agent.hybrid?.goal?.routine) this.agent.hybrid.cancel();
        else this.cancel();
        if (this.snapshot) this.snapshot.role = role;
        this.nextSnapshot = 0;
        return { success: true, message: `역할을 ${role}로 저장했어. 이 역할을 우선해서 자율적으로 생활할게.` };
    }

    cancel() {
        const job = this.current;
        this.current = null;
        this.nextDecision = Date.now() + 10000;
        if (job) {
            try {
                this.store?.transaction(board => {
                    if (board.claims[job.key]?.owner === this.agent.name) delete board.claims[job.key];
                });
            } catch (error) { console.error('Settlement cancellation:', error.message); }
            if (/^(settlement:|itemGoal:)/.test(this.agent.actions.currentActionLabel)) this.agent.requestInterrupt();
        }
    }

    speak(text) {
        if (this.agent.shut_up || Date.now() - this.lastSpeech < 30000) return;
        this.lastSpeech = Date.now();
        this.agent.openChat(text);
    }

    async routine() {
        if (!this.enabled()) return false;
        // true means the settlement owns this idle turn, including deliberate rest.
        if (!this.board || !this.snapshot || !this.snapshot.active || Date.now() < this.nextDecision) return true;
        this.nextDecision = Date.now() + 5000;
        let job;
        try {
            job = this.store.transaction(board => {
                const self = this.snapshot;
                let candidate = decideSettlement(self, board, Date.now());
                if (!claimJob(board, candidate, self.name, Date.now())) {
                    if (['rest', 'sleep', 'eat', 'return'].includes(candidate.kind)) return null;
                    candidate = { kind: 'scout', key: `${self.name}:scout` };
                    if (!claimJob(board, candidate, self.name, Date.now())) return null;
                }
                // Ask a friend for available raw materials before duplicating their gathering.
                if (candidate.kind === 'obtain' || (self.food < 17 && !FOOD.some(item => self.inventory[item]))) {
                    const donors = Object.values(board.members).filter(m => m.name !== self.name && m.active && Date.now() - m.at < 30000);
                    const food = FOOD.find(item => donors.some(m => (m.inventory[item] || 0) >= 6));
                    const log = donors.flatMap(m => Object.keys(m.inventory)).find(item => /_log$/.test(item));
                    const hasLogs = Object.keys(self.inventory).some(item => /_log$/.test(item) && self.inventory[item] > 0);
                    const needs = self.food < 17 && food && !FOOD.some(item => self.inventory[item]) ? [food, 2]
                        : /stone_|furnace/.test(candidate.item || '') && (self.inventory.cobblestone || 0) < 8
                            ? ['cobblestone', 8] : candidate.kind === 'obtain' && !hasLogs && log ? [log, 4] : null;
                    if (needs) {
                        const [item, quantity] = needs;
                        const donor = Object.values(board.members).find(m => m.name !== self.name && m.active
                            && Date.now() - m.at < 30000 && (m.inventory[item] || 0) >= quantity + 4);
                        if (donor) {
                            const id = `${self.name}:${item}`;
                            const previous = board.requests[id];
                            if (!previous) board.requests[id] = { id, to: self.name, item, quantity, at: Date.now(), state: 'open' };
                            if (!previous || (previous.state === 'open' && Date.now() - previous.at < 20000)) {
                                delete board.claims[candidate.key];
                                return { kind: 'request', to: donor.name, item, quantity, key: id, announce: !previous };
                            }
                        }
                    }
                }
                return candidate;
            });
        } catch (error) { console.error('Settlement decision:', error.message); return true; }
        if (!job) return true;
        if (job.kind === 'request') {
            if (job.announce) this.speak(`${job.to}, ${job.item} ${job.quantity}개가 필요해. 재료 좀 나눠줄래?`);
            return true;
        }
        this.current = job;
        if (job.kind === 'obtain') {
            this.speak(`나는 ${job.item} ${job.quantity}개를 준비할게.`);
            return false;
        }
        const beforeJob = job;
        try {
            let succeeded = false;
            const result = await this.agent.actions.runAction(`settlement:${job.kind}`, async () => {
                succeeded = await this.execute(job);
            }, { timeout: job.kind === 'sleep' ? -1 : 1 });
            if (this.current === beforeJob) this.finish(succeeded && !result.interrupted && !result.timedout);
        } catch (error) { if (this.current === beforeJob) this.finish(false); console.error('Settlement action:', error.message); }
        return true;
    }

    candidate() {
        return this.current?.kind === 'obtain' ? { name: this.current.item, quantity: this.current.quantity } : null;
    }

    finish(success) {
        const job = this.current;
        if (!job) return;
        this.current = null;
        const now = Date.now();
        this.nextDecision = now + 5000;
        this.store.transaction(board => {
            if (board.claims[job.key]?.owner === this.agent.name) delete board.claims[job.key];
            board.cooldowns[`${this.agent.name}:${job.key}`] = now + (success ? (job.kind === 'scout' ? 20000 : 30000) : 120000);
            if (job.request && board.requests[job.request]) board.requests[job.request].state = success ? 'received' : 'failed';
            board.events.push({ name: this.agent.name, job, success, at: now });
            board.events = board.events.slice(-40);
        });
        this.agent.history.add('system', `Settlement ${success ? 'verified' : 'blocked'}: ${JSON.stringify(job)}`);
        this.agent.history.save();
        if (success && job.kind === 'deliver') this.speak(`${job.to}, ${job.item} ${job.quantity}개 전달했어.`);
        if (success && job.kind === 'obtain') {
            const friend = Object.values(this.board.members).find(m => m.name !== this.agent.name && m.active && Date.now() - m.at < 30000);
            if (friend) this.speak(`${friend.name}, ${job.item} ${job.quantity}개 준비됐어. 필요하면 나눠줄게.`);
        }
    }

    async execute(job) {
        const bot = this.agent.bot;
        const home = this.board.base;
        if (job.kind === 'eat') return skills.consume(bot, job.item);
        if (job.kind === 'return' || job.kind === 'rest') {
            if (distance(bot.entity.position, home) > 6) return skills.goToPosition(bot, home.x, home.y, home.z, 4);
            return true;
        }
        if (job.kind === 'sleep') return skills.goToBed(bot);
        if (job.kind === 'farm') return skills.farmNearby(bot, job.item, 4);
        if (job.kind === 'harvest' || job.kind === 'seeds') {
            const before = world.getInventoryCounts(bot);
            await skills.collectBlock(bot, job.item, job.kind === 'seeds' ? 8 : 1, this.agent.npc.getBuiltPositions());
            const after = world.getInventoryCounts(bot);
            return Object.keys(after).some(item => (after[item] || 0) > (before[item] || 0));
        }
        if (job.kind === 'place') {
            if (distance(bot.entity.position, home) > 8 && !await skills.goToPosition(bot, home.x, home.y, home.z, 4)) return false;
            for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) {
                const p = bot.entity.position.offset(dx, 0, dz).floored();
                if (Math.hypot(dx, dz) < 2 || bot.blockAt(p)?.name !== 'air'
                    || bot.blockAt(p.offset(0, -1, 0))?.boundingBox !== 'block') continue;
                await skills.placeBlock(bot, job.item, p.x, p.y, p.z, 'bottom', true);
                return bot.blockAt(p)?.name === job.item;
            }
            return false;
        }
        if (job.kind === 'deliver') {
            if (!bot.players[job.to]?.entity) return false;
            const baseline = this.store.transaction(board => {
                const member = board.members[job.to];
                return member && member.active && Date.now() - member.at < 5000
                    ? { count: member.inventory[job.item] || 0, at: member.at } : null;
            });
            if (!baseline) return false;
            const senderBefore = world.getInventoryCounts(bot)[job.item] || 0;
            if (!await skills.goToPlayer(bot, job.to, 2.5) || bot.interrupt_code) return false;
            const target = bot.players[job.to]?.entity;
            const item = bot.inventory.items().find(item => item.name === job.item);
            if (!target || !item || bot.entity.position.distanceTo(target.position) > 4) return false;
            await bot.lookAt(target.position.offset(0, 1, 0));
            await bot.toss(item.type, item.metadata, job.quantity);
            if (senderBefore - (world.getInventoryCounts(bot)[job.item] || 0) < job.quantity) return false;
            // Sender dropping an item is not proof the recipient received it.
            for (let i = 0; i < 12 && !bot.interrupt_code; i++) {
                await new Promise(r => setTimeout(r, 500));
                const received = this.store.transaction(board => {
                    const member = board.members[job.to];
                    return member && member.at > baseline.at && Date.now() - member.at < 5000
                        && (member.inventory[job.item] || 0) >= baseline.count + job.quantity;
                });
                if (received) return true;
            }
            return false;
        }
        if (job.kind === 'scout') {
            const angle = (this.scoutIndex++ % 8) * Math.PI / 4;
            const x = home.x + Math.cos(angle) * 16, z = home.z + Math.sin(angle) * 16;
            for (let dy = 3; dy >= -3; dy--) {
                const p = bot.entity.position.clone().set(x, home.y + dy, z).floored();
                const ground = bot.blockAt(p.offset(0, -1, 0));
                if (ground?.boundingBox === 'block' && !/magma|cactus|campfire/.test(ground.name)
                    && bot.blockAt(p)?.name === 'air' && bot.blockAt(p.offset(0, 1, 0))?.name === 'air')
                    return skills.goToPosition(bot, p.x, p.y, p.z, 3);
            }
        }
        return false;
    }
}
