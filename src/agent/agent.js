import { readFileSync } from 'fs';
import { History } from './history.js';
import { Coder } from './coder.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import { initBot } from '../utils/mcdata.js';
import { containsCommand, commandExists, executeCommand, truncCommandMessage, isAction, blacklistCommands } from './commands/index.js';
import { ActionManager } from './action_manager.js';
import { NPCContoller } from './npc/controller.js';
import { createHybridController } from './npc/hybrid_runtime.js';
import { PlayerTether } from './npc/player_tether.js';
import { MemoryBank } from './memory_bank.js';
import { SelfPrompter } from './self_prompter.js';
import convoManager from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
import { addBrowserViewer } from './vision/browser_viewer.js';
import { serverProxy, sendOutputToServer } from './mindserver_proxy.js';
import settings from './settings.js';
import { Task } from './tasks/tasks.js';
import { speak } from './speak.js';
import { log, validateNameFormat, handleDisconnection } from './connection_handler.js';
import { bindSummarizer, note, scheduleCompress } from './shared_context.js';

const NAME_ALIASES = {
    chatgpt: ['chatgpt', '챗지피티', '챗gpt', '지피티', 'gpt'],
    claude: ['claude', '클로드'],
    cursor: ['cursor', '커서'],
};

let cachedBotNames = null;

function knownBotNames() {
    if (cachedBotNames) return cachedBotNames;
    const names = [];
    for (const profilePath of settings.profiles || []) {
        try {
            const profile = JSON.parse(readFileSync(profilePath, 'utf8'));
            if (profile.name) names.push(profile.name);
        } catch {
            // A missing profile should not block chat.
        }
    }
    cachedBotNames = names;
    return names;
}

function mentionedBotNames(text) {
    const lower = String(text || '').toLowerCase();
    return knownBotNames().filter(name => {
        const keys = NAME_ALIASES[name.toLowerCase()] || [name.toLowerCase()];
        return keys.some(key => lower.includes(key));
    });
}

export class Agent {
    async start(load_mem=false, init_message=null, count_id=0) {
        this.last_sender = null;
        this.count_id = count_id;
        this._disconnectHandled = false;

        // Initialize components
        this.actions = new ActionManager(this);
        this.prompter = new Prompter(this, settings.profile);
        this.name = (this.prompter.getName() || '').trim();
        bindSummarizer((turns, memory) => this.prompter.promptMemSaving(turns, memory));
        console.log(`Initializing agent ${this.name}...`);
        
        // Validate Name Format
        // connection_handler now ensures the message has [LoginGuard] prefix
        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            process.exit(1);
            return;
        }
        
        this.history = new History(this);
        this.coder = new Coder(this);
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank();
        this.self_prompter = new SelfPrompter(this);
        this.hybrid = createHybridController(this);
        convoManager.initAgent(this);
        await this.prompter.initExamples();

