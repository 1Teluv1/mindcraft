# NPC hybrid autonomy

`hybrid_autonomy: true` (default) moves routine resource selection and multi-step item goals to a local scheduler. Conversation and natural-language interpretation still use the configured model.

- Ask naturally for an item, or use `!obtainItem("stone_axe", 1)`. The quantity is the desired total in inventory, not an additional quantity. Valid range: 1–256.
- The existing item dependency planner gathers prerequisites and crafts/smelts in steps. Intermediate inventory progress keeps the plan running without another model request.
- Three steps without inventory progress or ten minutes on a goal stop that goal. An active self-prompt loop may request an event-driven replan, limited to once per two minutes. The failed resource is cooled down for two minutes.
- Routine life-goal work keeps up to a reserve target of 16 logs and 32 cobblestone when sources are nearby. It stops selecting more resource work when those targets are met or no source is available. Recipe output batches can exceed a target.
- Player input pauses scheduling for ten seconds. Replacement action commands cancel the pending local goal. `!stop` also stops self-prompting. Combat and other existing automatic safety modes remain independent.
- Existing profile NPC goals keep their own controller; routine selection yields to them. An explicit hybrid goal temporarily takes priority.
- Set `hybrid_autonomy: false` to retain the LLM self-prompt workflow. Explicit `!goal` custom prompts and evaluation tasks retain their existing planning behavior.

Current limits: item goals are in-memory and do not resume after a process restart. This uses the existing recipe/resource planner, not a general construction planner. A failed goal is reported to its requester even if self-prompting is stopped; automatic LLM replanning requires an active self-prompt loop. Routine NPC-to-NPC chatter is no longer periodically initiated by the life-goal prompt; reactive conversation remains available.

Validation: `node --test tests/hybrid_controller.test.js tests/self_prompter_hybrid.test.js`. These test scheduler/loop behavior with controlled game I/O. A live Minecraft server and actual resource/crafting run are required to validate in-game behavior and measure real model-call reduction.
