import * as world from '../library/world.js';
import * as mc from '../../utils/mcdata.js';
import { getCommandDocs } from './index.js';
import convoManager from '../conversation.js';
import { checkLevelBlueprint, checkBlueprint } from '../tasks/construction_tasks.js';
import { load } from 'cheerio';

const pad = (str) => {
    return '\n' + str + '\n';
}

// queries are commands that just return strings and don't affect anything in the world
export const queryList = [
    {
        name: "!stats",
        description: "위치, 체력, 배고픔, 시간을 확인한다.", 
        perform: function (agent) {
            let bot = agent.bot;
            let res = '상태';
            let pos = bot.entity.position;
            res += `\n- 위치: x: ${pos.x.toFixed(2)}, y: ${pos.y.toFixed(2)}, z: ${pos.z.toFixed(2)}`;
            res += `\n- 게임 모드: ${bot.game.gameMode}`;
            res += `\n- 체력: ${Math.round(bot.health)} / 20`;
            res += `\n- 배고픔: ${Math.round(bot.food)} / 20`;
            res += `\n- 생물군계: ${world.getBiomeName(bot)}`;
            let weather = "맑음";
            if (bot.rainState > 0)
                weather = "비";
            if (bot.thunderState > 0)
                weather = "뇌우";
            res += `\n- 날씨: ${weather}`;
            // let block = bot.blockAt(pos);
            // res += `\n- Artficial light: ${block.skyLight}`;
            // res += `\n- Sky light: ${block.light}`;
            // light properties are bugged, they are not accurate


            if (bot.time.timeOfDay < 6000) {
                res += '\n- 시간: 아침';
            } else if (bot.time.timeOfDay < 12000) {
                res += '\n- 시간: 오후';
            } else {
                res += '\n- 시간: 밤';
            }

            let action = agent.actions.currentActionLabel;
            if (agent.isIdle())
                action = '대기';
            res += `\n- 현재 행동: ${action}`;


            let players = world.getNearbyPlayerNames(bot);
            let bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
            players = players.filter(p => !bots.includes(p));

            res += '\n- 근처 사람: ' + (players.length > 0 ? players.join(', ') : '없음.');
            res += '\n- 근처 봇: ' + (bots.length > 0 ? bots.join(', ') : '없음.');

            res += '\n' + agent.bot.modes.getMiniDocs() + '\n';
            return pad(res);
        }
    },
    {
        name: "!inventory",
        description: "소지품을 확인한다.",
        perform: function (agent) {
            let bot = agent.bot;
            let inventory = world.getInventoryCounts(bot);
            let res = '소지품';
            for (const item in inventory) {
                if (inventory[item] && inventory[item] > 0)
                    res += `\n- ${item}: ${inventory[item]}`;
            }
            if (res === '소지품') {
                res += ': 없음';
            }
            else if (agent.bot.game.gameMode === 'creative') {
                res += '\n(크리에이티브라 아이템이 무한하다. 재료를 모을 필요가 없다.)';
            }

            let helmet = bot.inventory.slots[5];
            let chestplate = bot.inventory.slots[6];
            let leggings = bot.inventory.slots[7];
            let boots = bot.inventory.slots[8];
            res += '\n착용: ';
            if (helmet)
                res += `\n머리: ${helmet.name}`;
            if (chestplate)
                res += `\n가슴: ${chestplate.name}`;
            if (leggings)
                res += `\n다리: ${leggings.name}`;
            if (boots)
                res += `\n발: ${boots.name}`;
            if (!helmet && !chestplate && !leggings && !boots)
                res += '없음';

            return pad(res);
        }
    },
    {
        name: "!nearbyBlocks",
        description: "근처 블록을 확인한다.",
        perform: function (agent) {
            let bot = agent.bot;
            let res = '근처 블록';
            let blocks = world.getNearestBlocks(bot);
            let block_details = new Set();
            
            for (let block of blocks) {
                let details = block.name;
                if (block.name === 'water' || block.name === 'lava') {
                    details += block.metadata === 0 ? ' (수원)' : ' (흐름)';
                }
                block_details.add(details);
            }
            for (let details of block_details) {
                res += `\n- ${details}`;
            }
            if (block_details.size === 0) {
                res += ': 없음';
            } 
            else {
                res += '\n- ' + world.getSurroundingBlocks(bot).join('\n- ');
                res += `\n- 머리 위 첫 단단한 블록: ${world.getFirstBlockAboveHead(bot, null, 32)}`;
            }
            return pad(res);
        }
    },
    {
        name: "!craftable",
        description: "지금 소지품으로 만들 수 있는 아이템을 확인한다.",
        perform: function (agent) {
            let craftable = world.getCraftableItems(agent.bot);
            let res = '만들 수 있는 것';
            for (const item of craftable) {
                res += `\n- ${item}`;
            }
            if (res == '만들 수 있는 것') {
                res += ': 없음';
            }
            return pad(res);
        }
    },
    {
        name: "!entities",
        description: "근처 플레이어와 생물을 확인한다.",
        perform: function (agent) {
            let bot = agent.bot;
            let res = '근처 생물';
            let players = world.getNearbyPlayerNames(bot);
            let bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
            players = players.filter(p => !bots.includes(p));

            for (const player of players) {
                res += `\n- 사람: ${player}`;
            }
            for (const bot of bots) {
                res += `\n- 봇: ${bot}`;
            }

            let nearbyEntities = world.getNearbyEntities(bot);
            let entityCounts = {};
            let villagerIds = [];
            let babyVillagerIds = [];
            let villagerDetails = []; // Store detailed villager info including profession
            
            for (const entity of nearbyEntities) {
                if (entity.type === 'player' || entity.name === 'item')
                    continue;
                    
                if (!entityCounts[entity.name]) {
                    entityCounts[entity.name] = 0;
                }
                entityCounts[entity.name]++;
                
                if (entity.name === 'villager') {
                    if (entity.metadata && entity.metadata[16] === 1) {
                        babyVillagerIds.push(entity.id);
                    } else {
                        const profession = world.getVillagerProfession(entity);
                        villagerIds.push(entity.id);
                        villagerDetails.push({
                            id: entity.id,
                            profession: profession
                        });
                    }
                }
            }
            
            for (const [entityType, count] of Object.entries(entityCounts)) {
                if (entityType === 'villager') {
                    let villagerInfo = `${count} ${entityType}(s)`;
                    if (villagerDetails.length > 0) {
                        const detailStrings = villagerDetails.map(v => `(${v.id}:${v.profession})`);
                        villagerInfo += ` - 어른: ${detailStrings.join(', ')}`;
                    }
                    if (babyVillagerIds.length > 0) {
                        villagerInfo += ` - 아기 id: ${babyVillagerIds.join(', ')} (아기는 거래할 수 없다)`;
                    }
                    res += `\n- 생물: ${villagerInfo}`;
                } else {
                    res += `\n- 생물: ${entityType} ${count}`;
                }
            }
            
            if (res == '근처 생물') {
                res += ': 없음';
            }
            return pad(res);
        }
    },
    {
        name: "!modes",
        description: "자동 행동 목록과 켜짐 상태를 확인한다.",
        perform: function (agent) {
            return agent.bot.modes.getDocs();
        }
    },
    {
        name: '!savedPlaces',
        description: '기억한 위치 이름을 모두 보여 준다.',
        perform: async function (agent) {
            return "기억한 위치: " + agent.memory_bank.getKeys();
        }
    }, 
    {
        name: '!checkBlueprintLevel',
        description: '그 층이 끝났는지, 청사진에 아직 놓을 블록이 무엇인지 확인한다.',
        params: {
            'levelNum': { type: 'int', description: '확인할 층 번호.', domain: [0, Number.MAX_SAFE_INTEGER] }
        },
        perform: function (agent, levelNum) {
            let res = checkLevelBlueprint(agent, levelNum);
            console.log(res);
            return pad(res);
        }
    }, 
    {
        name: '!checkBlueprint',
        description: '청사진에 아직 놓을 블록을 확인한다.',
        perform: function (agent) {
            let res = checkBlueprint(agent);
            return pad(res);
        }
    }, 
    {
        name: '!getBlueprint',
        description: '건물의 청사진을 가져온다.',
        perform: function (agent) {
            let res = agent.task.blueprint.explain();
            return pad(res);
        }
    }, 
    {
        name: '!getBlueprintLevel',
        description: '건물의 청사진을 가져온다.',
        params: {
            'levelNum': { type: 'int', description: '확인할 층 번호.', domain: [0, Number.MAX_SAFE_INTEGER] }
        },
        perform: function (agent, levelNum) {
            let res = agent.task.blueprint.explainLevel(levelNum);
            console.log(res);
            return pad(res);
        }
    },
    {
        name: '!getCraftingPlan',
        description: "지정한 아이템의 제작 계획을 보여 준다. 필요한 재료와 수량, 소지품에 없는 것을 알려 준다.",
        params: {
            targetItem: { 
                type: 'string', 
                description: '만들 아이템' 
            },
            quantity: { 
                type: 'int',
                description: '만들 수량',
                optional: true,
                domain: [1, Infinity, '[)'], // Quantity must be at least 1,
                default: 1
            }
        },
        perform: function (agent, targetItem, quantity = 1) {
            let bot = agent.bot;

            // Fetch the bot's inventory
            const curr_inventory = world.getInventoryCounts(bot); 
            const target_item = targetItem;
            let existingCount = curr_inventory[target_item] || 0;
            let prefixMessage = '';
            if (existingCount > 0) {
                curr_inventory[target_item] -= existingCount;
                prefixMessage = `소지품에 ${target_item}이 이미 ${existingCount}개 있다. 더 만들려면,\n`;
            }

            // Generate crafting plan
            try {
                let craftingPlan = mc.getDetailedCraftingPlan(target_item, quantity, curr_inventory);
                craftingPlan = prefixMessage + craftingPlan;
                return pad(craftingPlan);
            } catch (error) {
                console.error("Error generating crafting plan:", error);
                return `An error occurred while generating the crafting plan: ${error.message}`;
            }
            
            
        },
    },
    {
        name: '!searchWiki',
        description: '마인크래프트 위키에서 검색한다.',
        params: {
            'query': { type: 'string', description: '검색할 말.' }
        },
        perform: async function (agent, query) {
            const url = `https://minecraft.wiki/w/${query}`
            try {
                const response = await fetch(url);
                if (response.status === 404) {
                  return `${query} was not found on the Minecraft Wiki. Try adjusting your search term.`;
                }
                const html = await response.text();
                const $ = load(html);
            
                const parserOutput = $("div.mw-parser-output");
                
                parserOutput.find("table.navbox").remove();

                const divContent = parserOutput.text();
            
                return divContent.trim();
              } catch (error) {
                console.error("Error fetching or parsing HTML:", error);
                return `The following error occurred: ${error}`
              }
        }
    },
    {
        name: '!help',
        description: '쓸 수 있는 명령과 설명을 모두 보여 준다.',
        perform: async function (agent) {
            return getCommandDocs(agent);
        }
    },
];
