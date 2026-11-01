// Local distance guard; command attempts are rate limited even if OP is missing.
export class PlayerTether {
    constructor() {
        this.target = null;
        this.nextAttempt = 0;
    }

    update(agent, settings, isBot, now = Date.now()) {
        const bot = agent.bot;
        const limit = settings.player_teleport_distance ?? 48;
        if (!(limit > 0) || settings.task || !bot.entity?.position) return false;
        if (agent.actions.currentActionLabel === 'action:stay') return false;
        if (!agent.actions.executing && !agent.self_prompter.isActive()) return false;

        const humans = Object.entries(bot.players || {}).filter(([name]) =>
            name !== bot.username && !isBot(name) && /^[A-Za-z0-9_]{1,16}$/.test(name));
        const visible = humans.filter(([, player]) => player.entity?.position)
            .map(([name, player]) => ({ name, distance: bot.entity.position.distanceTo(player.entity.position) }))
            .sort((a, b) => a.distance - b.distance);
        // Remember an observed human when they leave entity tracking range.
        const nearest = visible[0];
        if (nearest) this.target = nearest.name;
        else if (!humans.some(([name]) => name === this.target)) this.target = null;
        if (!this.target || (nearest && nearest.distance <= limit) || now < this.nextAttempt) return false;

        this.nextAttempt = now + Math.max(1000, settings.player_teleport_cooldown_ms ?? 15000);
        bot.chat(`/tp @s ${this.target}`);
        return true;
    }
}
