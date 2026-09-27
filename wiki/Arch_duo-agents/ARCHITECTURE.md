# Архитектура Duo Architecture Guardian (`duo-agents`)

> Разбор архитектуры через призму **Domain-Driven Design**.
> Диаграммы — псевдографика (ANSI box-drawing), читаются в терминале, в `less`, в `cat`.
> Подсистема Red Team разобрана отдельно: [REDTEAM.md](./REDTEAM.md).

---

## 0. Паспорт системы

```
╔══════════════════════════════════════════════════════════════════════════════╗
║  DUO ARCHITECTURE GUARDIAN — multi-agent security & architecture analysis    ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  Версия          0.1.0                                                       ║
║  Коммит          3cfa5bf (master, 25.03.2026)                                ║
║  Лицензия        AGPL-3.0-only (Cargo.toml + LICENSE) · бейдж MIT в README  ║
║  Язык            Rust 2021 · Tokio · Axum 0.8                                ║
║  Объём           96 файлов .rs · 11 892 строки                               ║
║  Сборка          cargo build --release — успешно, 0 ошибок                   ║
║  Тесты           1 (один) #[test] на весь репозиторий                        ║
║  Контекст        GitLab AI Hackathon 2026, команда RED Team                  ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  Акторы          12 рабочих + оркестратор · 25 Message · 15 TxResult         ║
║  Static Scan     31 подмодуль · 8 плагинов в реестре · Top-6 маршрутизация   ║
║  Red Team        18 attack-плагинов · 12 стратегий · 6 доменов · 4 грейдера  ║
║  Traits          13 (3 — пустые маркеры для демо)                            ║
║  HTTP API        9 маршрутов Axum (8 REST + 1 WebSocket)                     ║
║  Dashboard       React 19 + Tailwind 4 + xyflow · 11 файлов · 1 036 строк    ║
║  Зависимости     31 crate, из них 7 не используются ни строкой кода          ║
╠══════════════════════════════════════════════════════════════════════════════╣
║  ИСПОЛНИМАЯ ДОСТИЖИМОСТЬ ОТ main.rs                                          ║
║    достижимо      68 модулей · 8 287 строк · 70 %                            ║
║    не исполняется 28 модулей · 3 605 строк · 30 %                            ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

**Что это за система по сути.** `duo-agents` — конвейер статического анализа безопасности,
обёрнутый в акторную инфраструктуру, воспроизводящую примитивы YDB (двухфазные таблетки,
lease, node broker, KQP-оптимизатор). Система читает исходный код, строит из него граф
сущностей, ищет по графу пути «источник → сток» без санитайзера, параллельно прогоняет
файлы через плагины-детекторы и публикует результат в GitLab Merge Request. Поверх этого
живёт второй, независимый движок — Red Team против LLM.

**Три факта, определяющие всё остальное.** Первый: в одном бинарнике сосуществуют **два
непересекающихся рантайма** (§3.1). Второй: **30 % кода не исполняется ни при одном
сценарии** (§4). Третий: заявленная головная способность — taint-анализ — **даёт ложное
отрицание на собственной эталонной уязвимости** проекта (§8).

---

## 1. Метод: как получены утверждения этого документа

Первая редакция строилась только на чтении кода. Эта — на чтении **и запуске**. Разница
существенна: одно утверждение первой редакции при проверке оказалось неверным и здесь
исправлено (§11.2).

```
   ┌─────────────────────────────────────────────────────────────────────────┐
   │  ЧТО БЫЛО СДЕЛАНО                                                       │
   ├─────────────────────────────────────────────────────────────────────────┤
   │  1. cargo build --release              собран рабочий бинарник          │
   │  2. duo-agents demo                    прогон акторного конвейера       │
   │                                        (в песочнице — см. врезку ниже)  │
   │  3. duo-agents scan ×5                 проверка детерминизма            │
   │  4. duo-agents scan на синтетике       проверка охвата маршрутизатора   │
   │  5. duo-agents mcp                     JSON-RPC initialize + tools/list │
   │  6. duo-agents serve + curl + ws       9 маршрутов и WebSocket          │
   │  7. duo-agents redteam × 6 наборов     поведение флагов (см. REDTEAM.md)│
   │  8. граф достижимости модулей          собран скриптом по путям вызовов │
   │  9. численная проверка KMeans          косинусы посчитаны независимо    │
   └─────────────────────────────────────────────────────────────────────────┘
```

> **Врезка о безопасности прогона.** `duo-agents demo` запускать из корня репозитория
> нельзя. `GitLabProvider` (`fetcher.rs:50`) возвращает виртуальные файлы с путями
> `src/test_api.rs`, `src/test_database.rs`, `src/test_frontend.rs`, а `GitLabMRActor`
> в ветке «DRY RUN» выполняет по этим путям `std::fs::write` (`actors/gitlab.rs:168`).
> При срабатывании цепочки авто-хилинга демо **перезаписало бы исходники самого проекта**.
> Все прогоны в этом документе сделаны в отдельном каталоге; репозиторий не изменён
> (`git status` чист).

---

## 2. Единый язык (Ubiquitous Language)

DDD начинается со словаря. Термины ниже — имена, реально живущие в коде: в типах, в именах
файлов, в CLI и в протоколе сообщений.

| Термин | Где живёт в коде | Смысл в предметной области |
|---|---|---|
| **Actor** | `src/actor.rs:86` | Единица обработки с двухфазным контрактом Execute/Complete. |
| **Message** | `src/protocol.rs`, 25 вариантов | Единственная валюта общения между акторами. |
| **TxResult** | `src/actor.rs:41`, 15 вариантов | Результат фазы Execute, передаваемый в Complete. |
| **ActorLifecycle** | `src/protocol.rs` | `Active → Draining → Expired → Removed`, копия `ENodeState` из YDB. |
| **Lease** | `spawn_actor_2phase(lease_ms)` | Таймаут на Execute. Просрочка → `ActorLeaseExpired`. |
| **Dirty / Committed** | `node_broker.rs` | Две копии `StateData`: невидимая и опубликованная. |
| **Entity / EntityKind** | `src/models.rs` | Узел графа кода: `Endpoint`, `DBQuery`, `Sanitizer`, `Function`, `Struct`, `Module`. |
| **EntityGraph** | `src/models.rs` | Ориентированный граф `petgraph`. Общее ядро taint-анализа, blast-radius и PlantUML. |
| **KanEdge / BSpline** | `src/models.rs` | Ребро с «обучаемым» множителем: `Calls` ×1.667, `DataFlow` ×1.0, `DependsOn` ×0.3. |
| **GraphDelta** | `src/protocol.rs` | Атомарное изменение графа. Дельта-протокол между акторами. |
| **Drift** | `actors/drift_detector.rs` | Ребро, нарушающее декларированные слои, либо семантическое расхождение. |
| **Finding** | `src/scan/mod.rs` | Находка сканера: плагин + severity + файл + строка + CWE. |
| **SecurityPlugin** | `src/scan/plugins.rs:8` | Детектор одного класса уязвимостей. |
| **Phi** | `src/scan/phi.rs` | Сменный движок обнаружения: `RegexPhi` / `SemanticPhi`. |
| **Expert / Router** | `src/scan/moe_router.rs` | Выбор Top-K плагинов под файл по инвертированному индексу. |
| **Blast Radius** | `src/blast_radius.rs` | Число входных точек, зависящих от заражённого узла. |
| **Crossover** | `src/crossover.rs` | Пересечение технического сигнала с контекстом файла. Подавитель ложных срабатываний. |
| **AgentEdge** | `src/strategy.rs` | Переключатель Explore ↔ Exploit между движками сканирования. |
| **Swarm** | `src/actors/swarm/` | Рой из 6 агентов: 4 ревьюера + патчер + агрегатор. |
| **PoisonPill** | `src/protocol.rs` | Каскадный сигнал graceful shutdown. |

**Наблюдение о языке.** Словарь — гибрид трёх источников: YDB (`TTxRegisterNode`,
`DynBitMap`, `KQP`, lease, таблетки), promptfoo (Plugin/Strategy/Grader) и машинного
обучения (`BSpline`, `MoeRouter`, `Dropout`, `LoRA`, `Quantize`, `SemanticPhi`).

Третий пласт систематически обещает больше, чем делает код, и это не стилистическая
придирка — имена вводят в заблуждение при чтении:

```
   ИМЯ В КОДЕ              ЧТО ОБЕЩАЕТ               ЧТО НА САМОМ ДЕЛЕ
   ──────────────────────────────────────────────────────────────────────────────
   SemanticPhi             ML-эмбеддинг AST          RegexPhi + sleep(15 ms)
                                                     и переписанная строка описания
   HirCallGraph            HIR rust-analyzer         ra_ap_syntax (CST), без
                                                     разрешения имён; ra_ap_hir
                                                     объявлен в Cargo.toml и не
                                                     используется ни разу
   BSpline · KanEdge       обучаемый сплайн          среднее трёх констант
   SecurityDropout         регуляризация             в конвейере — Disabled, no-op
   MoeRouter               mixture-of-experts        HashMap + sort + take(6)
   Trust Decay             затухание доверия         на рёбрах Calls риск РАСТЁТ (§10)
   KMeans Vector ANN       кластеризация             2 захардкоженных центроида,
                                                     запрос из 2 возможных векторов
```

---

## 3. Карта ограниченных контекстов (Context Map)

```
                          ┌──────────────────────────────────────┐
                          │        CLI / ENTRY CONTEXT           │
                          │  src/cli.rs · src/main.rs            │
                          │  8 команд: scan · redteam · serve    │
                          │  report · demo · mcp · init · info   │
                          └──┬───────────┬──────────┬─────────┬──┘
                             │           │          │         │
        ┌────────────────────┘           │          │         └──────────────┐
        │                                │          │                        │
        ▼                                ▼          ▼                        ▼