        // load mem first before doing task
        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
        }
        let taskStart = null;
        if (save_data) {
            taskStart = save_data.taskStart;
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, settings.task, taskStart);
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions || []);
        blacklistCommands(this.blocked_actions);

        console.log(this.name, 'logging into minecraft...');
        this.bot = initBot(this.name);
        
        // Connection Handler
        const onDisconnect = (event, reason) => {
            if (this._disconnectHandled) return;
            this._disconnectHandled = true;

            // Log and Analyze
            // handleDisconnection handles logging to console and server
            const { type } = handleDisconnection(this.name, reason);
     
            process.exit(1);
        };
        
        // Bind events
        this.bot.once('kicked', (reason) => onDisconnect('Kicked', reason));
        this.bot.once('end', (reason) => onDisconnect('Disconnected', reason));
        this.bot.on('error', (err) => {
            if (String(err).includes('Duplicate') || String(err).includes('ECONNREFUSED')) {
                 onDisconnect('Error', err);
            } else {
                 log(this.name, `[LoginGuard] Connection Error: ${String(err)}`);
            }
        });

        initModes(this);

        this.bot.on('login', () => {
            console.log(this.name, 'logged in!');
            serverProxy.login();
            
            // Set skin for profile, requires Fabric Tailor. (https://modrinth.com/mod/fabrictailor)
            if (this.prompter.profile.skin)
                this.bot.chat(`/skin set URL ${this.prompter.profile.skin.model} ${this.prompter.profile.skin.path}`);
            else
                this.bot.chat(`/skin clear`);
        });
		const spawnTimeoutDuration = settings.spawn_timeout;
        const spawnTimeout = setTimeout(() => {
            const msg = `Bot has not spawned after ${spawnTimeoutDuration} seconds. Exiting.`;
            log(this.name, msg);
            process.exit(1);
        }, spawnTimeoutDuration * 1000);
        this.bot.once('spawn', async () => {
            try {
                clearTimeout(spawnTimeout);
                addBrowserViewer(this.bot, count_id);
                console.log('Initializing vision intepreter...');
                this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);

                // wait for a bit so stats are not undefined
                await new Promise((resolve) => setTimeout(resolve, 1000));
                
                console.log(`${this.name} spawned.`);
                this.clearBotLogs();
              
                this._setupEventHandlers(save_data, init_message);
                this.startEvents();
              
                if (!load_mem) {
                    if (settings.task) {
                        this.task.initBotTask();
                        this.task.setAgentGoal();
                    }
                } else {
                    // set the goal without initializing the rest of the task
                    if (settings.task) {
                        this.task.setAgentGoal();
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 10000));
                this.checkAllPlayersPresent();

            } catch (error) {
                console.error('Error in spawn event:', error);
                process.exit(0);
            }
        });
    }

    async _setupEventHandlers(save_data, init_message) {
        const ignore_messages = [
            "Set own game mode to",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];
        
        const respondFunc = async (username, message) => {
            if (message === "") return;
            if (username === this.name) return;
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(username)) return;
            try {
                if (ignore_messages.some((m) => message.startsWith(m))) return;

                if (convoManager.isOtherAgent(username)) {
                    console.warn('received whisper from other bot??')
                    return;
                }

                note(username, message);
                const translation = await handleEnglishTranslation(message);
                const mentioned = mentionedBotNames(`${message}\n${translation}`);
                const addressedToMe = mentioned.some(name => name.toLowerCase() === this.name.toLowerCase());
                if (mentioned.length > 0 && !addressedToMe) {
                    scheduleCompress();
                    return;
                }

                this.shut_up = false;

                console.log(this.name, 'received message from', username, ':', message);
                this.handleMessage(username, translation);
            } catch (error) {
                console.error('Error handling message:', error);
            }
        }

		this.respondFunc = respondFunc;

        this.bot.on('whisper', respondFunc);
        
        this.bot.on('chat', (username, message) => {
            if (convoManager.isOtherAgent(username)) return;
            respondFunc(username, message);
        });

        // Set up auto-eat
        this.bot.autoEat.options = {
            priority: 'foodPoints',
            startAt: 14,
            bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]
        };

        this.deferCombat = true;
        try {
            if (init_message) {
                await this.handleMessage('system', init_message, 1);
            } else {
                this.openChat(`${this.name}야, 안녕. 같이 뭐 할까?`);
            }
        } finally {
            if (this.deferCombat)
                this.openChat(`${this.name}야, 안녕. 같이 뭐 할까?`);
            this.deferCombat = false;
        }
        if (save_data?.self_prompt) {
            await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state);
        }
        if (save_data?.last_sender) {
            this.last_sender = save_data.last_sender;
            if (convoManager.otherAgentInGame(this.last_sender)) {
                const msg_package = {
                    message: `다시 시작됐다. 이 메시지는 자동으로 만들어졌다. 나와 대화를 이어가라.`,
                    start: true
                };
                convoManager.receiveFromBot(this.last_sender, msg_package);
            }
        }
        this._startLifeGoal();
    }

    _startLifeGoal() {
        if (!settings.life_goal || settings.task) return;
        // Migrate saved default routines once; keep custom goals and newly paused routines.
        const oldRoutine = this.self_prompter.prompt !== settings.life_goal &&
            /^(Stay near the player and keep working\.|플레이어 곁에서 계속 일한다\.)/.test(this.self_prompter.prompt || '');
        if (settings.settlement_simulation && oldRoutine) {
            this.self_prompter.start(settings.life_goal);
            return;
        }
        if (!this.self_prompter.isStopped()) return;
        this.self_prompter.start(settings.life_goal);
    }

    checkAllPlayersPresent() {
        if (!this.task || !this.task.agent_names) {
          return;
        }

        const missingPlayers = this.task.agent_names.filter(name => !this.bot.players[name]);
        if (missingPlayers.length > 0) {
            console.log(`Missing players/bots: ${missingPlayers.join(', ')}`);
            this.cleanKill('Not all required players/bots are present in the world. Exiting.', 4);
        }
    }

    requestInterrupt() {
        this.bot.interrupt_code = true;
        this.bot.stopDigging();
        this.bot.collectBlock.cancelTask();
        this.bot.pathfinder.stop();
        this.bot.pvp.stop();
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    shutUp() {
        this.shut_up = true;
        if (this.self_prompter.isActive()) {
            this.self_prompter.stop(false);
        }
        convoManager.endAllConversations();
    }

    noteOwnDeath(cause) {
        if (cause) this._lastDeathCause = cause;
        const pos = this.bot.entity?.position;
        if (pos && !this._deathPosSaved) {
            this.memory_bank.rememberPlace('last_death_position', pos.x, pos.y, pos.z);
            this._deathPosSaved = true;
        }
        if (this._deathReactTimer) return;
        this.actions.cancelResume();
        this.actions.stop();
        this._deathReactTimer = setTimeout(() => {
            this._deathReactTimer = null;
            this._deathPosSaved = false;
            const why = String(this._lastDeathCause || '').replace(/\s+/g, ' ').trim();
            this._lastDeathCause = '';
            const detail = why ? ` 게임이 알린 원인: "${why}".` : '';
            this._speakPublic = true;
            this.handleMessage('system', `방금 죽었다.${detail} 아이템은 죽은 자리 바닥에 떨어졌고 소지품에 없다. 근처 모두에게 친구처럼 짧은 한국어 한 문장만 말한다. 무엇이 죽였는지 일상적인 말로 말한다. 리스폰했다고 하지 말고, 소지품을 확인하겠다고 하지 말고, 친구 한 명에게만 말하지 않는다. 그 다음 명령은 !goToRememberedPlace("last_death_position") 하나만 쓴다.`, 1, true)
                .finally(() => { this._speakPublic = false; });
        }, 500);
    }

    async handleMessage(source, message, max_responses=null, priority=false) {
        await this.checkTaskDone();
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }

        let used_command = false;
        const chainCap = Math.max(1, Number(settings.action_chain_limit) || 6);
        const configured = settings.max_commands === -1 ? chainCap : Number(settings.max_commands);
        if (max_responses === null || max_responses === -1 || !Number.isFinite(max_responses)) {
            max_responses = configured;
        }
        if (max_responses > chainCap) {
            max_responses = chainCap;
        }

        const self_prompt = source === 'system' || source === this.name;
        const from_other_bot = convoManager.isOtherAgent(source);

        if (!self_prompt && !from_other_bot) { // from user, check for forced commands
            this.hybrid.pauseForInput();
            this.last_sender = source;
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                if (!commandExists(user_command_name)) {
                    this.routeResponse(source, `Command '${user_command_name}' does not exist.`);
                    scheduleCompress();
                    return false;
                }
                if (settings.show_command_syntax !== "none")
                    this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
                if (user_command_name === '!newAction') {
                    // all user-initiated commands are ignored by the bot except for this one
                    // add the preceding message to the history to give context for newAction
                    this.history.add(source, message);
                }
                let execute_res = await executeCommand(this, message);
                if (execute_res) 
                    this.routeResponse(source, execute_res);
                scheduleCompress();
                return true;
            }
        }

        if (from_other_bot)
            this.last_sender = source;

        // Now translate the message
        message = await handleEnglishTranslation(message);
        console.log('received message from', source, ':', message);

        const checkInterrupt = () => !priority && (this.self_prompter.shouldInterrupt(self_prompt) || this.shut_up || convoManager.responseScheduledFor(source));
        
        let behavior_log = this.bot.modes.flushBehaviorLog().trim();
        if (behavior_log.length > 0) {
            const MAX_LOG = 500;
            if (behavior_log.length > MAX_LOG) {
                behavior_log = '...' + behavior_log.substring(behavior_log.length - MAX_LOG);
            }
            behavior_log = 'Recent behaviors log: \n' + behavior_log;
            await this.history.add('system', behavior_log);
        }

        // Handle other user messages
        await this.history.add(source, message);
        this.history.save();

        for (let i=0; i<max_responses; i++) {
            if (checkInterrupt()) break;
            let history = this.history.getHistory();
            const fromPlayer = !self_prompt && !from_other_bot;
            let res = await this.prompter.promptConvo(history, priority || fromPlayer);

            console.log(`${this.name} full response to ${source}: ""${res}""`);

            if (res.trim().length === 0) {
                console.warn('no response')
                break; // empty response ends loop
            }

            if (this._speakPublic) {
                const spoken = res.replace(/![A-Za-z]+\([^)]*\)|![A-Za-z]+/g, '').replace(/\s+/g, ' ').trim();
                res = `${spoken} !goToRememberedPlace("last_death_position")`.trim();
            }

            let command_name = containsCommand(res);

            if (command_name) { // contains query or command
                res = truncCommandMessage(res); // everything after the command is ignored
                this.history.add(this.name, res);
                
                if (!commandExists(command_name)) {
                    this.history.add('system', `Command ${command_name} does not exist.`);
                    console.warn('Agent hallucinated command:', command_name)
                    continue;
                }

                if (checkInterrupt()) break;
                if (command_name === '!setRole' && !fromPlayer) {
                    this.history.add('system', 'Only the human player can assign roles. Continue your current role.');
                    break;
                }
                this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(command_name));

                if (settings.show_command_syntax === "full") {
                    this.routeResponse(source, res);
                }
                else if (settings.show_command_syntax === "shortened") {
                    // show only "used !commandname"
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    let chat_message = `*used ${command_name.substring(1)}*`;
                    if (pre_message.length > 0)
                        chat_message = `${pre_message}  ${chat_message}`;
                    this.routeResponse(source, chat_message);
                }
                else {
                    // no command at all
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    if (pre_message.trim().length > 0)
                        await this.routeResponse(source, pre_message);
                }

                let execute_res = await executeCommand(this, res);

                console.log('Agent executed:', command_name, 'and got:', execute_res);
                used_command = true;

                if (execute_res == null || (command_name === '!obtainItem' && this.hybrid.ownsWork()))
                    break;
                if (String(execute_res).trim().length === 0)
                    execute_res = 'Action finished. Choose the next command, or reply without a command if this request is done.';
                this.history.add('system', execute_res);
                // A successful equipment change completes this response. Re-prompting here
                // produces a second acknowledgement and can immediately switch tools to mine.
                if (command_name === '!equip' && /(?:^|\n)Equipped [a-z0-9_]+\./.test(String(execute_res))) {
                    this.history.save();
                    break;
                }
            }
            else { // conversation response
                this.history.add(this.name, res);
                await this.routeResponse(source, res);
                break;
            }
            
            this.history.save();
        }

        scheduleCompress();
        return used_command;
    }

    async routeResponse(to_player, message) {
        if (this.shut_up) return;
        let self_prompt = to_player === 'system' || to_player === this.name;
        if (self_prompt && this.last_sender && !this._speakPublic) {
            // this is for when the agent is prompted by system while still in conversation
            // so it can respond to events like death but be routed back to the last sender
            to_player = this.last_sender;
        }

        if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
            // if we're in an ongoing conversation with the other bot, send the response to it
            await convoManager.sendToBot(to_player, message);
        }
        else {
            // otherwise, use open chat
            await this.openChat(message);
            // note that to_player could be another bot, but if we get here the conversation has ended
        }
    }

    async openChat(message, record = true) {
        let to_translate = message;
        let remaining = '';
        let command_name = containsCommand(message);
        let translate_up_to = command_name ? message.indexOf(command_name) : -1;
        if (translate_up_to != -1) { // don't translate the command
            to_translate = to_translate.substring(0, translate_up_to);
            remaining = message.substring(translate_up_to);
        }
        const spoken = (await handleTranslation(to_translate)).trim();
        if (record)
            note(this.name, spoken || message);
        message = remaining ? `${spoken} ${remaining}`.trim() : spoken;
        // newlines are interpreted as separate chats, which triggers spam filters. replace them with spaces
        message = message.replaceAll('\n', ' ');

        if (settings.only_chat_with.length > 0) {
            for (let username of settings.only_chat_with) {
                this.bot.whisper(username, message);
            }
            if (record && spoken)
                this.deferCombat = false;
        }
        else {
            if (settings.speak && spoken) {
                speak(spoken, this.prompter.profile.speak_model);
            }
            if (settings.chat_ingame) {this.bot.chat(message);}
            if (record && spoken)
                this.deferCombat = false;
            sendOutputToServer(this.name, message);
        }
    }

    startEvents() {
        // Custom events
        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0)
            this.bot.emit('sunrise');
            else if (this.bot.time.timeOfDay == 6000)
            this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000)
            this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000)
            this.bot.emit('midnight');
        });

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
            }
            prev_health = this.bot.health;
        });
        // Logging callbacks
        this.bot.on('error' , (err) => {
            console.error('Error event!', err);
        });
        // Use connection handler for runtime disconnects
        this.bot.on('end', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('death', () => {
            try {
                this.noteOwnDeath('');
            } catch (err) {
                console.error('Death reaction failed', err);
            }
        });
        this.bot.on('kicked', (reason) => {
            if (!this._disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('messagestr', (message, _, jsonMsg) => {
            if (!jsonMsg?.translate?.startsWith('death') || !message.includes(this.name)) return;
            console.log('Agent died: ', message);
            try {
                this.noteOwnDeath(message);
            } catch (err) {
                console.error('Death reaction failed', err);
            }
        });
        this.bot.on('idle', () => {
            this.bot.clearControlStates();
            this.bot.pathfinder.stop(); // clear any lingering pathfinder
            this.bot.modes.unPauseAll();
            setTimeout(() => {
                if (this.isIdle()) {
                    this.actions.resumeAction();
                }
            }, 1000);
        });

        // Init NPC controller
        this.npc.init();

        // This update loop ensures that each update() is called one at a time, even if it takes longer than the interval
        const INTERVAL = 300;
        let last = Date.now();
        setTimeout(async () => {
            while (true) {
                let start = Date.now();
                await this.update(start - last);
                let remaining = INTERVAL - (Date.now() - start);
                if (remaining > 0) {
                    await new Promise((resolve) => setTimeout(resolve, remaining));
                }
                last = start;
            }
        }, INTERVAL);

        this.bot.emit('idle');
    }

    async update(delta) {
        this.playerTether ??= new PlayerTether();
        this.playerTether.update(this, settings, name => convoManager.isOtherAgent(name) || knownBotNames().includes(name));
        const routine = this.self_prompter.isActive() && this.self_prompter.prompt === settings.life_goal && !settings.task;
        try {
            this.settlement?.refresh(routine && !this.hybrid.goal?.owner && Date.now() >= this.hybrid.suspendedUntil);
        } catch (error) { console.error('Settlement observations unavailable:', error.message); }
        await this.bot.modes.update();
        this.self_prompter.update(delta);
        // Do not block emergency modes while a goal step is running.
        void this.hybrid.tick(this.self_prompter.isActive() && this.self_prompter.prompt === settings.life_goal && !settings.task);
        await this.checkTaskDone();
    }

    isIdle() {
        return !this.actions.executing;
    }
    

    cleanKill(msg='Killing agent process...', code=1) {
        this.history.add('system', msg);
        this.bot.chat(code > 1 ? 'Restarting.': 'Exiting.');
        this.history.save();
        process.exit(code);
    }
    async checkTaskDone() {
        if (this.task.data) {
            let res = this.task.isDone();
            if (res) {
                await this.history.add('system', `Task ended with score : ${res.score}`);
                await this.history.save();
                // await new Promise(resolve => setTimeout(resolve, 3000)); // Wait 3 second for save to complete
                console.log('Task finished:', res.message);
                this.killAll();
            }
        }
    }

    killAll() {
        serverProxy.shutdown();
    }
}
