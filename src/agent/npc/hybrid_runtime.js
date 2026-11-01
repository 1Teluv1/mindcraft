import { HybridController } from './hybrid_controller.js';
import { ItemGoal } from './item_goal.js';
import * as world from '../library/world.js';
import settings from '../settings.js';
import convoManager from '../conversation.js';
import { SettlementRuntime } from './settlement_runtime.js';

export function createHybridController(agent) {
    const planner = new ItemGoal(agent);
    agent.settlement = new SettlementRuntime(agent);
    return new HybridController({
        canAct: () => agent.isIdle() && !agent.prompter.preempt_active && !convoManager.inConversation() && !agent.actions.resume_func,
        inventory: () => world.getInventoryCounts(agent.bot),
        interrupted: () => !!agent.bot.interrupt_code,
        step: (name, quantity) => planner.executeNext(name, quantity),
        routine: () => agent.settlement.routine(),
        cancelRoutine: () => agent.settlement.cancel(),
        chooseGoal: () => {
            if (agent.settlement.enabled()) return agent.settlement.candidate();
            // Keep a small reserve; no endless harvesting or arbitrary building.
            if (agent.npc.data.goals.length || agent.npc.data.curr_goal) return null;
            const inventory = world.getInventoryCounts(agent.bot);
            const nearby = world.getNearbyBlockTypes(agent.bot);
            const log = nearby.find(name => /_log$/.test(name));
            const logs = Object.entries(inventory).filter(([name]) => /_log$/.test(name)).reduce((n, [, count]) => n + count, 0);
            if (log && logs < 16) return { name: log, quantity: (inventory[log] || 0) + 16 - logs };
            if (nearby.includes('stone') && (inventory.cobblestone || 0) < 32)
                return { name: 'cobblestone', quantity: 32 };
            return null;
        },
        notify: (message, owner, complete, goal) => {
            if (goal?.routine) agent.settlement.finish(complete);
            agent.history.add('system', message);
            agent.history.save();
            if (owner) agent.routeResponse(owner, complete ? '부탁한 아이템을 필요한 수량만큼 준비했어.' : '아이템을 준비하다가 막혔어. 다른 방법이 필요해.');
        },
    }, settings);
}