┌───────────────────┐   ┌──────────────────────┐  ┌──────────────────┐  ┌──────────────┐
│ STATIC SCAN       │   │  RED TEAM CONTEXT    │  │ PRESENTATION     │  │ ORCHESTRATION│
│ CONTEXT           │   │  → см. REDTEAM.md    │  │ CONTEXT          │  │ CONTEXT      │
│                   │   │                      │  │                  │  │  (только    │
│ SecurityPlugin×8  │   │  RedteamPlugin       │  │ Axum · 9 routes  │  │   в `demo`) │
│ Phi · MoeRouter   │   │  EvasionStrategy     │  │ WebSocket        │  │              │
│ Finding · Severity│   │  RedteamGrader       │  │ React dashboard  │  │ 12 акторов   │
│ run_scan()        │   │  run_redteam()       │  │ run_server()     │  │ Orchestrator │
└─────────┬─────────┘   └──────────┬───────────┘  └────────┬─────────┘  │ EntityGraph  │
          │                        │                       │            │ Swarm ×6     │
          │  Finding               │  RedteamReport        │            │ NodeBroker   │
          ▼                        ▼                       ▼            └──────┬───────┘
   ┌──────────────────────────────────────────────────────────┐                │
   │              REPORTING CONTEXT                            │                │
   │   scan::report · redteam::report                          │                │
   │   table (tabled) · JSON (serde) · Markdown                │                │
   └──────────────────────────┬───────────────────────────────┘                │
                              │                                                 │
                              ▼                                                 ▼
   ┌────────────────────────────────────────────────────────────────────────────────┐
   │                        INTEGRATION CONTEXT                                     │
   │   GitLabClient (REST v4) · MCP stdio server · MCPBridgeActor (JSON-RPC 2.0)     │
   │   .gitlab-ci.yml · agents/*.yml · flows/*.yml · .gitlab/duo/chat-rules.md       │
   └────────────────────────────────────────────────────────────────────────────────┘

   ═══════════════════════════ поперечные (частично мёртвые) ═══════════════════════════

   ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  ┌───────────────┐
   │  BLAST RADIUS    │  │  CROSSOVER       │  │  POLICY / MIGR.  │  │  A2A / TELEM. │
   │  TrustDecay      │  │  FP-подавление   │  │  SwarmConfig     │  │  CircuitBreak.│
   │  ⚠️ только demo  │  │  ✅ orchestrator │  │  ⚠️ policy мёртв │  │  ⚠️ 1 из 3    │
   └──────────────────┘  └──────────────────┘  └──────────────────┘  └───────────────┘
```

### 3.1. Ключевое: два рантайма, которые никогда не встречаются

```
   duo-agents scan │ redteam │ serve │ mcp        duo-agents demo  (или без аргументов)
   ─────────────────────────────────────          ──────────────────────────────────────

   ┌─────────────────────────────────┐            ┌─────────────────────────────────────┐
   │  СИНХРОННЫЙ ФУНКЦИОНАЛЬНЫЙ ПУТЬ │            │  АКТОРНЫЙ АСИНХРОННЫЙ ПУТЬ          │
   │                                 │            │                                     │
   │  run_scan(path)                 │            │  12 × spawn_actor_2phase(...)       │
   │    → collect_files (glob)       │            │  FlowOrchestratorActor              │
   │    → rayon par_iter             │            │  mpsc-каналы + broadcast-телеметрия │
   │    → MoeRouter → Top-6          │            │  heartbeat · lease · PoisonPill     │
   │    → Phi → plugin.scan()        │            │  NodeBroker · DynBitMap             │
   │    → report::to_json/md/table   │            │  EntityGraph · DFS taint            │
   │                                 │            │  Swarm fan-out/fan-in               │
   │  run_redteam(config)            │            │  Crossover · Blast-Radius           │
   │    → generate_attacks           │            │  GitLab auto-heal                   │
   │    → simulate_ai_response       │            │                                     │
   │    → grade → scoring            │            │  Webhook :3000 /webhook             │
   └─────────────────────────────────┘            └─────────────────────────────────────┘
                  │                                              │
                  │        ✗  НЕТ НИ ОДНОГО ВЫЗОВА  ✗            │
                  └──────────────  между ними  ──────────────────┘
```

`server::run_server()` (`src/server/mod.rs:17`) поднимает Axum, CORS, статику и
`broadcast`-канал телеметрии — но **не запускает ни одного актора**. Проверено прогоном:

```
   $ duo-agents serve --port 3111 &
   $ python3 ws_client.py                     # подключение к ws://127.0.0.1:3111/ws

     handshake: HTTP/1.1 101 Switching Protocols
     кадров получено за 6 с: 1
      -> {"type":"CONNECTION_ESTABLISHED"}     ← и тишина навсегда
```

Канал телеметрии в режиме `serve` не наполняет никто: единственный его писатель —
`FlowOrchestratorActor`, а он существует только внутри `demos::run_demos()`
(`src/demos/mod.rs:66–79`).

### 3.2. Типы отношений между контекстами

| Пара контекстов | Паттерн DDD | Как выражен в коде |
|---|---|---|
| CLI → все | **Open Host Service** | `clap`-подкоманды, каждая — ветка `match` в `main()` |
| Static Scan → Reporting | **Shared Kernel** | `Finding`, `Severity`, `ScanResult` из `src/scan/mod.rs` |
| Red Team → Reporting | **Shared Kernel (дублированный)** | Свой `Severity`, свой `report.rs`. Три независимых `Severity` в бинарнике |
| Orchestration → акторы | **Ports & Adapters** | Порт — trait `Actor`; 12 адаптеров; транспорт — `mpsc::Sender<Message>` |
| Orchestration → Integration | **Anti-Corruption Layer** | `GitLabClient` → REST v4; `MCPBridgeActor` → JSON-RPC 2.0 |
| Presentation → Static Scan | **Conformist** | Хендлеры сериализуют доменные типы напрямую, без DTO |
| Scan ↔ Orchestration | **Separate Ways** | Фактически, а не по замыслу: ни одного вызова |

Последняя строка — диагноз. `Separate Ways` в DDD означает «контексты сознательно
разведены, интеграция не окупается». Здесь разведение произошло по инерции: акторная
платформа написана первой, продуктовые команды приросли сбоку и пошли своим путём.

---

## 4. Исполнимая достижимость: треть кода не работает

Граф собран скриптом: ребро — обращение к модулю по пути (`crate::x::`, `x::`,
`super::x`); объявление `pub mod` связью **не** считается, потому что оно включает код
в компиляцию, но не в исполнение. Корень обхода — `main.rs`.

```
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  ДОСТИЖИМО ОТ main.rs        68 модулей ·  8 287 строк ·  70 %           │
   │  НЕ ИСПОЛНЯЕТСЯ НИКОГДА      28 модулей ·  3 605 строк ·  30 %           │
   └──────────────────────────────────────────────────────────────────────────┘

   Разбивка недостижимого:

   ┌── src/scan/ ─────────────────────── 23 модуля · 3 432 строки ───────────┐
   │  accel_detector · adaptive_grid · basis_cache · crdt · dag · dsl        │
   │  forward_ad · reverse_ad · frozen_trainable · fuzzy · gadt_rule         │
   │  gravity · kv_cache · lora_edge · ode · quantize · redshift             │
   │  sparse_router · stream · surge_queue · tensor_profile · topk_sampler   │
   │  what_if                                                                │
   ├── прочее ────────────────────────────  5 модулей ·  173 строки ─────────┤
   │  babylonian      101   «60-Head» рой микро-сканеров                     │
   │  policy_engine    50   трёхуровневый merge Global→Enterprise→Project    │
   │  test_frontend    12  ┐                                                 │
   │  test_database     9  ├ намеренно уязвимые фикстуры в релизном бинарнике│
   │  test_api          1  ┘                                                 │
   └──────────────────────────────────────────────────────────────────────────┘

   Достижимость по командам (изолированно, без main):
      scan     ->   7 модулей,  1 228 строк
      redteam  ->  10 модулей,  1 448 строк
      mcp      ->   8 модулей,  1 395 строк
      demo     ->  27 модулей,  3 719 строк   ← самая «богатая» команда
      serve    ->  40 модулей,  4 436 строк
```

**Отдельного внимания заслуживает `sparse_router`.** В `scan/mod.rs` он объявлен как
`pub mod sparse_router`, но `SparseSecurityIndex` — структура, которую он должен
предоставлять, — фактически определена в `moe_router.rs`. То есть в дереве лежит
132-строчный дубликат, на который никто не ссылается, а работает копия из соседнего файла.

С точки зрения DDD 23 модуля в `scan/` — не «мёртвый код» в обычном смысле, а
**несостоявшийся supporting subdomain**: заготовки будущего движка, попавшие в основную
ветку раньше, чем к ним подвели вызовы. Их имена (`ode`, `quantize`, `lora_edge`,
`forward_ad`, `reverse_ad`, `frozen_trainable`) очерчивают контур *другой* системы —
дифференцируемого движка с автоматическим дифференцированием, — которая к анализу
безопасности отношения не имеет.

---

## 5. Orchestration Context — акторное ядро

### 5.1. Двухфазный контракт `Actor`

```
┌────────────────────────────────────────────────────────────────────────────┐
│  trait Actor                                             src/actor.rs:86   │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│   on_start()                        инициализация таблетки                 │
│        │                                                                   │
│        ▼                                                                   │
│   ┌─────────────────────┐   ФАЗА 1                                         │
│   │ execute(msg) ───────┼──► TxResult      мутирует только Dirty-состояние │
│   └─────────────────────┘                  обёрнута в timeout(lease_ms)    │
│        │                                                                   │
│        │  Ok(result)                            Err(_) — lease истёк       │
│        ▼                                             │                     │
│   ┌─────────────────────┐   ФАЗА 2                   ▼                     │
│   │ complete(res, ctx)  │             Message::ActorLeaseExpired           │
│   └─────────────────────┘             → оркестратор → самовосстановление   │
│        │  продвигает Dirty → Committed                                     │
│        │  шлёт Message в orchestrator_tx                                   │
│        │  шлёт JSON в telemetry_tx (broadcast → WebSocket → React)         │
│        ▼                                                                   │
│   on_poison_pill() → Draining      on_stop() → Removed                     │
└────────────────────────────────────────────────────────────────────────────┘
```

Разделение на две фазы даёт три конкретных свойства, и все три реально работают:

1. **Изоляция отказа.** `execute` под `timeout`; зависший актор не блокирует оркестратор,
   а порождает `ActorLeaseExpired` — доменное событие, на которое есть реакция.
2. **Атомарность видимости.** Пока `complete` не вызван, результат никому не виден.
   `NodeBrokerActor` доводит это до буквы: два поля, `dirty` и `committed`.
3. **Единая точка публикации.** Все исходящие сообщения и вся телеметрия рождаются
   в `complete`, а не размазаны по `execute`.

Это лучшее, что есть в репозитории, и оно выдержано во всех двенадцати акторах.

### 5.2. Реестр акторов

| Актор | Файл | Вход | Выход | lease / hb (мс) |
|---|---|---|---|---|
| `FlowOrchestratorActor` | `orchestrator.rs` | все | все | — (вызывается напрямую) |
| `ASTAnalyzerActor` | `actors/ast_analyzer.rs` | `AnalyzeAST` | `GraphReady`, `AstDelta` | 5000 / 0 |
| `SecurityAnalyzerActor` | `actors/security.rs` | `GraphReady` | `SecurityVulnFound` / `…Passed` | 1000 / **300** |
| `DriftDetectorActor` | `actors/drift_detector.rs` | `CheckDrift` | `DriftDetected` / `DriftPassed` | 5000 / 0 |
| `GitLabMRActor` | `actors/gitlab.rs` | `PostReviewComment`, `AggregatedResult` | — (терминальный) | 5000 / 0 |
| `MCPBridgeActor` | `actors/mcp_bridge.rs` | `ExecuteMCPTool` | stdout | 5000 / 0 |
| `NodeBrokerActor` | `actors/node_broker.rs` | `RegisterNodeRequest`, … | delta log | 5000 / 0 |
| `AstFixAgent` | `swarm/ast_fix_agent.rs` | `SecurityVulnFound` | `FixPatch` | 5000 / 0 |
| `ReviewAgent` | `swarm/review_agent.rs` | `MergeRequestCreated` | `ReviewReport` | 5000 / 0 |
| `ComplexityAgent` | `swarm/complexity_agent.rs` | `MergeRequestCreated` | `ReviewReport` | 5000 / 0 |
| `DependencyAgent` | `swarm/dependency_agent.rs` | `MergeRequestCreated` | `ReviewReport` | 5000 / 0 |
| `DocCoverageAgent` | `swarm/doc_coverage_agent.rs` | `MergeRequestCreated` | `ReviewReport` | 5000 / 0 |
| `AggregatorActor` | `swarm/aggregator.rs` | `SecurityReport`, `FixPatch`, `ReviewReport`×4 | `AggregatedResult` | 5000 / 0 |

**Heartbeat включён у одного актора из двенадцати.** Это видно в прогоне: за всё демо
в логе только `💓 Heartbeat получен от 'SecurityAnalyzerActor'`. Механизм
`heartbeats: HashMap<&str, Instant>` в оркестраторе есть, но заполняется одним ключом и
никогда не читается — нет ни одной проверки «кто молчит дольше N».

Аналогично `PoisonPill`: `send_poison_to_all()` рассылает пяти акторам из двенадцати
(`ast`, `sec`, `drift`, `action`, `mcp`), а условие завершения
`poison_acks.len() == child_actors.len()` сравнивает с двенадцатью — оно недостижимо.
В демо функция не вызывается вовсе.

### 5.3. NodeBroker: примитивы YDB, воспроизведённые буквально

```
   RegisterNodeRequest { host, port }
          │
          ▼  ФАЗА EXECUTE
   ┌──────────────────────────────────────────────────────────────┐
   │  DynBitMap::first_non_zero_bit()   O(1) через trailing_zeros │
   │      1024-битный пул, 1 = свободен                           │
   │  dirty.nodes.insert(node_id, NodeInfo { .. version: v+1 })   │
   │  dirty.epoch_version = v + 1                                 │
   │      ← committed НЕ ТРОНУТ, снаружи изменений не видно       │
   └──────────────────────────────────────────────────────────────┘
          │
          ▼  ФАЗА COMPLETE
   ┌──────────────────────────────────────────────────────────────┐
   │  delta_log.push((version, NodeDelta::NodeAdded(id, info)))   │
   │  committed.nodes.insert(...)                                 │
   │  committed.epoch_version = version                           │
   │  push_deltas_to_subscribers()                                │
   └──────────────────────────────────────────────────────────────┘
```

Реализация Dirty/Committed корректна и содержательна. Но `push_deltas_to_subscribers`
(`node_broker.rs:49`) обрывается на середине:

```rust
let pending: Vec<&NodeDelta> = self.delta_log.iter()
    .filter(|(v, _)| *v > *sent_version).map(|(_, d)| d).collect();
info!("... {} изменений.", pending.len());    // ← напечатали количество
*sent_version = self.committed.epoch_version; // ← отметили как доставленные
```

`pending` вычисляется, логируется и **уничтожается**. Канала к подписчику нет:
`subscribers` хранит `HashMap<&'static str, u64>` — имя и версию, но не отправитель.
Механизм инкрементальной рассылки — симуляция на уровне логов.

Второй дефект: `free_bit(node_id)` вызывается только при переходе в `Removed`. Узел,
доживший до `Expired`, ID не возвращает — пул из 1024 протекает.

---

## 6. Прогон одного Merge Request: что происходит на самом деле

Ниже — не проектная схема, а восстановленная по логам трасса реального прогона
`duo-agents demo`, ДЕМО 1: MR-300, `changed_files: ["src/test_frontend.rs"]`.

```
   Message::MergeRequestCreated { mr: 300 }
          │
          ├──────────────► перехват в demos/mod.rs:108 — fan-out ЧЕТЫРЁМ ревьюерам
          │                ReviewAgent · ComplexityAgent · DependencyAgent · DocCoverage
          │                (минуя оркестратор — прямая отправка из цикла)
          ▼
   FlowOrchestratorActor::handle
   dirty_state[300] = MRState { phase: Dirty }
          │
          ├── ast_tx  ◄── AnalyzeAST { files }
          └── sec_tx  ◄── ScanSecurity { files }   ┐
                                                   │ ⚠️ ГОНКА: SecurityAnalyzer
                                                   │ реагирует только на GraphReady.
                                                   │ Это сообщение → TxResult::Ignored.
                                                   ┘ DAG объявлен параллельным,
                                                     фактически последователен.
   ─── факт из лога, порядок событий ────────────────────────────────────────────
     👨‍💻 [Review:Execute]        ┐
     📦 [Dependency:Execute]     │  четыре ревьюера успевают отработать
     📝 [DocCoverage:Execute]    │  ДО того, как AST-анализ вообще начался
     📏 [Complexity:Execute]     ┘
     🐝 [Aggregator] ReviewReport #1..#4 получен (4/4)
     🌲 [AST:Execute]  Извлечение AST для MR-300
     🌲 [AST:Complete] EntityGraph построен (Узлов: 2)
     🧠 [Drift:Execute] KMeans → "Performance_AntiPatterns" (cos:0.75)
     🔱 [Orch] MR-300 прошёл проверку архитектуры
     🔐 [Sec:Execute]  Активная стратегия: 'DFS Taint Analysis' (Режим: Explore)
     🔱 [Orch] MR-300 прошёл проверку безопасности          ← ЛОЖНОЕ ОТРИЦАНИЕ (§8)
   ──────────────────────────────────────────────────────────────────────────────
          │
          ▼
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  AggregatorActor — fan-in барьер                    swarm/aggregator.rs  │
   │  ждёт: sec_done && fix_done && review_count == EXPECTED_REVIEW_AGENTS(4) │
   │                                                                          │
   │  review_count = 4 ✅   sec_done = false ❌   fix_done = false ❌          │
   │  → AggregatedResult НЕ ФОРМИРУЕТСЯ НИКОГДА                               │
   │  → GitLabMRActor не получает ничего                                      │
   │  → авто-хилинг, ветка, MR, пайплайн — недостижимы                        │
   └──────────────────────────────────────────────────────────────────────────┘
```

Три структурных вывода из этой трассы:

**Первый — барьер fan-in не отказоустойчив.** `EXPECTED_REVIEW_AGENTS = 4` — константа,
а `sec_done`/`fix_done` взводятся только при найденной уязвимости. Если проверка прошла
чисто, барьер не срабатывает никогда, и это не ошибка обработки, а тупик: у fan-in нет
ни таймаута, ни ветки «всё чисто». Терминальный актор в благополучном сценарии молчит.

**Второй — оркестратор обходит сам себя.** Fan-out четырём ревьюерам сделан не в
`FlowOrchestratorActor::handle`, а в цикле `demos/mod.rs:108–116`, перехватом сообщения
до передачи оркестратору. Маршрутизация размазана между двумя местами, и половина её
живёт в демо-коде, а не в оркестраторе.

**Третий — «DAG-план» декларативен.** Строка `DAG план: AstAnalysis → SecurityScan +
DriftDetection → PostComment` — это `info!`, а не структура. Нет ни графа, ни узлов,
ни топологической сортировки: есть `match` по типу сообщения и вызовы `.send()`.

---

## 7. Доменное ядро: EntityGraph и семантический движок

### 7.1. Модель, которая сделана правильно

```
   enum EntityKind {                    enum EdgeKind → KanEdge { spline }
     Function                             Calls     → BSpline::amplifier()  ×1.667
     Struct                               DataFlow  → BSpline::neutral()    ×1.000
     Module                               DependsOn → BSpline::dampener()   ×0.300
     Endpoint     ← ИСТОЧНИК
     DBQuery      ← СТОК
     Sanitizer    ← ПРЕРЫВАТЕЛЬ ПУТИ
   }
```

`EntityKind` — доменная, а не техническая классификация. Три из шести вариантов
(`Endpoint`, `DBQuery`, `Sanitizer`) существуют исключительно ради taint-анализа и прямо
кодируют его правило: путь от источника к стоку без прерывателя есть уязвимость.
Три подсистемы — DFS taint, blast-radius и генерация PlantUML — читают один и тот же граф.
Это настоящее доменное ядро, а не анемичная модель.

### 7.2. Семантический движок: чего в нём нет

`semantic_engine.rs` называется «HIR Call Graph», а `AGENTS.md` предписывает
«использовать `syn` для разбора». Проверка показывает иное:

```
   $ grep -rn "\bsyn\b" --include='*.rs' src/
     src/main.rs:22://! ├── semantic_engine/  — HIR Call Graph через syn
     src/main.rs:31:/// Семантический движок (HIR Call Graph через syn)
     src/actors/ast_analyzer.rs:20:/// настоящий semantic_engine (HIR Call Graph через syn)

     ← три вхождения, все три — в комментариях. Ни одной строки кода.

   $ для каждого ra_ap_* — число вхождений в src/
     ra_ap_syntax   1      ← используется
     ra_ap_edition  1      ← используется
     ra_ap_hir      0      ← объявлен в Cargo.toml, не используется
     ra_ap_ide      0      ← объявлен в Cargo.toml, не используется
     ra_ap_base_db  0      ← объявлен в Cargo.toml, не используется
```

Движок работает на `ra_ap_syntax` — это **синтаксический** слой rust-analyzer (CST),
без разрешения имён и без вывода типов. Практические следствия:

```
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  HirCallGraph::build()                                                   │
   │    индексирует ast::Fn → HashMap<имя_функции, NodeIndex>                 │
   │    ⚠️ одноимённые функции в разных файлах ЗАТИРАЮТ друг друга в index,   │
   │       узел остаётся в графе сиротой                                      │
   │                                                                          │
   │  HirCallGraph::add_edges()                                               │
   │    для каждого ast::CallExpr берёт ТЕКСТ выражения-вызова                │
   │    и ищет его в HashMap как строку                                       │
   │                                                                          │
   │    raw_query(&q)        → "raw_query"   → совпадение возможно      ✅     │
   │    self.foo()           → "self.foo"    → в индексе нет            ❌     │
   │    mod::foo()           → "mod::foo"    → в индексе нет            ❌     │
   │    x.method()           → это MethodCallExpr, НЕ CallExpr → невидим ❌     │
   │    format!(...)         → это макрос, НЕ CallExpr → невидим        ❌     │
   └──────────────────────────────────────────────────────────────────────────┘
```

То есть граф вызовов видит только свободные функции, вызванные по короткому имени, из
файлов, попавших в один `Workspace`. Всё остальное для него не существует.

`generate_semantic_patch` довершает картину: находит **первый** `CallExpr`, чей текст
содержит `raw_query`, и заменяет его на строковый литерал
`prepare_query("SELECT * FROM users WHERE id = $1", &[id])` — независимо от того, какой
запрос там был. Это не семантический патч, а фиксированная подстановка.

---

## 8. Цепь отказов taint-анализа: ложное отрицание на эталоне

Это центральный результат углублённого разбора. Проект содержит специально написанный
уязвимый файл — `src/test_frontend.rs`:

```rust
pub fn login_handler(user_id: String) { auth_service(user_id); }

pub fn auth_service(user_id: String) {
    // 🚨 BAD QUERY INJECTED
    let query = format!("SELECT * FROM users WHERE id = {}", user_id);
    raw_query(&query);
}
```

Демо подаёт именно этот файл на вход. Результат прогона:
`🔱 [Orch] MR-300 прошёл проверку безопасности.`

Восстановленная цепь отказов:

```
   ЗВЕНО 1 · Workspace содержит ОДИН файл
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  changed_files = ["src/test_frontend.rs"]                                │
   │  raw_query определён в test_database.rs — В WORKSPACE НЕ ПОПАЛ           │
   └──────────────────────────────────────────────────────────────────────────┘
                    │
   ЗВЕНО 2 · индекс функций                    ast_analyzer.rs → HirCallGraph
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  проиндексировано: login_handler, auth_service     → «Узлов: 2» ✅ лог   │
   │  raw_query отсутствует → сток НЕ СУЩЕСТВУЕТ                              │
   └──────────────────────────────────────────────────────────────────────────┘
                    │
   ЗВЕНО 3 · рёбра
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  auth_service(user_id) → CallExpr «auth_service» → ребро есть      ✅    │
   │  raw_query(&query)     → CallExpr «raw_query» → нет в индексе      ❌    │
   │  format!(...)          → макрос, не CallExpr → невидим             ❌    │
   └──────────────────────────────────────────────────────────────────────────┘
                    │
   ЗВЕНО 4 · присвоение EntityKind        ast_analyzer.rs:60 — подстрочный матч
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  имя содержит "login"    → Endpoint   login_handler → Endpoint      ✅   │
   │  имя содержит "query"    → DBQuery    таких нет → DBQuery ОТСУТСТВУЕТ    │
   │  имя содержит "sanitize" → Sanitizer  таких нет                          │
   │  иначе                   → Function   auth_service → Function            │
   └──────────────────────────────────────────────────────────────────────────┘
                    │
   ЗВЕНО 5 · DFS                                              actors/security.rs
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  обход от каждого Endpoint в поиске DBQuery                              │
   │  login_handler → auth_service → тупик. DBQuery в графе нет.              │
   │  vulns.is_empty() → TxResult::SecurityPass                               │
   └──────────────────────────────────────────────────────────────────────────┘
                    │
                    ▼
        Message::SecurityScanPassed { mr_id: 300 }      ← ЛОЖНОЕ ОТРИЦАНИЕ
```

**Классификация уязвимости определяется подстрокой в имени функции.** Переименование
`raw_query` в `execute_sql` убирает его из категории `DBQuery`; переименование
`login_handler` в `handle_signin` убирает источник. Доменная классификация, которая в
§7.1 выглядит правильной, снабжена распознавателем на трёх литералах
(`"login"`, `"query"`, `"sanitize"`) — и это единственный способ, которым сущность
получает свой вид.

**Второе, независимое звено — режим fail-open.** В `ast_analyzer.rs:48`:

```rust
.map(|f| (f.clone(), std::fs::read_to_string(f).unwrap_or_default()))
```

Нечитаемый или отсутствующий файл превращается в пустую строку. Прогон в каталоге без
исходников даёт `EntityGraph построен (Узлов: 0)` и затем — `прошёл проверку
безопасности`. Ворота качества, не сумевшие прочитать файл, отвечают «чисто», а не
«ошибка». Для инструмента, встраиваемого в CI как блокирующая проверка, это худший
из возможных выборов умолчания.

---

## 9. Детектор дрифта: обе ветви структурно мертвы

`DriftDetectorActor` объявляет два независимых механизма. Проверка показывает, что
сработать не может ни один.

### 9.1. Семантическая ветвь: заголовок MR не доезжает

```
   MergeRequestEvent { mr_id: 400, title: "Feature: Implement Custom JWT Auth" }
          │
          ▼
   ASTAnalyzerActor::complete                              ast_analyzer.rs:100
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  ctx.orchestrator_tx.send(Message::AstDelta {                            │
   │      mr_id,                                                              │
   │      title: "AST Diff".into(),   ◄══ ЗАГОЛОВОК ПЕРЕЗАПИСАН КОНСТАНТОЙ    │
   │      deltas })                                                           │
   └──────────────────────────────────────────────────────────────────────────┘
          │
          ▼
   FlowOrchestratorActor → CheckDrift { title: "AST Diff", .. }
          │
          ▼
   DriftDetectorActor::mock_embed("AST Diff")
      содержит "jwt" или "auth"?  → НЕТ  → вектор [0.1,0.1,0.9,0.1,0.1,0.1,0.9,0.1]
```

Численная проверка (косинусы посчитаны независимо от кода, совпали с логом до сотой):

```
   ЕСЛИ БЫ заголовок дошёл (вектор «jwt»):
      cos(jwt, Arch_Guidelines)                       = 0.999   ← победил бы
      cos(jwt, Performance_AntiPatterns)              = 0.199
      cos(jwt, GUIDE-01 «не изобретай свой JWT»)      = 0.992   > 0.85 → СРАБОТАЛО БЫ

   ЧТО ПРОИСХОДИТ НА САМОМ ДЕЛЕ (вектор «AST Diff»):
      cos(other, Arch_Guidelines)                     = 0.243
      cos(other, Performance_AntiPatterns)            = 0.747   ← побеждает
      cos(other, GUIDE-02)                            = 0.747   < 0.85 → нет совпадения
      cos(other, GUIDE-04)                            = 0.779   < 0.85 → нет совпадения

   ЛОГ ПРОГОНА:
      ⚙️ [KMeans:Level 1] Ближайший корневой кластер: "Performance_AntiPatterns" (cos:0.75)
      ⚙️ [KMeans:Level 0] Спуск в кластер. Оценка 2 листовых правил...
      🔱 [Orch] MR-400 прошёл проверку архитектуры.
```

Правило `GUIDE-01` сформулировано буквально про «не изобретай собственный JWT, используй
GitLab SSO». MR называется «Implement Custom JWT Auth». Совпадение было бы 0.992 при
пороге 0.85. Оно не происходит, потому что за одну строку до этого заголовок заменён
на литерал `"AST Diff"`.

### 9.2. Структурная ветвь: правила не пересекаются с производителями

```
   ЧТО ПОРОЖДАЕТ ASTAnalyzerActor          ЧТО ЗНАЕТ DriftDetectorActor
   ─────────────────────────────────       ──────────────────────────────────────
   EdgeAdded("Controller", "DB")           LogicalRule {
   EdgeAdded("CustomJWT", "OmniAuth")          source: "frontend",
                                               allowed_targets: ["api"]
                                           }
                                           ← ровно одно правило на весь детектор

   PhyOlapFilter::execute(delta):
       compiled_rules.get("Controller")  → None → выходим, нарушения нет
       compiled_rules.get("CustomJWT")   → None → выходим, нарушения нет

   ⇒ violations всегда пусто. Структурный дрифт не может быть обнаружен
     ни для одного ребра, которое система в принципе умеет породить.
```

Инвертированный индекс `PhyOlapFilter` построен корректно и даёт O(1). KQP-фаза
`Peephole Rewrite` (удаление самопетель) тоже работает. Оптимизирован конвейер, который
не имеет входных данных: в словаре правил один ключ `"frontend"`, а производитель рёбер
таких источников не выпускает.

**Итог по разделу.** «Architecture Guardian» — так называется проект — не обнаруживает
архитектурный дрифт ни семантически, ни структурно. Обе ветви написаны, обе разумны по
замыслу, и обе разорваны одной строкой каждая: перезаписью заголовка и несовпадением
ключа в словаре правил.

---

## 10. Blast Radius: «trust decay», который усиливает

`blast_radius.rs` выполняет BFS вверх по графу от заражённого узла, умножая накопленный
риск на сплайн ребра, и отсекает ветви при `new_risk <= 0.1`.

```
   BSpline::eval(x) = x · (среднее коэффициентов)

     Calls     coeffs [1.5, 2.0, 1.5]  →  множитель 1.667   ← УСИЛЕНИЕ
     DataFlow  coeffs [1.0, 1.0, 1.0]  →  множитель 1.000   ← нейтрально
     DependsOn coeffs [0.5, 0.3, 0.1]  →  множитель 0.300   ← затухание

   Накопление риска по цепочке рёбер Calls:

     после 1 ребра   1.67 ┐
     после 2 рёбер   2.78 │
     после 3 рёбер   4.63 ├─ порог отсечения 0.1 НЕДОСТИЖИМ
     после 4 рёбер   7.72 │
     после 5 рёбер  12.86 ┘
```

Модуль называется `TrustDecayAnalyzer`, а на рёбрах типа `Calls` — а именно ими
`EntityGraph::connect` связывает вызовы — риск монотонно **растёт**. Условие
`new_risk > 0.1` в цикле BFS для такого графа всегда истинно, то есть отсечения
не происходит никогда, и BFS вырождается в полный обход компоненты связности.

На практике это означает, что «взрывной радиус» равен числу всех достижимых вверх
`Endpoint` — метрика осмысленная, но получаемая не тем механизмом, который заявлен.
Сплайн не влияет ни на что, кроме роста числа, которое ни с чем не сравнивается.

Прогон подтверждает: демо-граф из 6 эндпоинтов → `Найдено 6 эндпоинтов` → порог
`high_threshold = 3` → `⚠️ HIGH BLAST RADIUS`. Пороги (`critical ≥ 10`, `high ≥ 3`)
захардкожены в `TrustDecayAnalyzer::new()`.

---

## 11. Static Scan Context — конвейер файлового сканирования

### 11.1. Конвейер `run_scan`

```
   collect_files(path)   glob по 11 расширениям, минус target/ node_modules/ .git/
          │
          ▼
   ScanCheckpoint::load(path)  ──┐ восстановление после падения
   ScanWal::open(path)         ──┘ WAL для файлов между чекпоинтами
          │                        ⚠️ пишутся В СКАНИРУЕМЫЙ КАТАЛОГ:
          │                           <path>/.duo-checkpoint.json и <path>/scan.wal
          ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │  rayon: files.par_iter()          — файл на ядро CPU             │
   │                                                                  │
   │   ├── MoeRouter::assign_experts(path, content)                   │
   │   │      SparseSecurityIndex::build() → route(..., top_k = 6)    │
   │   │      ⚠️ индекс перестраивается ДЛЯ КАЖДОГО ФАЙЛА             │
   │   │                                                              │
   │   ├── SecurityDropout::production().apply_mask(...)              │
   │   │      → DropoutMode::Disabled → сквозной проход, no-op        │
   │   │                                                              │
   │   ├── для плагинов из маски: plugin.scan(...)                    │
   │   │      sql-injection делегирует в Phi:                         │
   │   │        размер < 5000 байт → SemanticPhi (= RegexPhi + 15 мс) │
   │   │        размер ≥ 5000 байт → RegexPhi                         │
   │   │                                                              │
   │   ├── WAL: log_file(...)                          ← Mutex        │
   │   └── checkpoint: mark_scanned; каждые 50 файлов save + truncate │
   └──────────────────────────────────────────────────────────────────┘
          │
          ▼
   sort_by(severity desc) → ScanSummary::from_findings → ScanResult
```

### 11.2. Исправление первой редакции: dropout — не источник недетерминизма

> Первая редакция этого документа утверждала, что `SecurityDropout` вносит
> недетерминированность в сканер. **Это неверно, и утверждение снято.**
>
> `SecurityDropout::production()` возвращает `DropoutMode::Disabled`, а `apply_mask`
> для этого режима — тождественное отображение, не обращающееся к ГПСЧ вовсе.
> Случайное маскирование живёт только в `diagnostics()` (p = 0.3), который в конвейере
> не вызывается.
>
> Проверка пятью прогонами по одному пути: множества находок совпали полностью,
> `risk_score` идентичен. **Сканер детерминирован.**

### 11.3. Реальный дефект охвата: Top-6 из 8 с обратным градиентом

`MoeRouter::assign_experts` возвращает `route(filename, content, 6)` — не более шести
плагинов из восьми. Кто попадёт в шестёрку, определяется накопленным весом; двум
`always_on`-экспертам присваивается базовый вес 0.1, то есть последнее место.

Проверка на синтетическом файле, задевающем все восемь плагинов сразу
(`unsafe fn` + `*mut` + `format!("SELECT` + `sk-` + `glpat-` + `.unwrap()` + `panic!` +
`TODO` + `FIXME` + `eval(` + `exec(` + `md5(` + `from_utf8_unchecked`):

```
   плагин               сработал?
   ────────────────────────────────────────────────
   unsafe-code          да (3)
   sql-injection        да (2)
   hardcoded-secrets    да (1)
   unwrap-panic         да (1)
   deprecated-api       да (2)
   crypto-weakness      да (2)
   todo-fixme           НЕТ — вытеснен из Top-6
   input-validation     НЕТ — вытеснен из Top-6
```

Тот же `TODO`, тот же `FIXME`, тот же `from_utf8_unchecked` — но в «тихом» файле
без конкурентов:

```
   находок: 3 → {'input-validation': 1, 'todo-fixme': 1}   ← оба сработали
```

```
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  ОБРАТНЫЙ ГРАДИЕНТ ОХВАТА                                                │
   │                                                                          │
   │  Один и тот же фрагмент помечается в безобидном файле                    │
   │  и молча пропускается в опасном.                                         │
   │                                                                          │
   │  Чем больше в файле признаков угрозы, тем больше проверок                │
   │  с него снимается. Маршрутизатор экономит именно там,                    │
   │  где экономить нельзя.                                                   │
   │                                                                          │
   │  Иронично: два эксперта, помеченные в индексе как always_on              │
   │  («всегда включены»), — ровно те два, что не запускаются никогда,        │
   │  когда файл нетривиален.                                                 │
   └──────────────────────────────────────────────────────────────────────────┘
```

Дополнительно: `SparseSecurityIndex::build()` вызывается **на каждый файл** (комментарий
в коде это признаёт: «Lazy-static would be ideal here»). При скане в 10 000 файлов индекс
строится 10 000 раз.

### 11.4. Что сканер находит на самом деле

Все восемь плагинов — построчный текстовый анализ (`content.lines()`,
`trimmed.contains(...)`). AST не разбирается: `syn` не используется (§7.2), а
`SemanticPhi` — это `RegexPhi` плюс `thread::sleep(15 ms)` и переписанная строка
описания находки.

Прогон по `src/redteam` (28 файлов, 2 302 строки) даёт 4 находки, из них две —
ложноположительные:

```
   [Critical] hardcoded-secrets  cross_session.rs:33  ("My secret API key is sk-PROJ-abc…
   [Critical] hardcoded-secrets  cross_session.rs:35  "sk-PROJ-abc123def456"),
   [Low]      unwrap-panic       mod.rs:242
   [Low]      unwrap-panic       scoring.rs:182
```

Обе критические находки — это **строки-приманки из корпуса Red Team**: вымышленный ключ
внутри шаблона атаки, проверяющей утечку между сессиями. Плагин `hardcoded-secrets` имеет
фильтры (`env::var`, `example`, `placeholder`), но литерал внутри тестового корпуса под
них не подпадает. Итоговый `risk_score` для всей директории — 9.0 из 10, целиком из-за
двух фикстур.

### 11.5. Расчёт риска

```
   risk_score = min(10, max(severity.score() по всем findings) + distribution_penalty)

   distribution_penalty =  1.0   если critical > 2
                           0.5   если critical > 0 && high > 2
                           0.0   иначе
```

Формула насыщается мгновенно: одна `Critical`-находка даёт 9.0, три — 10.0. Проект с
3 критичными находками и проект с 300 она не различает.

---

## 12. Red Team Context

Подсистема разобрана отдельно и подробно в [REDTEAM.md](./REDTEAM.md). Здесь — только
место в архитектуре.

```
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  src/redteam/ — 28 файлов, 2 302 строки                                  │
   │                                                                          │
   │  Три ортогональных trait'а: RedteamPlugin · EvasionStrategy ·            │
   │  RedteamGrader. Реестры: 18 атак + 6 доменов, 12 стратегий, 4 грейдера.  │
   │                                                                          │
   │  ГЕРМЕТИЧНОСТЬ: пять внешних crate'ов, НОЛЬ обращений к остальному       │
   │  коду проекта. Не знает ни об EntityGraph, ни об акторах, ни о GitLab.   │
   │  Может быть вынесена в отдельный крейт перемещением директории.          │
   │                                                                          │
   │  ИЗОЛЯЦИЯ ОТ ПРОДУКТА: результат Red Team никуда не течёт. Не попадает   │
   │  в MR-комментарий, не влияет на CI, не участвует в scan::ScanResult.     │
   │                                                                          │
   │  ⚠️ Два разрыва конвейера: стратегии не применяются (amplify_attacks     │
   │     не вызывается), мишени нет (simulate_ai_response — 4 ветки if).      │
   │     Любой прогон: 83 теста, 1 находка, 5.84 MEDIUM — при любых флагах.   │
   └──────────────────────────────────────────────────────────────────────────┘
```

---

## 13. Integration Context — GitLab, MCP, Duo Platform

### 13.1. Четыре независимых канала

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  1. GitLabClient — REST API v4, антикоррупционный слой                       │
│     create_branch · commit_file · create_mr · run_pipeline · comment_mr       │
│     PRIVATE-TOKEN из env GITLAB_TOKEN                                        │
│     ⚠️ GitLabMRActor::new() жёстко подставляет https://gitlab.example.com    │
├──────────────────────────────────────────────────────────────────────────────┤
│  2. MCP stdio server — `duo-agents mcp`            ✅ ПРОВЕРЕНО ПРОГОНОМ     │
│     initialize → {"name":"duo-agents","version":"0.1.0"}, protocol 2024-11-05│
│     tools/list → scan_codebase                                               │
│     Роль: система — MCP-СЕРВЕР для внешнего AI-клиента                       │
├──────────────────────────────────────────────────────────────────────────────┤
│  3. MCPBridgeActor — исходящий JSON-RPC                                      │
│     Формирует tools/call для create_jira_ticket                              │
│     ⚠️ payload печатается в stdout — транспорта нет, HTTP-клиента нет        │
│     Роль: система — MCP-КЛИЕНТ (недоделанный)                                │
├──────────────────────────────────────────────────────────────────────────────┤
│  4. Декларации для GitLab Duo Agent Platform                                 │
│     agents/redteam_agent.yml · flows/redteam_flow.yml                        │
│     docs/hackathon/custom-flow-config.yaml · .gitlab/duo/chat-rules.md       │
│     ⚠️ объявляют инструменты read_file/read_files, а не scan_codebase из     │
│        собственного MCP-сервера. Связи с движком нет.                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 13.2. Контракт CLI сломан именно на пути интеграции

`duo-agents init` генерирует пользователю `.gitlab-ci.yml`, ядро которого — строка:

```yaml
- duo-agents scan src/ --mr $CI_MERGE_REQUEST_IID --project $CI_PROJECT_ID
```

Ровно эта команда, выполненная собранным бинарником:

```
   $ duo-agents scan src/ --mr 42 --project 1
     error: unexpected argument 'src/' found
     Usage: duo-agents scan [OPTIONS]

   код возврата: 2
```

Подкоманда `scan` объявляет путь как **опцию** `--path` (`cli.rs:33`), а не позиционный
аргумент. Та же ошибка — в README (`./run.sh scan /path/to/code` работает только потому,
что `run.sh:49` переписывает позиционный аргумент в `--path "$TARGET"`; прямой вызов
бинарника из README не работает).

```
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  Головная функция проекта — «просканировать MR и опубликовать отчёт      │
   │  комментарием» — недоступна тем способом, которым проект сам предлагает  │
   │  её вызывать. Шаблон CI падает на первом же запуске с кодом 2.           │
   │  Рабочая форма: duo-agents scan --path src/ --mr N --project M           │
   └──────────────────────────────────────────────────────────────────────────┘
```

### 13.3. CI/CD

`.gitlab-ci.yml` объявляет четыре стадии и определяет два job'а:

```
   stages:                          job'ы:
     - build            ✅ build   (cargo build --release, артефакт бинарника)
     - test             ✗ пусто
     - security-review  ✗ пусто
     - deploy           ✅ pages   (dashboard/dist → public/, redteam.html → index.html)
```

README утверждает, что пайплайн выполняет «Test → cargo test» и «Security Review →
сканирует код на MR и публикует результат». Оба job'а отсутствуют. Система не сканирует
сама себя — при том, что это самый дешёвый способ обнаружить половину находок этого
документа.

---

## 14. Presentation Context — Axum и React

### 14.1. HTTP-поверхность (проверена curl'ом)

```
   ┌──────────────────────────────── Axum Router ────────────────────────────────┐
   │  GET  /api/health              ✅ {"status":"ok","version":"0.1.0",…}       │
   │  POST /api/scan                ✅ {path} → run_scan → ScanResult            │
   │  GET  /api/scans               ✅ история из Arc<Mutex<Vec<ScanResult>>>    │
   │  GET  /api/plugins             ✅ 8 SecurityPlugin: name + description      │
   │  GET  /api/graph               ⚠️ 16 узлов, 15 рёбер, ВСЕ isTainted=true,  │
   │                                   все position = (0,0) — чистая витрина     │
   │  POST /api/redteam             ✅ отчёт (см. REDTEAM.md)                    │
   │  GET  /api/redteam/plugins     ✅ 18 атак + 6 доменов                       │
   │  GET  /api/redteam/strategies  ⚠️ 12 стратегий, которые не исполняются     │
   │  GET  /ws                      ⚠️ 1 кадр CONNECTION_ESTABLISHED и тишина   │
   │                                                                             │
   │  fallback → ServeDir("dashboard/dist")                                      │
   │  layer    → CorsLayer::new().allow_origin(Any)  ⚠️ полностью открытый CORS  │
   └─────────────────────────────────────────────────────────────────────────────┘
```

Три замечания архитектурного уровня:

- **Нет DTO-слоя.** Хендлеры отдают доменные структуры через `serde_json::json!(result)`.
  Переименование поля в `Finding` — ломающее изменение публичного API. В терминах DDD
  Presentation здесь `Conformist` к домену, хотя должен быть `Open Host Service`
  с собственным опубликованным языком.
- **Persistence Context отсутствует.** `scan_results: Arc<Mutex<Vec<ScanResult>>>` живёт
  в памяти процесса; перезапуск стирает историю. Единственное, что переживает рестарт, —
  `ScanCheckpoint` и WAL, и те удаляются по завершении скана.
- **Открытый CORS плюс `POST /api/scan`, принимающий произвольный путь.** Любая страница
  в браузере пользователя может заставить сервер прочитать и вернуть содержимое кода
  с диска — `code_snippet` в `Finding` содержит фрагменты исходников. Для локального
  демо-сервера это допустимо; при выносе наружу — нет.

### 14.2. Dashboard

React 19 + Tailwind 4 + `@xyflow/react` + `dagre`, 11 файлов, 1 036 строк:
`App.tsx`, `GraphViewer.tsx`, `DashboardOverview.tsx`, `RiskGauge.tsx`, `ScanResults.tsx`.

Job `pages` копирует `dashboard/dist/*` в `public/`, затем `cp public/redteam.html
public/index.html` — публичной главной страницей GitLab Pages становится **red-team-демо**
(623 строки статики), а не дашборд сканера. Дублирующая копия тех же страниц закоммичена
и в корневой `public/` (плюс `demo_report.json` на 1.4 МБ и
`gitlabhq_vulnerability_report.md` на 946 КБ).

---

## 15. Поперечные механизмы

| Механизм | Файл | Идея | Статус |
|---|---|---|---|
| **Context Crossover** | `crossover.rs` | Сигнал × контекст (churn, coverage, seniority, critical path) → подавление FP | ✅ вызывается из `orchestrator.rs:138` |
| **AgentEdge** | `strategy.rs` | Explore ↔ Exploit: 0 находок → Explore, есть находки → Exploit | ✅ в `actors/security.rs` |
| **ContextProvider** | `fetcher.rs` | Порт источника кода: LocalFs / GitLab / Slack / GitLabIssue | ✅ в `swarm/ast_fix_agent.rs` |
| **Schema Migration** | `migration.rs` | `SecurityRuleV1 → V2` через `trait MigrateConfig<To>` | ✅ в `actors/security.rs:56` |
| **ValidationReport** | `telemetry.rs` | Отчёты с `Severity` и `fix_suggestion` | ✅ в `swarm/review_agent.rs` |
| **Blast Radius** | `blast_radius.rs` | BFS вверх, пороги 10 / 3 | ⚠️ только `demos/mod.rs:167` |
| **CircuitBreaker** | `a2a.rs` | Backpressure, окно 1 с | ⚠️ только `demos/mod.rs:183` |
| **EtsTable** | `a2a.rs` | Lock-free через `arc-swap` | ❌ 0 вызовов вне `a2a.rs` |
| **WalEngine** | `a2a.rs` | «Used by NodeBrokerActor to sync Dirty→Committed» | ❌ 0 вызовов; NodeBroker его не знает |
| **Policy Engine** | `policy_engine.rs` | Трёхуровневый merge Global → Enterprise → Project | ❌ недостижим |
| **Babylonian 60-Head** | `babylonian.rs` | 60 микро-акторов, каждый на один паттерн | ❌ недостижим |

**О Crossover стоит сказать отдельно** — это самая интересная доменная идея репозитория.
Технический сигнал (`SecuritySignal { vulnerability_type, confidence }`) сам по себе не
порождает алерт; он пересекается с контекстом файла, и только пересечение выше порога
даёт находку. Метафора взята из финансовых временных рядов (пересечение SMA и RSI как
сигнал к сделке). Это честный доменный сервис, и он действительно подключён.

Его же реализация показывает стадию проекта: контекст захардкожен через
`if mr_id == 400` (`orchestrator.rs:136`) — демонстрационные значения вместо запроса
к GitLab API и git history, что признано в комментарии.

**`DependencyAgent`** заслуживает такой же ремарки: он объявлен как «аудит зависимостей
(CVE)», а `cve_db` — вектор из семи литералов (`openssl`, `hyper`, `regex`, `chrono`,
`tokio`, `serde_yaml`, `atty`), захардкоженных в `new()`. Комментарий честно говорит
«в реальной системе — из RustSec Advisory DB». В логе прогона это выглядит как
`📦 Найдено 4 CVE-уязвимостей` — число, полученное пересечением семи литералов
с `Cargo.toml`.

---

## 16. Зависимости: 7 из 31 не используются

```
   crate               вхождений в src/     примечание
   ──────────────────────────────────────────────────────────────────────────
   syn                       0              только в комментариях; заявлен
                                            в README и AGENTS.md как движок AST
   ra_ap_hir                 0              ┐ три тяжёлых крейта rust-analyzer,
   ra_ap_ide                 0              ├ формирующих основную часть времени
   ra_ap_base_db             0              ┘ сборки, — не используются
   proc_macro2               0
   quote                     0
   futures_util              0
   ──────────────────────────────────────────────────────────────────────────
   ra_ap_syntax              1              ← реально используется
   ra_ap_edition             1              ← реально используется
   petgraph 8 · tabled 8 · glob 6 · base64 6 · serde_yaml 3
   colored 2 · arc_swap 1 · rayon 1
```

Удаление семи неиспользуемых зависимостей — механическая правка, которая заметно
сократит время сборки и снимет ложное впечатление от `Cargo.toml`, будто система
работает на инфраструктуре rust-analyzer.

---

## 17. Диагноз: зрелость по DDD

### 17.1. Что сделано по-настоящему хорошо

```
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  ✅ Двухфазная модель акторов                                            │
   │     Execute/Complete — не украшение, а рабочая конструкция. Изоляция     │
   │     отказа (lease), атомарность видимости (Dirty/Committed), единая      │
   │     точка публикации. Выдержана во всех 12 акторах без исключений.       │
   ├──────────────────────────────────────────────────────────────────────────┤
   │  ✅ Message как единственная валюта                                      │
   │     25 вариантов одного enum. Ни одного прямого вызова между акторами.   │
   ├──────────────────────────────────────────────────────────────────────────┤
   │  ✅ EntityKind как доменная классификация                                │
   │     Endpoint / DBQuery / Sanitizer прямо кодируют правило taint-анализа. │
   │     Три подсистемы читают один граф. Это не анемичная модель.            │
   ├──────────────────────────────────────────────────────────────────────────┤
   │  ✅ Четыре чистых порта                                                  │
   │     Actor · SecurityPlugin · ContextProvider · SecurityPhi.              │
   │     Узкие trait'ы, реестры Vec<Box<dyn …>>, никакого наследования.       │
   ├──────────────────────────────────────────────────────────────────────────┤
   │  ✅ Герметичность Red Team                                               │
   │     Контекст выделен настолько чисто, что выносится в крейт              │
   │     перемещением директории.                                             │
   ├──────────────────────────────────────────────────────────────────────────┤
   │  ✅ Педагогическая документация в коде                                   │
   │     Русскоязычные doc-комментарии с ASCII-разделителями секций.          │
   │     Конвенция заявлена в AGENTS.md и выдержана.                          │
   └──────────────────────────────────────────────────────────────────────────┘
```

### 17.2. Где архитектура расходится сама с собой

Дефекты упорядочены по последствиям, а не по объёму кода.

```
   ┌──────────────────────────────────────────────────────────────────────────┐
   │  ⚠️ 1. TAINT-АНАЛИЗ ДАЁТ ЛОЖНОЕ ОТРИЦАНИЕ НА СОБСТВЕННОМ ЭТАЛОНЕ  §8    │
   │     Файл, специально написанный как уязвимый, проходит проверку.        │
   │     Пять независимых звеньев цепи, каждое достаточно для отказа.         │
   ├──────────────────────────────────────────────────────────────────────────┤
   │  ⚠️ 2. ДЕТЕКТОР ДРИФТА МЁРТВ ОБЕИМИ ВЕТВЯМИ                       §9    │
   │     Семантическая: заголовок MR перезаписан на "AST Diff".              │
   │     Структурная: единственное правило не пересекается с производителями. │
   │     Проект называется Architecture Guardian.                             │
   ├──────────────────────────────────────────────────────────────────────────┤
   │  ⚠️ 3. РЕЖИМ FAIL-OPEN                                             §8    │
   │     read_to_string(...).unwrap_or_default() → нечитаемый файл           │
   │     превращается в пустой граф и вердикт «безопасно».                    │
   ├──────────────────────────────────────────────────────────────────────────┤
   │  ⚠️ 4. КОНТРАКТ CLI СЛОМАН НА ПУТИ ИНТЕГРАЦИИ                    §13.2  │
   │     Шаблон CI, который генерирует сам продукт, падает с кодом 2.        │
   ├──────────────────────────────────────────────────────────────────────────┤
   │  ⚠️ 5. ОБРАТНЫЙ ГРАДИЕНТ ОХВАТА СКАНЕРА                          §11.3  │
   │     Top-6 из 8: чем опаснее файл, тем больше проверок с него снимается.  │
   ├──────────────────────────────────────────────────────────────────────────┤
   │  ⚠️ 6. ДВА РАНТАЙМА, НЕ СВЯЗАННЫЕ НИЧЕМ                          §3.1   │
   │     Акторная платформа достижима только через `demo`.                    │
   │     Инструмент, который показывают, и инструмент, который работает, —    │
   │     разные. /ws в режиме serve молчит навсегда.                          │
   ├──────────────────────────────────────────────────────────────────────────┤
   │  ⚠️ 7. FAN-IN БАРЬЕР БЕЗ ВЫХОДА                                   §6    │
   │     AggregatedResult не формируется, если проверки прошли чисто.        │
   │     Терминальный актор в благополучном сценарии не получает ничего.      │
   ├──────────────────────────────────────────────────────────────────────────┤
   │  ⚠️ 8. 30 % КОДА НЕ ИСПОЛНЯЕТСЯ                                    §4    │
   │     28 модулей, 3 605 строк. Из них 23 в scan/ очерчивают контур         │
   │     другой, ненаписанной системы.                                        │
   ├──────────────────────────────────────────────────────────────────────────┤
   │  ⚠️ 9. ОДИН ТЕСТ НА 11 892 СТРОКИ                                       │
   │     При этом chat-rules.md требует: «Ensure new actors have              │
   │     corresponding test modules». Правило записано, не соблюдено.         │
   │     Бинарный крейт без [lib] — интеграционные тесты невозможны.          │
   ├──────────────────────────────────────────────────────────────────────────┤
   │  ⚠️ 10. ФИКСТУРЫ УЯЗВИМОСТЕЙ В РЕЛИЗНОМ БИНАРНИКЕ                       │
   │     test_api.rs / test_database.rs / test_frontend.rs объявлены          │
   │     как pub mod и компилируются в релиз. Плюс `fs::write` в ветке        │
   │     «DRY RUN», способный перезаписать исходники проекта (§1).            │
   ├──────────────────────────────────────────────────────────────────────────┤
   │  ⚠️ 11. 30 ВЫЗОВОВ .unwrap() ПРИ СОБСТВЕННОМ ЗАПРЕТЕ НА НИХ             │
   │     UnwrapPlugin помечает .unwrap() как находку; chat-rules.md его       │
   │     запрещает. Сканер найдёт 30 нарушений в себе.                        │
   └──────────────────────────────────────────────────────────────────────────┘
```

### 17.3. Оценка по осям

```
   Единый язык        ██████░░░░  6/10   Богатый, последовательный словарь. Минус
                                          за систематическое расхождение имён и дел
                                          (SemanticPhi, HirCallGraph, Trust Decay).

   Границы контекстов ████░░░░░░  4/10   Red Team выделен образцово. Scan и
                                          Orchestration разделены не замыслом,
                                          а отсутствием интеграции.

   Порты и адаптеры   ██████░░░░  6/10   Четыре хороших trait'а. Отсутствует порт
                                          к LLM; MCP-клиент обрывается на stdout.

   Доменное ядро      █████░░░░░  5/10   EntityGraph + EntityKind + Crossover —
                                          настоящая модель. Но распознаватель видов
                                          сущностей — три подстроки в имени.

   Агрегаты           ███░░░░░░░  3/10   MRState — вырожденный агрегат (одно поле).
                                          Инварианты нигде не защищены типами;
                                          fan-in барьер держится на константе.

   Целостность        ██░░░░░░░░  2/10   30 % кода не исполняется; две головные
                                          способности не работают; контракт CLI
                                          расходится с собственным CI-шаблоном.

   Тестируемость      █░░░░░░░░░  1/10   Один #[test]. Бинарный крейт без [lib].
```

**Общий диагноз.** Это **архитектурная витрина**, собранная под демонстрацию: инженерный
каркас высокого качества, к которому не подведены рабочие данные. Двухфазная акторная
модель, EntityGraph как общее ядро, Crossover как подавитель ложных срабатываний —
три по-настоящему сильные идеи, реализованные на уровне, достаточном для показа.

Углублённая проверка добавляет существенное уточнение. Дело не только в том, что
подсистемы не сведены в один конвейер. Дело в том, что **обе заявленные головные
способности — обнаружение taint-путей и обнаружение архитектурного дрифта — при запуске
не срабатывают ни разу**, и каждая не срабатывает по причине, укладывающейся в одну
строку кода: перезаписанный заголовок, несовпавший ключ словаря, отсутствующий в индексе
сток. Каркас цел; порваны провода.

Это, впрочем, и обнадёживающая часть диагноза: чинить нужно строки, а не архитектуру.

---

## 18. Расхождения документации и кода

Проект называется «Architecture Guardian» и обещает ловить дрифт. Ниже — дрифт,
накопленный в нём самом.

| Утверждение | Где написано | Что в коде |
|---|---|---|
| «Rust workspace с двумя крейтами: `duo-agents` и `duo-kan`» | `AGENTS.md` | В `Cargo.toml` нет `[workspace]`; директории `duo-kan/` не существует |
| «`duo-kan/src/scan/`, `.../policy_engine/`, `.../blast_radius/`» | `AGENTS.md` | Всё в `src/` единственного крейта |
| «Start with the AST: Use `syn` to parse Rust source files» | `AGENTS.md` | `syn` не используется ни строкой; только `ra_ap_syntax` |
| «`syn` + `ra_ap_*` (rust-analyzer APIs)» | `README.md`, Tech Stack | 3 из 5 `ra_ap_*` не используются; `syn` не используется |
| «HIR Call Graph» | `main.rs:22`, `ast_analyzer.rs:20` | Работа на CST; `ra_ap_hir` объявлен и не используется |
| «`duo-agents scan src/ --mr …`» | `README.md`, CI-шаблон в `main.rs` | `error: unexpected argument 'src/'`, код возврата 2 |
| «CI: Test → cargo test» | `README.md` | Стадия объявлена, job отсутствует |
| «CI: Security Review → сканирует MR» | `README.md` | Стадия объявлена, job отсутствует |
| «12 Actors» | `README.md`, `duo-agents info` | 12 рабочих + оркестратор, который тоже `impl Actor` |
| «KMeans Vector ANN» | `AGENTS.md` | 2 центроида-литерала; запрос — один из 2 фиксированных векторов |
| «Trust decay» | `blast_radius.rs` | На рёбрах `Calls` риск растёт ×1.667; отсечение недостижимо |
| «SemanticPhi (ML Context)» | `scan/phi.rs` | `RegexPhi` + `sleep(15 ms)` + переписанная строка описания |
| «Used by NodeBrokerActor to sync Dirty→Committed» | `a2a.rs:36` | `WalEngine` не вызывается нигде; NodeBroker о нём не знает |
| «в реальной системе — из RustSec Advisory DB» | `dependency_agent.rs` | 7 захардкоженных записей |
| «DRY RUN» | `actors/gitlab.rs:168` | Выполняет `fs::write` по путям `src/test_*.rs` |
| «`unsafe` требует `// SAFETY:`» | `.gitlab/duo/chat-rules.md` | Правило только для ревьюеров, в коде не проверяется |
| «Ensure new actors have corresponding test modules» | `.gitlab/duo/chat-rules.md` | 1 тест на весь репозиторий |
| Бейдж «License: MIT»; раздел `## License` пуст | `README.md` | `AGPL-3.0-only` в `Cargo.toml`, файл `LICENSE` — текст AGPLv3 |

---

## 19. Дорожная карта, вытекающая из самого кода

Порядок не произвольный: сначала то, что делает систему честной, потом то, что делает
её цельной.

```
   ┌── ЭТАП 0. ПОЧИНИТЬ ТО, ЧТО СЛОМАНО ОДНОЙ СТРОКОЙ ──── дни, не недели ───┐
   │                                                                          │
   │  0.1  ast_analyzer.rs:100 — передавать настоящий title вместо           │
   │       "AST Diff"           → оживляет семантический дрифт (§9.1)         │
   │  0.2  drift_detector.rs:151 — привести LogicalRule к источникам,         │
   │       которые реально порождаются ("Controller", "CustomJWT")            │
   │                            → оживляет структурный дрифт (§9.2)           │
   │  0.3  ast_analyzer.rs:48 — read_to_string(...) без unwrap_or_default:    │
   │       ошибка чтения → TxResult::Error, а не пустой граф (§8)             │
   │  0.4  cli.rs:33 — сделать path позиционным ИЛИ исправить CI-шаблон       │
   │       и README на --path                                    (§13.2)      │
   │  0.5  gitlab.rs:168 — убрать fs::write из ветки DRY RUN (§1)             │
   ├── ЭТАП 1. ВЕРНУТЬ ЗАЯВЛЕННУЮ СПОСОБНОСТЬ ──────────────────────────────┤
   │                                                                          │
   │  1.1  Строить Workspace из ВСЕХ файлов проекта, не только изменённых —   │
   │       иначе сток за пределами диффа не виден (§8, звено 1)               │
   │  1.2  Заменить подстрочное присвоение EntityKind на список правил        │
   │       (сигнатуры источников/стоков/санитайзеров в конфиге)  (§8, звено 4)│
   │  1.3  Обрабатывать MethodCallExpr наравне с CallExpr; учитывать          │
   │       макросы format!/write! как узлы потока данных         (§7.2)       │
   │  1.4  Добавить приёмочный тест: test_frontend.rs ДОЛЖЕН давать          │
   │       ровно одну находку SQL-инъекции. Это тест №2 в репозитории.        │
   ├── ЭТАП 2. СВЕСТИ ДВА РАНТАЙМА В ОДИН ──────────────────────────────────┤
   │                                                                          │
   │  2.1  Выделить [lib] рядом с [[bin]] → интеграционные тесты станут       │
   │       возможны в принципе                                                │
   │  2.2  Провести run_scan через акторный конвейер (ScanActor,              │
   │       принимающий ScanSecurity и отдающий Finding)                       │
   │  2.3  В server::run_server поднять акторов и подписать telemetry_tx      │
   │       → /ws перестанет молчать                              (§3.1)       │
   │  2.4  Дать fan-in барьеру ветку «всё чисто» и таймаут       (§6)         │
   │  2.5  Перенести fan-out из demos/mod.rs:108 в оркестратор   (§6)         │
   ├── ЭТАП 3. ПОЧИНИТЬ ИЗМЕРЕНИЯ ──────────────────────────────────────────┤
   │                                                                          │
   │  3.1  MoeRouter: top_k = 8 (то есть без отсечения) либо гарантировать    │
   │       always_on-экспертам место вне квоты                   (§11.3)      │
   │  3.2  SparseSecurityIndex::build() — один раз на прогон, не на файл      │
   │  3.3  risk_score: формула, чувствительная к количеству находок (§11.5)   │
   │  3.4  blast_radius: либо сделать decay затуханием, либо переименовать    │
   │       и убрать неработающее отсечение                       (§10)        │
   │  3.5  hardcoded-secrets: не считать находкой литералы внутри             │
   │       тестового корпуса                                     (§11.4)      │
   ├── ЭТАП 4. УБРАТЬ ДОЛГ ─────────────────────────────────────────────────┤
   │                                                                          │
   │  4.1  23 мёртвых подмодуля scan/ — в отдельную ветку или под             │
   │       #[cfg(feature = "experimental")]                      (§4)         │
   │  4.2  test_api/test_database/test_frontend → tests/fixtures/,            │
   │       под #[cfg(test)], вон из релизного бинарника                       │
   │  4.3  Удалить 7 неиспользуемых зависимостей                 (§16)        │
   │  4.4  Привести README и AGENTS.md в соответствие с кодом    (§18)        │
   │  4.5  Дописать job'ы test и security-review в .gitlab-ci.yml —           │
   │       система должна сканировать себя своим же бинарником                │
   └──────────────────────────────────────────────────────────────────────────┘
```

Пункт 4.5 стоит выделить: у проекта уже есть всё, чтобы стать своим первым пользователем.
`duo-agents scan --path src/ --mr $CI_MERGE_REQUEST_IID` в собственном пайплайне превратил
бы часть находок §17.2 в автоматически отлавливаемые.

---

## 20. Карта репозитория для навигации

```
duo-agents/
│
├── Cargo.toml                     31 зависимость (7 неиспользуемых) · AGPL-3.0
│                                  без [workspace] и без [lib]
├── README.md                      витрина хакатона (расхождения — §18)
├── AGENTS.md                      repo-level контекст для GitLab Duo
├── .gitlab-ci.yml                 4 стадии, 2 job'а
├── run.sh · build.sh              обёртки; run.sh:49 чинит контракт CLI
│
├── src/
│   ├── main.rs              348   объявление модулей + роутер CLI (8 команд)
│   ├── cli.rs               132   clap · ⚠️ path — опция, не позиционный (§13.2)
│   │
│   │   ── ЯДРО АКТОРНОЙ МОДЕЛИ ──────────────────────────────────────────────
│   ├── actor.rs             175   trait Actor · TxResult · spawn_actor_2phase
│   ├── protocol.rs          214   Message(25) · ActorLifecycle · DynBitMap
│   ├── models.rs            130   Entity · EntityKind · EntityGraph · BSpline
│   ├── orchestrator.rs      254   FlowOrchestratorActor · ws_handler
│   ├── demos/mod.rs         195   ЕДИНСТВЕННОЕ место запуска акторов
│   │                              ⚠️ fan-out ревьюерам живёт здесь, а не в оркестраторе
│   │
│   ├── actors/             1821   12 акторов
│   │   ├── ast_analyzer.rs        ⚠️ :48 fail-open · :100 теряет title
│   │   ├── security.rs            DFS taint · ⚠️ ложное отрицание (§8)
│   │   ├── drift_detector.rs      ⚠️ обе ветви мертвы (§9)
│   │   ├── gitlab.rs              REST v4 · ⚠️ :168 fs::write в «DRY RUN»
│   │   ├── mcp_bridge.rs          JSON-RPC → ⚠️ stdout, транспорта нет
│   │   ├── node_broker.rs         DynBitMap · Dirty/Committed
│   │   │                          ⚠️ :49 дельты вычисляются и выбрасываются
│   │   └── swarm/                 6 агентов; dependency_agent — 7 CVE-литералов
│   │
│   │   ── ПРОДУКТОВЫЙ ПУТЬ ──────────────────────────────────────────────────
│   ├── scan/               4833   31 подмодуль, из них 8 живых
│   │   ├── mod.rs                 run_scan · Finding · Severity · ScanSummary
│   │   ├── plugins.rs       386   8 SecurityPlugin (построчный текстовый анализ)
│   │   ├── phi.rs            83   ⚠️ SemanticPhi = RegexPhi + sleep(15 мс)
│   │   ├── moe_router.rs    132   ⚠️ Top-6 из 8 → обратный градиент (§11.3)
│   │   ├── dropout.rs        78   в конвейере Disabled → no-op (§11.2)
│   │   ├── checkpoint.rs · wal.rs   пишут в СКАНИРУЕМЫЙ каталог
│   │   ├── report.rs · graders.rs
│   │   └── ⚠️ 23 подмодуля недостижимы: dag, stream, dsl, crdt, ode,
│   │        quantize, lora_edge, forward_ad, reverse_ad, frozen_trainable,
│   │        fuzzy, gadt_rule, gravity, kv_cache, redshift, sparse_router,
│   │        surge_queue, tensor_profile, topk_sampler, what_if,
│   │        accel_detector, adaptive_grid, basis_cache        — 3 432 строки
│   │
│   ├── redteam/            2302   → подробно в REDTEAM.md
│   │
│   ├── server/mod.rs        218   Axum: 8 REST + /ws + ServeDir (без акторов!)
│   ├── mcp_server.rs        167   MCP stdio ✅ проверен прогоном
│   │
│   │   ── ПОПЕРЕЧНОЕ ────────────────────────────────────────────────────────
│   ├── semantic_engine.rs   150   ⚠️ CST, не HIR; текстовое сопоставление вызовов
│   ├── blast_radius.rs       85   ⚠️ decay, который усиливает (§10)   demo
│   ├── crossover.rs          64   подавление FP                        ✅
│   ├── strategy.rs          230   ScanEngine · AgentEdge               ✅
│   ├── fetcher.rs           120   ContextProvider ×4                   ✅
│   ├── migration.rs          67   SecurityRuleV1 → V2                  ✅
│   ├── telemetry.rs          91   ValidationReport                     ✅
│   ├── a2a.rs               123   CircuitBreaker ✅ · EtsTable ❌ · WalEngine ❌
│   ├── policy_engine.rs      50   ❌ недостижим
│   ├── babylonian.rs        101   ❌ недостижим
│   └── test_*.rs             22   ⚠️ фикстуры уязвимостей в релизе
│
├── dashboard/              1036   React 19 · Tailwind 4 · xyflow · dagre
├── public/                        статические демо + demo_report.json (1.4 МБ)
├── agents/redteam_agent.yml       Custom Agent для GitLab Duo
├── flows/redteam_flow.yml         Custom Flow для GitLab Duo
├── .gitlab/duo/chat-rules.md      правила ревью для Duo Chat
└── docs/
    ├── Arch/                      _pitch_deck · implementation_plan · walkthrough
    └── hackathon/                 custom-agent-prompt · custom-flow-config
```

---

## 21. Команды для самостоятельной проверки утверждений

Все команды — из `duo-agents/`, после `cargo build --release`.

**§3.1.** Акторы не запускаются в режиме `serve` (первое число — 0):

```bash
grep -c "spawn_actor_2phase" src/server/mod.rs src/demos/mod.rs
```

**§4.** Граф достижимости: 23 мёртвых подмодуля в `scan/`:

```bash
for m in $(grep '^pub mod' src/scan/mod.rs | sed 's/pub mod //;s/;//'); do printf '%-18s %s\n' "$m" "$(grep -rn "scan::$m\|\b$m::" --include='*.rs' src/ | grep -v "src/scan/$m.rs" | grep -v 'pub mod' | wc -l)"; done
```

**§7.2, §16.** `syn` только в комментариях; три `ra_ap_*` не используются:

```bash
grep -rn "\bsyn\b" --include='*.rs' src/; for c in ra_ap_hir ra_ap_ide ra_ap_base_db ra_ap_syntax; do echo "$c: $(grep -rn $c --include='*.rs' src/ | wc -l)"; done
```

**§8.** Ложное отрицание на эталонной уязвимости. Демо **обязательно** запускать не из
корня репозитория (§1):

```bash
mkdir -p /tmp/duodemo/src && cp src/test_*.rs /tmp/duodemo/src/ && (cd /tmp/duodemo && "$OLDPWD/target/release/duo-agents" demo 2>&1 | grep -E "Узлов:|прошёл проверку")
```

**§9.1.** Заголовок MR перезаписывается константой:

```bash
grep -n 'title: "AST Diff"' src/actors/ast_analyzer.rs
```

**§9.2.** Единственное правило дрифта не пересекается с порождаемыми рёбрами:

```bash
grep -n 'LogicalRule {' src/actors/drift_detector.rs; grep -n 'EdgeAdded' src/actors/ast_analyzer.rs
```

**§10.** «Trust decay» усиливает на рёбрах `Calls`:

```bash
grep -n "fn amplifier\|fn neutral\|fn dampener" src/models.rs; grep -n "new_risk > 0.1" src/blast_radius.rs
```

**§11.2.** Сканер детерминирован — dropout в конвейере отключён:

```bash
grep -n "fn production" -A 2 src/scan/dropout.rs
```

**§11.3.** Обратный градиент охвата — тот же код в «тихом» файле:

```bash
printf '// TODO: x\npub fn f(){ let s=String::from_utf8_unchecked(vec![]); }\n' > /tmp/quiet.rs && ./target/release/duo-agents scan --path /tmp/quiet.rs --format json -o /tmp/q.json >/dev/null 2>&1 && python3 -c "import json;print('тихий файл:',[f['plugin'].split(' [')[0] for f in json.load(open('/tmp/q.json'))['findings']])"
```

**§13.2.** Команда из CI-шаблона падает с кодом 2:

```bash
./target/release/duo-agents scan src/ --mr 42 --project 1; echo "код возврата: $?"
```

**§14.1.** WebSocket в режиме `serve` отдаёт один кадр и молчит:

```bash
./target/release/duo-agents serve --port 3111 & sleep 2; curl -s -i -N -H "Connection: Upgrade" -H "Upgrade: websocket" -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" http://127.0.0.1:3111/ws --max-time 6 | head -20; pkill -f "duo-agents serve --port 3111"
```

**§17.2, п. 9 и 11.** Один тест и тридцать `.unwrap()`:

```bash
echo "тестов: $(grep -rn '#\[test\]\|#\[tokio::test\]' --include='*.rs' src/ | wc -l); unwrap: $(grep -rn '\.unwrap()' --include='*.rs' src/ | wc -l)"
```

**§18.** Крейта `duo-kan`, заявленного в `AGENTS.md`, не существует:

```bash
grep -n 'workspace\|\[lib\]' Cargo.toml; ls duo-kan 2>&1
```

---

*Документ описывает состояние репозитория на коммите `3cfa5bf` (ветка `master`,
25 марта 2026). Числа получены из кода и из прогонов собранного бинарника, а не из
документации проекта. Прогоны выполнены вне рабочего дерева; репозиторий не изменён.*
