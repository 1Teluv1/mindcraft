import settings from './settings.js';
import * as world from './library/world.js';

const STOPPED = 0
const ACTIVE = 1
const PAUSED = 2
export class SelfPrompter {
    constructor(agent) {
        this.agent = agent;
        this.state = STOPPED;
        this.loop_active = false;
        this.interrupt = false;
        this.prompt = '';
        this.idle_time = 0;
        this.cooldown = 2000;
        this.nextRoutineDecision = Date.now() + 30000;
    }

    start(prompt) {
        console.log('Self-prompting started.');
        if (!prompt) {
            if (!this.prompt)
                return 'No prompt specified. Ignoring request.';
            prompt = this.prompt;
        }
        this.state = ACTIVE;
        this.prompt = prompt;
        this.startLoop();
    }

    isActive() {
        return this.state === ACTIVE;
    }

    isStopped() {
        return this.state === STOPPED;
    }

    isPaused() {
        return this.state === PAUSED;
    }

    async handleLoad(prompt, state) {
        if (state == undefined)
            state = STOPPED;
        this.state = state;
        this.prompt = prompt;
        if (state !== STOPPED && !prompt)
            throw new Error('No prompt loaded when self-prompting is active');
        if (state === ACTIVE) {
            await this.start(prompt);
        }
    }

    setPromptPaused(prompt) {
        this.prompt = prompt;
        this.state = PAUSED;
    }

    async startLoop() {
        if (this.loop_active) {
            console.warn('Self-prompt loop is already active. Ignoring request.');
            return;
        }
        console.log('starting self-prompt loop')
        this.loop_active = true;
        let no_command_count = 0;
        const MAX_BACKOFF_STEPS = 4;
        while (!this.interrupt && this.state === ACTIVE) {
            if (this.agent.hybrid?.enabled() && !settings.task) {
                const hybrid = this.agent.hybrid;
                const routine = this.prompt === settings.life_goal;
                if (hybrid.ownsWork() || !this.agent.isIdle() || this.agent.prompter.preempt_active) {
                    await new Promise(r => setTimeout(r, 500));
                    continue;
                }
                const event = hybrid.takeReplan();
                if (event) {
                    await this.agent.handleMessage('system', event, 1);
                    continue;
                }
                if (routine) {
                    if (this.agent.settlement?.enabled()) {
                        await new Promise(r => setTimeout(r, 500));
                        continue;
                    }
                    // Resource steps stay local; ask the model only for occasional idle decisions.
                    if (Date.now() < this.nextRoutineDecision || this.agent.actions?.resume_func) {
                        await new Promise(r => setTimeout(r, 500));
                        continue;
                    }
                    this.nextRoutineDecision = Date.now() + Math.max(15000, Number(settings.autonomy_decision_ms) || 30000);
                }
            }
            let scene = '';
            try {
                scene = world.getSurroundingsSummary(this.agent.bot);
            } catch {
                scene = '';
            }
            const sight = scene ? `\n지금 주변:\n${scene}\n` : '\n';
            const msg = `지금 스스로 다음 행동을 고른다. 목표: '${this.prompt}'.${sight}다음 답에는 명령을 하나만 넣는다. 형식은 !commandName이다. 결과를 본 뒤 다시 물어보니, 멈추지 말고 다음 행동을 한다. 플레이어가 기다리라고 하지 않았다면 !stay(-1)을 쓰지 않는다. 친구에게는 새로 전할 말이 있을 때만, 한 명에게만 말한다. 답은 항상 한국어다. 답:`;
            
            let used_command = await this.agent.handleMessage('system', msg, -1);
            if (this.interrupt || this.state !== ACTIVE) break;
            if (!used_command) {
                // keep the loop alive, but slow down so a silent brain can't spin it
                no_command_count++;
                const steps = Math.min(no_command_count, MAX_BACKOFF_STEPS);
                console.warn(`No command in the last ${no_command_count} auto-prompts. Asking again shortly.`);
                await new Promise(r => setTimeout(r, this._cooldown() * steps));
            }
            else {
                no_command_count = 0;
                await new Promise(r => setTimeout(r, this._cooldown()));
            }
        }
        console.log('self prompt loop stopped')
        this.loop_active = false;
        this.interrupt = false;
    }

    update(delta) {
        // automatically restarts loop
        if (this.state === ACTIVE && !this.loop_active && !this.interrupt) {
            if (this.agent.isIdle())
                this.idle_time += delta;
            else
                this.idle_time = 0;

            if (this.idle_time >= this._cooldown()) {
                console.log('Restarting self-prompting...');
                this.startLoop();
                this.idle_time = 0;
            }
        }
        else {
            this.idle_time = 0;
        }
    }

    async stopLoop() {
        // you can call this without await if you don't need to wait for it to finish
        if (this.interrupt)
            return;
        console.log('stopping self-prompt loop')
        this.interrupt = true;
        while (this.loop_active) {
            await new Promise(r => setTimeout(r, 500));
        }
        this.interrupt = false;
    }

    async stop(stop_action=true) {
        this.interrupt = true;
        if (stop_action)
            await this.agent.actions.stop();
        this.stopLoop();
        this.state = STOPPED;
    }

    async pause() {
        this.interrupt = true;
        await this.agent.actions.stop();
        this.stopLoop();
        this.state = PAUSED;
    }

    _cooldown() {
        const value = Number(settings.self_prompt_cooldown_ms);
        return Number.isFinite(value) && value >= 1000 ? value : 15000;
    }

    shouldInterrupt(is_self_prompt) { // to be called from handleMessage
        return is_self_prompt && (this.state === ACTIVE || this.state === PAUSED) && this.interrupt;
    }

    handleUserPromptedCmd(is_self_prompt, is_action) {
        // if a user messages and the bot responds with an action, stop the self-prompt loop
        if (!is_self_prompt && is_action) {
            this.stopLoop();
            // this stops it from responding from the handlemessage loop and the self-prompt loop at the same time
        }
    }
}
