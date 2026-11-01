const settings = {
    "minecraft_version": "auto", // or specific version like "1.21.6"
    "host": "127.0.0.1", // or "localhost", "your.ip.address.here"
    // 싱글 월드: ESC → LAN에 공개 → 포트를 55916으로 지정.
    // 같은 PC의 127.0.0.1만 사용한다. 공유기 포트 개방은 필요 없다.
    // 채팅에 다른 포트가 뜨면 그 숫자로 바꾼다. -1은 49000–65000을 순서대로 훑어서 느리다.
    "port": 55916,
    "auth": "offline", // 로컬 LAN. 공개 서버에 붙일 때만 "microsoft"

    // the mindserver manages all agents and hosts the UI
    "mindserver_port": 8090, // 8080은 이 PC의 PostgreSQL이 쓰고 있다
    "auto_open_ui": true, // opens UI in browser on startup
    
    "base_profile": "assistant", // survival, assistant, creative, or god_mode
    "profiles": [
        "./players/cursor.json",
        "./players/chatgpt.json",
        "./players/claude.json",
    ],

    "load_memory": true, // bots/<이름>/memory.json 에 남은 핵심 사실을 이어서 읽는다
    "init_message": "짧은 한국어 한 문장으로 인사한다. 자기 이름을 말하고, 친구 둘을 언급한 뒤, 같이 무엇을 할지 묻는다.",
    "self_prompt_cooldown_ms": 15000,
    "autonomy_decision_ms": 30000, // 비축 작업 외의 다음 자율 행동을 판단하는 최소 간격
    "hybrid_autonomy": true, // routine resource work and item goals use the local planner
    "settlement_simulation": true, // 사용자 지시가 없으면 공동 거점에서 역할에 따라 생활
    "settlement_world_id": "local-survival", // 같은 서버/포트의 다른 월드로 바꾸면 이 값도 변경
    "settlement_roles": {}, // 모두 같은 자유 생활 캐릭터. 역할은 사용자가 !setRole로 지정
    "action_chain_limit": 6, // 한 턴에 이어서 실행할 명령 수. 끝나면 life_goal 이 다시 묻는다
    "life_goal": "플레이어 곁에서 계속 일한다. 즉각적인 방어, 근처 사냥, 아이템 줍기, 위험 회피는 자동이다. 체력과 장비가 충분하면 !searchForEntity로 동물이나 몬스터를 먼저 찾아도 된다. 없는 대상을 반복해서 찾지 않는다. 정찰 뒤에는 플레이어에게 돌아온다. 모으거나 만들라는 부탁은 !obtainItem을 우선한다. 근처를 보고 다음 행동 하나를 고른다. 나무나 돌은 !collectBlocks, 괭이와 씨앗이 있으면 !farm, 쓸모 있는 물건은 !craftRecipe, 플레이어에게 가는 것은 !goToPlayer. 행동이 끝나면 다음을 한다. 플레이어가 기다리라고 하지 않았다면 !stay(-1)을 쓰지 않는다. 몇 번 행동한 뒤에는 친구 한 명에게만 찾은 것과 할 일을 !startConversation으로 말하고, 끝나면 !endConversation을 한다. 이미 대화 중이면 새 대화를 시작하지 않는다. 플레이어가 방금 부탁했으면 그 일을 끝내고 이 목표로 돌아온다.",
    "only_chat_with": [], // users that the bots listen to and send general messages to. if empty it will chat publicly

    "speak": true,
    // 봇 대사를 PC 스피커로 읽는다. 게임 안 위치 소리가 아니다.
    // 프로필 speak_model 형식: supertonic/{언어}/{목소리} 예) supertonic/ko/M1
    // 목소리는 M1–M5, F1–F5. 처음 실행 때 모델을 받는다.
    // "system" 이면 Windows 기본 음성. openai, google 형식도 그대로 동작한다.
    "tts_port": 47821,

    "chat_ingame": true, // bot responses are shown in minecraft chat
    "language": "ko", // 봇이 대사를 한국어로 직접 쓴다. 명령 이름과 인자는 영어다.
    "render_bot_view": false, // show bot's view in browser at localhost:3000, 3001...

    "allow_insecure_coding": false, // allows newAction command and model can write/run code on your computer. enable at own risk
    "allow_vision": true, // 자기 시야를 찍어 다음 행동을 고른다
    "blocked_actions" : ["!checkBlueprint", "!checkBlueprintLevel", "!getBlueprint", "!getBlueprintLevel"] , // commands to disable and remove from docs. Ex: ["!setMode"]
    "code_timeout_mins": -1, // minutes code is allowed to run. -1 for no timeout
    "relevant_docs_count": 5, // number of relevant code function docs to select for prompting. -1 for all

    "max_messages": 15, // max number of messages to keep in context
    "num_examples": 2, // number of examples to give to the model
    "max_commands": -1, // max number of commands that can be used in consecutive responses. -1 for no limit
    // 채팅에 명령이 보이는 정도. "none"은 말만, "shortened"는 명령 이름, "full"은 !명령(...) 전체.
    "show_command_syntax": "none",
    "narrate_behavior": true, // chat simple automatic actions ('Picking up item!')
    "chat_bot_messages": true, // publicly chat messages to other bots

    "spawn_timeout": 30, // num seconds allowed for the bot to spawn before throwing error. Increase when spawning takes a while.
    "block_place_delay": 0, // delay between placing blocks (ms) if using newAction. helps avoid bot being kicked by anti-cheat mechanisms on servers.
  
    "log_all_prompts": false, // log ALL prompts to file
};

export default settings;
