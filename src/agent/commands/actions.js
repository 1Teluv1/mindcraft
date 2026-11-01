import * as skills from '../library/skills.js';
import settings from '../settings.js';
import convoManager from '../conversation.js';

function playerAskedToWait(agent) {
    const turns = agent.history?.turns || [];
    const wait = /\b(wait|stay here|hold still|stand still|stop moving|don'?t move)\b|기다|멈춰|서\s*있|거기\s*있|움직이지/i;
    for (let i = turns.length - 1; i >= 0; i--) {
        const turn = turns[i];
        if (!turn || turn.role !== 'user') continue;
        return wait.test(turn.content || '');
    }
    return false;
}

function runAsAction (actionFn, resume = false, timeout = -1) {
    let actionLabel = null;  // Will be set on first use
    
    const wrappedAction = async function (agent, ...args) {
        // Set actionLabel only once, when the action is first created
        if (!actionLabel) {
            const actionObj = actionsList.find(a => a.perform === wrappedAction);
            actionLabel = actionObj.name.substring(1); // Remove the ! prefix
        }

        const actionFnWithAgent = async () => {
            await actionFn(agent, ...args);
        };
        const code_return = await agent.actions.runAction(`action:${actionLabel}`, actionFnWithAgent, { timeout, resume });
        if (code_return.interrupted && !code_return.timedout)
            return;
        return code_return.message;
    }

    return wrappedAction;
}

export const actionsList = [
    {
        name: '!setRole',
        description: '사용자가 역할을 지정하거나 바꾸라고 했을 때만 사용한다. 캐릭터 능력은 모두 같다. generalist는 자유 생활(역할 해제), gatherer는 채집 우선, crafter는 제작 우선, farmer는 농사 우선이다. 이름으로 역할을 추측하거나 스스로 역할을 지정하지 않는다.',
        params: { role: { type: 'string', description: 'generalist, gatherer, crafter, farmer 중 하나.' } },
        perform: async (agent, role) => {
            if (!agent.settlement?.enabled()) return '공동 생활 시뮬레이션이 꺼져 있어.';
            const result = agent.settlement.assignRole(role);
            if (result.success) {
                await agent.actions.stop();
                agent.self_prompter.start(settings.life_goal);
            }
            return result.message;
        },
    },
    {
        name: '!obtainItem',
        description: '로컬 자원 계획으로 소지품의 최종 수량을 맞춘다. 모으거나 만들라는 부탁은 이 명령을 우선한다. 재료와 재시도는 자동이므로 다음 명령을 붙이지 않는다. 끝나면 자동으로 알려 준다.',
        params: {
            item: { type: 'ItemName', description: '마인크래프트 아이템 ID. 예: stone_axe, oak_log.' },
            quantity: { type: 'int', description: '소지품에 맞춰 둘 최종 수량.', domain: [1, 256] },
        },
        perform: async (agent, item, quantity) => {
            if (!agent.hybrid.enabled()) return 'Hybrid autonomy is disabled.';
            await agent.actions.stop();
            agent.hybrid.setGoal(item, quantity, agent.last_sender);
            return 'Item goal registered. The local planner will execute prerequisites and report completion; do not issue another work command until then.';
        },
    },
    {
        name: '!newAction',
        description: '기존 명령에 없는 새 행동을 수행한다.', 
        params: {
            'prompt': { type: 'string', description: '코드 생성을 이끌 설명. 단계별 계획을 자세히 쓴다.' }
        },
        perform: async function(agent, prompt) {
            // just ignore prompt - it is now in context in chat history
            if (!settings.allow_insecure_coding) { 
                agent.openChat('newAction is disabled. Enable with allow_insecure_coding=true in settings.js');
                return "newAction not allowed! Code writing is disabled in settings. Notify the user.";
            }
            let result = "";
            const actionFn = async () => {
                try {
                    result = await agent.coder.generateCode(agent.history);
                } catch (e) {
                    result = 'Error generating code: ' + e.toString();
                }
            };
            await agent.actions.runAction('action:newAction', actionFn, {timeout: settings.code_timeout_mins});
            return result;
        }
    },
    {
        name: '!stop',
        description: '지금 실행 중인 행동과 명령을 모두 멈춘다.',
        perform: async function (agent) {
            await agent.actions.stop();
            agent.clearBotLogs();
            agent.actions.cancelResume();
            agent.bot.emit('idle');
            agent.self_prompter.stop(false);
            let msg = 'Agent stopped.';
            if (agent.self_prompter.isActive())
                msg += ' Self-prompting still active.';
            return msg;
        }
    },
    {
        name: '!stfu',
        description: '대화와 자기 지시를 멈추고, 지금 행동은 계속한다.',
        perform: async function (agent) {
            agent.openChat('Shutting up.');
            agent.shutUp();
            return;
        }
    },
    {
        name: '!restart',
        description: '에이전트 프로세스를 다시 시작한다.',
        perform: async function (agent) {
            agent.cleanKill();
        }
    },
    {
        name: '!clearChat',
        description: '대화 기록을 지운다.',
        perform: async function (agent) {
            agent.history.clear();
            return agent.name + "'s chat history was cleared, starting new conversation from scratch.";
        }
    },
    {
        name: '!goToPlayer',
        description: '지정한 플레이어에게 간다.',
        params: {
            'player_name': {type: 'string', description: '찾아갈 플레이어 이름.'},
            'closeness': {type: 'float', description: '플레이어에게 얼마나 가까이 갈지.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, closeness) => {
            await skills.goToPlayer(agent.bot, player_name, closeness);
        })
    },
    {
        name: '!followPlayer',
        description: '지정한 플레이어를 계속 따라간다.',
        params: {
            'player_name': {type: 'string', description: '따라갈 플레이어 이름.'},
            'follow_dist': {type: 'float', description: '따라갈 거리.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, follow_dist) => {
            await skills.followPlayer(agent.bot, player_name, follow_dist);
        }, true)
    },
    {
        name: '!goToCoordinates',
        description: '지정한 x, y, z 좌표로 간다.',
        params: {
            'x': {type: 'float', description: 'x 좌표.', domain: [-Infinity, Infinity]},
            'y': {type: 'float', description: 'y 좌표.', domain: [-64, 320]},
            'z': {type: 'float', description: 'z 좌표.', domain: [-Infinity, Infinity]},
            'closeness': {type: 'float', description: '좌표에 얼마나 가까이 갈지.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, x, y, z, closeness) => {
            await skills.goToPosition(agent.bot, x, y, z, closeness);
        })
    },
    {
        name: '!searchForBlock',
        description: '범위 안에서 가장 가까운 해당 블록을 찾아 간다.',
        params: {
            'type': { type: 'BlockName', description: '찾아갈 블록 종류.' },
            'search_range': { type: 'float', description: '블록을 찾을 범위. 최소 32.', domain: [10, 512] }
        },
        perform: runAsAction(async (agent, block_type, range) => {
            if (range < 32) {
                skills.log(agent.bot, `Minimum search range is 32.`);
                range = 32;
            }
            await skills.goToNearestBlock(agent.bot, block_type, 4, range);
        })
    },
    {
        name: '!searchForEntity',
        description: '생물을 찾아 다가간다. 보이지 않으면 시작 지점에서 48칸까지 넓히며 정찰하고, 실패하면 돌아온다. 방해받거나 체력·배고픔이 낮으면 정찰을 멈춘다. 검색 범위는 이미 알려진 생물에만 적용된다.',
        params: {
            'type': { type: 'string', description: '찾아갈 생물 종류.' },
            'search_range': { type: 'float', description: '생물을 찾을 범위.', domain: [32, 512] }
        },
        perform: runAsAction(async (agent, entity_type, range) => {
            await skills.goToNearestEntity(agent.bot, entity_type, 4, range);
        })
    },
    {
        name: '!moveAway',
        description: '지금 위치에서 지정한 거리만큼 아무 방향으로 벗어난다.',
        params: {'distance': { type: 'float', description: '벗어날 거리.', domain: [0, Infinity] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.moveAway(agent.bot, distance);
        })
    },
    {
        name: '!rememberHere',
        description: '지금 위치를 이름으로 기억한다.',
        params: {'name': { type: 'string', description: '위치를 기억할 이름.' }},
        perform: async function (agent, name) {
            const pos = agent.bot.entity.position;
            agent.memory_bank.rememberPlace(name, pos.x, pos.y, pos.z);
            return `Location saved as "${name}".`;
        }
    },
    {
        name: '!goToRememberedPlace',
        description: '기억한 위치로 간다.',
        params: {'name': { type: 'string', description: '찾아갈 위치 이름.' }},
        perform: runAsAction(async (agent, name) => {
            const pos = agent.memory_bank.recallPlace(name);
            if (!pos) {
            skills.log(agent.bot, `No location named "${name}" saved.`);
            return;
            }
            await skills.goToPosition(agent.bot, pos[0], pos[1], pos[2], 1);
        })
    },
    {
        name: '!givePlayer',
        description: '지정한 아이템을 그 플레이어에게 준다.',
        params: { 
            'player_name': { type: 'string', description: '아이템을 받을 플레이어 이름.' }, 
            'item_name': { type: 'ItemName', description: '줄 아이템 이름.' },
            'num': { type: 'int', description: '줄 개수.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, player_name, item_name, num) => {
            await skills.giveToPlayer(agent.bot, item_name, player_name, num);
        })
    },
    {
        name: '!consume',
        description: '지정한 아이템을 먹거나 마신다.',
        params: {'item_name': { type: 'ItemName', description: '먹거나 마실 아이템 이름.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.consume(agent.bot, item_name);
        })
    },
    {
        name: '!equip',
        description: '지정한 아이템을 장착한다.',
        params: {'item_name': { type: 'ItemName', description: '장착할 아이템 이름.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.equip(agent.bot, item_name);
        })
    },
    {
        name: '!putInChest',
        description: '지정한 아이템을 가장 가까운 상자에 넣는다.',
        params: {
            'item_name': { type: 'ItemName', description: '상자에 넣을 아이템 이름.' },
            'num': { type: 'int', description: '넣을 개수.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.putInChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!takeFromChest',
        description: '가장 가까운 상자에서 지정한 아이템을 꺼낸다.',
        params: {
            'item_name': { type: 'ItemName', description: '꺼낼 아이템 이름.' },
            'num': { type: 'int', description: '꺼낼 개수.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.takeFromChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!viewChest',
        description: '가장 가까운 상자의 내용과 개수를 본다.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.viewChest(agent.bot);
        })
    },
    {
        name: '!discard',
        description: '소지품에서 지정한 아이템을 버린다.',
        params: {
            'item_name': { type: 'ItemName', description: '버릴 아이템 이름.' },
            'num': { type: 'int', description: '버릴 개수.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            const start_loc = agent.bot.entity.position;
            await skills.moveAway(agent.bot, 5);
            await skills.discard(agent.bot, item_name, num);
            await skills.goToPosition(agent.bot, start_loc.x, start_loc.y, start_loc.z, 0);
        })
    },
    {
        name: '!collectBlocks',
        description: '가장 가까운 해당 블록을 캔다.',
        params: {
            'type': { type: 'BlockName', description: '캘 블록 종류.' },
            'num': { type: 'int', description: '캘 개수.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, type, num) => {
            await skills.collectBlock(agent.bot, type, num);
        }, false, 10) // 10 minute timeout
    },
    {
        name: '!farm',
        description: '근처 잔디나 흙을 괭이로 갈고 씨앗을 심는다. 괭이가 필요하고, 갈기만 할 때가 아니면 씨앗도 필요하다.',
        params: {
            'seed_type': { type: 'string', description: '심을 씨앗이나 작물. wheat_seeds, beetroot_seeds, pumpkin_seeds, melon_seeds, carrot, potato, nether_wart. 갈기만 하면 "none".' },
            'num': { type: 'int', description: '갈고 심을 칸 수.', domain: [1, 64] }
        },
        perform: runAsAction(async (agent, seed_type, num) => {
            await skills.farmNearby(agent.bot, seed_type, num);
        }, false, 10)
    },
    {
        name: '!craftRecipe',
        description: '지정한 제작법을 지정한 횟수만큼 만든다.',
        params: {
            'recipe_name': { type: 'ItemName', description: '만들 결과 아이템 이름.' },
            'num': { type: 'int', description: '제작 횟수. 결과 아이템 개수가 아니다. 제작법에 따라 더 많이 나올 수 있다.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, recipe_name, num) => {
            await skills.craftRecipe(agent.bot, recipe_name, num);
        })
    },
    {
        name: '!smeltItem',
        description: '지정한 아이템을 지정한 횟수만큼 제련한다.',
        params: {
            'item_name': { type: 'ItemName', description: '제련할 재료 이름.' },
            'num': { type: 'int', description: '제련 횟수.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            let success = await skills.smeltItem(agent.bot, item_name, num);
            if (success) {
                setTimeout(() => {
                    agent.cleanKill('Safely restarting to update inventory.');
                }, 500);
            }
        })
    },
    {
        name: '!clearFurnace',
        description: '가장 가까운 화로 안의 아이템을 모두 꺼낸다.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.clearNearestFurnace(agent.bot);
        })
    },
        {
        name: '!placeHere',
        description: '지금 위치에 블록 하나를 놓는다. 건물을 짓는 용도가 아니라 블록이나 횃불 하나에만 쓴다.',
        params: {'type': { type: 'BlockOrItemName', description: '놓을 블록 종류.' }},
        perform: runAsAction(async (agent, type) => {
            let pos = agent.bot.entity.position;
            await skills.placeBlock(agent.bot, type, pos.x, pos.y, pos.z);
        })
    },
    {
        name: '!attack',
        description: '가장 가까운 해당 생물을 공격해 쓰러뜨린다.',
        params: {'type': { type: 'string', description: '공격할 생물 종류.'}},
        perform: runAsAction(async (agent, type) => {
            await skills.attackNearest(agent.bot, type, true);
        })
    },
    {
        name: '!attackPlayer',
        description: '지정한 플레이어가 죽거나 도망갈 때까지 공격한다. 게임 안의 행동이다.',
        params: {'player_name': { type: 'string', description: '공격할 플레이어 이름.'}},
        perform: runAsAction(async (agent, player_name) => {
            let player = agent.bot.players[player_name]?.entity;
            if (!player) {
                skills.log(agent.bot, `Could not find player ${player_name}.`);
                return false;
            }
            await skills.attackEntity(agent.bot, player, true);
        })
    },
    {
        name: '!goToBed',
        description: '주변 32블록에서 빈 침대를 찾아 잔다. 사용 중인 침대는 건너뛰고 다른 침대를 자동으로 시도한다. 다른 침대를 찾을 때도 이 명령을 사용한다. newAction은 필요 없다.',
        perform: runAsAction(async (agent) => {
            await skills.goToBed(agent.bot);
        })
    },
    {
        name: '!stay',
        description: '지금 위치에서 몇 초 기다린다. 자동 행동을 잠시 멈춘다. -1은 영원히 기다려 다음 행동을 막으므로, 플레이어가 기다리라고 했을 때만 쓴다.',
        params: {'type': { type: 'int', description: '기다릴 초. 플레이어가 기다리라고 했을 때만 -1.', domain: [-1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, seconds) => {
            if (seconds < 0 && !playerAskedToWait(agent)) {
                skills.log(agent.bot, 'Refusing to stay forever. The player did not ask you to wait. Choose the next action.');
                return;
            }
            await skills.stay(agent.bot, seconds);
        })
    },
    {
        name: '!setMode',
        description: '자동 행동을 켜거나 끈다. 자동 행동은 주변을 계속 살펴 반응한다.',
        params: {
            'mode_name': { type: 'string', description: '켜거나 끌 자동 행동 이름.' },
            'on': { type: 'boolean', description: '켜려면 true, 끄려면 false.' }
        },
        perform: async function (agent, mode_name, on) {
            const modes = agent.bot.modes;
            if (!modes.exists(mode_name))
            return `Mode ${mode_name} does not exist.` + modes.getDocs();
            if (modes.isOn(mode_name) === on)
            return `Mode ${mode_name} is already ${on ? 'on' : 'off'}.`;
            modes.setOn(mode_name, on);
            return `Mode ${mode_name} is now ${on ? 'on' : 'off'}.`;
        }
    },
    {
        name: '!goal',
        description: '계속 스스로 수행할 목표를 정한다.',
        params: {
            'selfPrompt': { type: 'string', description: '목표 문장.' },
        },
        perform: async function (agent, prompt) {
            if (convoManager.inConversation()) {
                agent.self_prompter.setPromptPaused(prompt);
            }
            else {
                agent.self_prompter.start(prompt);
            }
        }
    },
    {
        name: '!endGoal',
        description: '목표를 끝내면 호출한다. 자기 지시와 지금 행동을 멈춘다.',
        perform: async function (agent) {
            agent.self_prompter.stop();
            return 'Self-prompting stopped.';
        }
    },
    {
        name: '!showVillagerTrades',
        description: '지정한 주민의 거래를 본다.',
        params: {'id': { type: 'int', description: '거래할 주민의 id.' }},
        perform: runAsAction(async (agent, id) => {
            await skills.showVillagerTrades(agent.bot, id);
        })
    },
    {
        name: '!tradeWithVillager',
        description: '지정한 주민과 거래한다.',
        params: {
            'id': { type: 'int', description: '거래할 주민의 id.' },
            'index': { type: 'int', description: '실행할 거래 번호. 1부터 센다.', domain: [1, Number.MAX_SAFE_INTEGER] },
            'count': { type: 'int', description: '그 거래를 반복할 횟수.', domain: [1, Number.MAX_SAFE_INTEGER] },
        },
        perform: runAsAction(async (agent, id, index, count) => {
            await skills.tradeWithVillager(agent.bot, id, index, count);
        })
    },
    {
        name: '!startConversation',
        description: '다른 봇과 대화를 시작한다. 봇에게만 쓴다.',
        params: {
            'player_name': { type: 'string', description: '말을 받을 봇 이름.' },
            'message': { type: 'string', description: '보낼 말. 한국어로 쓴다.' },
        },
        perform: async function (agent, player_name, message) {
            if (!convoManager.isOtherAgent(player_name))
                return player_name + ' is not a bot, cannot start conversation.';
            if (convoManager.inConversation() && !convoManager.inConversation(player_name)) 
                convoManager.forceEndCurrentConversation();
            else if (convoManager.inConversation(player_name))
                agent.history.add('system', player_name + '와 이미 대화 중이다. 그 친구에게 말하려고 이 명령을 다시 쓰지 마라.');
            convoManager.startConversation(player_name, message);
        }
    },
    {
        name: '!endConversation',
        description: '그 봇과의 대화를 끝낸다. 봇에게만 쓴다.',
        params: {
            'player_name': { type: 'string', description: '대화를 끝낼 봇 이름.' }
        },
        perform: async function (agent, player_name) {
            if (!convoManager.inConversation(player_name))
                return `Not in conversation with ${player_name}.`;
            convoManager.endConversation(player_name);
            return `Converstaion with ${player_name} ended.`;
        }
    },
    {
        name: '!lookAtPlayer',
        description: '플레이어를 보거나, 그 플레이어와 같은 방향을 본다.',
        params: {
            'player_name': { type: 'string', description: '볼 플레이어 이름.' },
            'direction': {
                type: 'string',
                description: '보는 방법. "at"은 플레이어를 보고, "with"는 같은 방향을 본다.',
            }
        },
        perform: async function(agent, player_name, direction) {
            if (direction !== 'at' && direction !== 'with') {
                return "Invalid direction. Use 'at' or 'with'.";
            }
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPlayer(player_name, direction);
            };
            await agent.actions.runAction('action:lookAtPlayer', actionFn);
            return result;
        }
    },
    {
        name: '!lookAtPosition',
        description: '지정한 좌표를 본다.',
        params: {
            'x': { type: 'int', description: 'x 좌표' },
            'y': { type: 'int', description: 'y 좌표' },
            'z': { type: 'int', description: 'z 좌표' }
        },
        perform: async function(agent, x, y, z) {
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPosition(x, y, z);
            };
            await agent.actions.runAction('action:lookAtPosition', actionFn);
            return result;
        }
    },
    {
        name: '!digDown',
        description: '지정한 깊이만큼 아래로 판다. 용암, 물, 또는 아래가 4칸 이상 비면 멈춘다.',
        params: {'distance': { type: 'int', description: '아래로 팔 거리', domain: [1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.digDown(agent.bot, distance)
        })
    },
    {
        name: '!goToSurface',
        description: '머리 위 가장 높은 블록, 보통 지상으로 올라간다.',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.goToSurface(agent.bot);
        })
    },
    {
        name: '!useOn',
        description: '지정한 도구로 가장 가까운 대상을 우클릭한다.',
        params: {
            'tool_name': { type: 'string', description: '쓸 도구 이름. 맨손이면 "hand".' },
            'target': { type: 'string', description: '대상의 생물 종류, 블록 종류, 또는 대상이 없으면 "nothing".' }
        },
        perform: runAsAction(async (agent, tool_name, target) => {
            await skills.useToolOn(agent.bot, tool_name, target);
        })
    },
];
