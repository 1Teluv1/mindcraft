// The scheduler is independent of model providers and game I/O for deterministic tests.
export class HybridController {
    constructor(io, config = {}, now = Date.now) {
        this.io = io;
        this.config = config;
        this.now = now;
        this.goal = null;
        this.busy = false;
        this.nextStep = 0;
        this.suspendedUntil = 0;
        this.pendingEvent = '';
        this.lastPlan = -Infinity;
        this.avoidUntil = new Map();
    }

    enabled() { return this.config.hybrid_autonomy !== false; }

    setGoal(name, quantity, owner = null) {
        if (!/^[a-z0-9_]+$/.test(name) || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 256)
            throw new Error('Item goal requires an item name and a total inventory count from 1 to 256.');
        this.goal = { name, quantity, owner, failures: 0, started: this.now() };
        this.pendingEvent = '';
        this.nextStep = 0;
    }

    cancel() {
        this.goal = null;
        this.io.cancelRoutine?.();
        this.pendingEvent = '';
        this.suspendedUntil = this.now() + 10000;
    }

    pauseForInput() {
        if (this.goal?.routine) this.goal = null;
        this.io.cancelRoutine?.();
        this.suspendedUntil = this.now() + 10000;
    }
    ownsWork() { return this.enabled() && (this.busy || !!this.goal); }

    // Only bounded event-driven replanning, never a model request per work step.
    takeReplan() {
        if (!this.pendingEvent || this.now() - this.lastPlan < 120000) return null;
        const event = this.pendingEvent;
        this.pendingEvent = '';
        this.lastPlan = this.now();
        return event;
    }

    async tick(allowRoutine) {
        if (!this.enabled() || this.busy || this.now() < Math.max(this.nextStep, this.suspendedUntil) || !this.io.canAct()) return;
        this.busy = true;
        let goal;
        try {
            if (!this.goal && allowRoutine && !this.pendingEvent) {
                if (await this.io.routine?.()) return;
                if (this.now() < this.suspendedUntil || !this.io.canAct()) return;
                const candidate = this.io.chooseGoal();
                if (candidate && this.now() >= (this.avoidUntil.get(candidate.name) || 0)) {
                    this.setGoal(candidate.name, candidate.quantity);
                    this.goal.routine = true;
                }
            }
            goal = this.goal;
            if (!goal) return;
            const before = this.io.inventory();
            if ((before[goal.name] || 0) >= goal.quantity) {
                this.goal = null;
                this.io.notify(`Item goal complete: ${goal.name} x${goal.quantity}.`, goal.owner, true, goal);
                return;
            }
            if (this.now() - goal.started >= 600000) {
                this.fail(goal, 'time budget exceeded');
                return;
            }
            await this.io.step(goal.name, goal.quantity - (before[goal.name] || 0));
            // A new player command may replace/cancel a goal while a step awaits I/O.
            if (this.goal !== goal || this.io.interrupted()) return;
            const after = this.io.inventory();
            if ((after[goal.name] || 0) >= goal.quantity) {
                this.goal = null;
                this.io.notify(`Item goal complete: ${goal.name} x${goal.quantity}.`, goal.owner, true, goal);
                return;
            }
            const progressed = Object.keys(after).some(name => (after[name] || 0) > (before[name] || 0));
            goal.failures = progressed ? 0 : goal.failures + 1;
            if (goal.failures >= 3) this.fail(goal, 'three attempts without inventory progress');
        } catch (error) {
            if (goal && this.goal === goal) this.fail(goal, String(error));
        } finally {
            this.busy = false;
            this.nextStep = this.now() + 2000;
        }
    }

    fail(goal, reason) {
        this.goal = null;
        this.avoidUntil.set(goal.name, this.now() + 120000);
        this.pendingEvent = `Item goal blocked: ${goal.name} x${goal.quantity}; ${reason}. Choose a different approach or ask the player. Do not immediately repeat the same goal.`;
        this.io.notify(this.pendingEvent, goal.owner, false, goal);
    }
}
