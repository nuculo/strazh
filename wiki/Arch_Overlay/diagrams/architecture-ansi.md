# RTAP — архитектура целиком, ANSI

> Единая терминальная проекция всей платформы, сведённая на одну страницу и
> доведённая до состояния as-built (грань №20 + SARIF report surface).
> Родственные проекции: [context-map-ansi.md](context-map-ansi.md) — карта контекстов,
> [as-built-flows-ansi.md](as-built-flows-ansi.md) — детальные потоки исполнения.
> Исходные тексты: [ARCHITECTURE.md](../ARCHITECTURE.md), [RTAP_AS_BUILT.md](../RTAP_AS_BUILT.md).
>
> Это «start here»: семь панелей, каждая с объяснением. Читать сверху вниз.

---

## 1. Что это, одним экраном

RTAP — **control plane**: единственная authority, которая опрашивает сменные
execution-харнессы (promptfoo, duo-static, duo-llm), нормализует их сырой вывод в
каноническую **Observation**, коррелирует в **Finding**, присваивает **Verdict** и
публикует отчёт. Frozen — сменный **intelligence META-harness**: он предсказывает,
какой probe запускать следующим, но никогда не выносит Verdict.

```text
╔══════════════════════════════════════════════════════════════════════════════╗
║  RedTeam Assessment Platform (RTAP)                            control plane   ║
╠══════════════════════════════════════════════════════════════════════════════╣
║                                                                                ║
║   DELIVERY          CLI · REST/OpenAPI · Web UI · MCP/GitLab                    ║
║      │                                                                         ║
║      ▼                                                                         ║
║  ┌────────────────────────────────────────────────────────────────────────┐  ║
║  │ CONTRACTS   JSON Schema · OpenAPI · versioned events · capability schema │  ║
║  ├────────────────────────────────────────────────────────────────────────┤  ║
║  │ DOMAIN      Campaign ▸ AssessmentRun ▸ EngineRun ▸ ProbeAttempt          │  ║
║  │             ▸ Observation ▸ Finding ▸ Verdict   (pure aggregates)        │  ║
║  ├────────────────────────────────────────────────────────────────────────┤  ║
║  │ APPLICATION validate · freeze snapshots · plan/start/cancel/resume       │  ║
║  │             normalize · fenced-commit · correlate · ask-frozen · report  │  ║
║  ├────────────────────────────────────────────────────────────────────────┤  ║
║  │ PORTS       EngineAdapter · TargetConnector · RunRepository              │  ║
║  │             ArtifactStore · SecretProvider · AuthorizationProvider       │  ║
║  │             EventSink · FrozenModelRuntime · ModelRegistry · Renderer    │  ║
║  ├────────────────────────────────────────────────────────────────────────┤  ║
║  │ INFRA       SQLite + FS artifacts  ·  (prod) PostgreSQL + S3 + KMS/Vault │  ║
║  └────────────────────────────────────────────────────────────────────────┘  ║
║      │                         │                          │                    ║
║      ▼                         ▼                          ▼                    ║
║  EXECUTION HARNESSES     INTELLIGENCE META-HARNESS   PERSISTENCE               ║
║  promptfoo · duo-static  frozen: world+model+laws    events · artifacts        ║
║  duo-llm (quarantined)   → advisory FrozenSignal     signed model registry     ║
╚══════════════════════════════════════════════════════════════════════════════╝
```

**Почему слои именно так.** Contracts — единственный способ, которым слои говорят
между собой (wire-объекты всегда несут `schema_version`). Domain — чистые
агрегаты без I/O. Application оркеструет, но не знает, SQLite под ним или Postgres:
всё внешнее спрятано за Ports. Это модульный монолит с process-workers, а не
микросервисы — брокер не вводится, пока не появятся несколько независимых
потребителей событий.

---

## 2. Шина медиации: как течёт один запуск

Control Plane — единственный мост между харнессами и intelligence. Ни один харнесс
не пишет напрямую в CampaignWorld; ни один сигнал frozen не становится Verdict.

```text
   CLI/API/UI/MCP
        │
        ▼
 ┌───────────────┐   candidate    ┌──────────────────┐   world+target   ┌──────────────┐
 │ Campaign      │──features────▶ │ Candidate Feature│──────────────────▶│ Frozen Model │
 │ Planner       │                │ Compiler → V60   │                   │ Runtime      │
 │               │◀───────────────┤ (CANDIDATE view) │◀───FrozenSignal───┤ .frz + .adp  │
 └──────┬────────┘   advisory     └──────────────────┘   utility/rank    └──────▲───────┘
        │ RecommendationBinding (validated, complete)                          │ signed
        ▼                                                                      │
 ┌───────────────┐   dispatch    ┌──────────────────────────────┐       ┌─────┴────────┐
 │ Run           │──────────────▶│ Replaceable Execution Harness│       │ Signed Model │
 │ Orchestrator  │               │  ┌────────┐ ┌──────────┐     │       │ Registry     │
 │               │               │  │promptfoo│ │duo-static│     │       └──────────────┘
 │               │  ┌ ─ disabled ─┼─▶│         │ │          │ ◀duo-llm quarantined
 └──────┬────────┘  until repaired│  └────┬───┘ └────┬─────┘     │
        │                         └───────┼──────────┼───────────┘
        │                    native evidence         │
        ▼                                 ▼          ▼
 ┌───────────────┐   raw→canonical  ┌──────────────────┐   artifact refs   ┌──────────────┐
 │ Observation   │◀─────────────────│ Anti-Corruption  │──────────────────▶│ Protected    │
 │ Normalizer    │                  │ Layer (per ACL)  │   (never bytes)   │ Artifact Store│
 └──────┬────────┘                  └──────────────────┘                   │ content-addr │
        │ commitFencedObservation()  ── ONE transaction ──▶ Observation +   └──────────────┘
        │                                                   CampaignEvent
        ├──────────────▶ ┌──────────────┐  aggregates 1..N  ┌──────────────┐
        │                │ Finding      │◀──────────────────│ Committed    │
        │                │ Correlator   │                   │ Observation  │
        │                └──────┬───────┘                   └──────┬───────┘
        │                       ▼                                  │ event
        │            ┌────────────────────────┐                    ▼
        │            │ Report Builder         │            ┌──────────────┐  replay
        │            │ JSON · Markdown · SARIF │            │ Campaign     │─────────▶ CampaignWorld
        │            └────────────────────────┘            │ Event Store  │           (graph+state+
        ▼                                                  └──────────────┘            memory+epoch)
 ┌───────────────┐
 │ Observation   │──committed evidence──▶ Observation Feature Compiler → V60 (OBSERVATION view)
 │ (canonical)   │                        telemetry · labels · drift
 └───────────────┘
```

**Ключевые границы.** `commitFencedObservation()` — единственный публичный путь
записи: Observation и CampaignEvent ложатся одной транзакцией, иначе не ложится ничего
(law `fenced-commit-is-a-single-transaction`). Два разных feature-компилятора и две
разные `feature_view` (`OBSERVATION` для совершённого, `CANDIDATE` для потенциального)
не взаимозаменяемы — это отдельный закон. Frozen сидит глубоко в петле планирования,
но его отказ лишь ухудшает адаптивность: Run продолжается на эвристике, а Verdict не
меняется (`worker-failure-does-not-change-verdict`).

---

## 3. Execution safety: admission → lease → effect → commit → settle

Самая тяжёлая часть системы. Каждый побочный эффект (обращение к таргету) идёт через
пять ворот. Идея: результат ровно один, даже при краше между любыми двумя шагами.

```text
   dispatch(request)
        │
        ▼
 ┌───────────────────────────────────────────────────────────────────────────┐
 │ ① ADMISSION — authorization ∘ concurrency, БЕЗ побочных эффектов           │
 │    authorizeeffect() fail-closed · reserve() concurrency slot              │
 │    precheck НЕ бампает lease generation (probe agrees with reserve)        │
 └───────────────────────────────┬───────────────────────────────────────────┘
                                 │ admitted
                                 ▼
 ┌───────────────────────────────────────────────────────────────────────────┐
 │ ② LEASE — взять аренду на attempt, bump generation                         │
 │    поздний результат от старой аренды отвергается (late-result-rejected)   │
 └───────────────────────────────┬───────────────────────────────────────────┘
                                 │ leased (generation = N)
                                 ▼
 ┌───────────────────────────────────────────────────────────────────────────┐
 │ ③ EFFECT — вызвать таргет через EngineAdapter                              │
 │    effect_id стабилен ТОЛЬКО для safe-retry (idempotent adapter)           │
 │    effect-start ≠ commit: старт записан до, исход — после                   │
 └───────────────────────────────┬───────────────────────────────────────────┘
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
        outcome=OK        outcome=FAILED     outcome=UNKNOWN
              │                  │                  │
              │                  │                  ▼  НЕ авто-retry.
              │                  │            ┌───────────────┐   RUNBOOK Part A:
              │                  │            │ quarantine +  │   человек решает по
              │                  │            │ decideRecovery│   той же таблице §6/§12
              │                  │            └───────────────┘
              ▼                  ▼
 ┌───────────────────────────────────────────────────────────────────────────┐
 │ ④ FENCED COMMIT — Observation + CampaignEvent, одна транзакция              │
 │    fencing проверяет generation: чужая/старая аренда → отказ, all-or-nothing│
 └───────────────────────────────┬───────────────────────────────────────────┘
                                 ▼
 ┌───────────────────────────────────────────────────────────────────────────┐
 │ ⑤ SETTLE — освободить то, что заняла admission (reservation)               │
 │    settlement releases what admission acquired · settled ≠ unattempted     │
 └───────────────────────────────────────────────────────────────────────────┘

 recovery: replay сохраняет РОВНО одну Observation и разрешение ASK ровно один раз.
```

**Почему это не «просто try/finally».** Между `②` и `④` процесс может умереть.
Fencing по номеру аренды (generation) гарантирует, что воскресший старый воркер не
допишет вторую Observation: его generation устарел, коммит отвергается целиком.
`UNKNOWN_EFFECT_OUTCOME` намеренно НЕ ретраится машиной — сетевой таймаут мог значить
«таргет уже получил payload». Это ручной разбор по [RUNBOOK.md](../../../rtap/RUNBOOK.md)
Part A. `ASK` (нужна аппрувалка оператора) — durable suspended continuation: переживает
рестарт и резолвится ровно один раз.

---

## 4. Петля решений: offline ↔ online

Как frozen учится и как его совет попадает (или не попадает) в запуск.

```text
        OFFLINE (обучение, вне критического пути)          ONLINE (планирование)
   ┌──────────────────────────────────────────┐      ┌──────────────────────────────┐
   │ committed Observations                    │      │ eligible candidates          │
   │        │ ObservationFeatureCompiler       │      │        │ CandidateFeatureComp │
   │        ▼  (OBSERVATION view V60)           │      │        ▼  (CANDIDATE view V60)│
   │ dataset-exporter · splits (by Target/     │      │ FrozenModelRuntime.rank()    │
   │ Campaign, temporal holdout)               │      │        │                     │
   │        ▼                                   │      │        ▼                     │
   │ evaluate → admission-gate ─┐               │      │ FrozenSignal: utility,       │
   │        │                   │ offline gate  │      │ saturation, drift, anomaly,  │
   │        ▼                   ▼               │      │ disagreement  (advisory!)    │
   │ model-artifact (.frz/.adp) │               │      │        │                     │
   └────────┼───────────────────┼───────────────┘      │        ▼                     │
            │ sign               │                      │ Planner mixer:               │
            ▼                    ▼                      │  control arm  ── никогда не   │
   ┌──────────────────┐  ┌──────────────┐              │  exploration arm  исчезают   │
   │ Model Signing    │  │ Promotion    │              │  mandatory probes ── нельзя   │
   │ Authority        │─▶│ Registry     │              │  заранкать в ноль            │
   │ keyid · rotation │  │ offline→     │              │        │ budget never exceeded │
   │ revocation       │  │ shadow→AB    │              │        ▼                     │
   └──────────────────┘  └──────┬───────┘              │ RecommendationBinding        │
                                │ admitted             │ (validated, names its epoch) │
                                └──────────────────────▶│──────────▶ dispatch (§3)     │
                                                        └──────────────────────────────┘
```

**Что охраняет обучение от самообмана.** Метки (labels) строятся политикой, которая
исключает `UNVERIFIED` и config-ignored результаты — «default-pass» duo никогда не
становится позитивной меткой (`unverified-data-is-not-a-positive-label`). Сплиты идут
по Target/Campaign с temporal holdout, чтобы модель не запоминала историю promptfoo.
Domain-адаптер обязан показать диагональный кросс-доменный прирост — иначе он
«специализируется» лишь номинально (`domain-adapter-requires-diagonal-gain`). В online
Planner обязан держать control- и exploration-плечи и не может выранкать mandatory
probe — иначе адаптивность выродится в эксплуатацию известного.

---

## 5. Жизненный цикл модели: подпись → promotion → допуск

Ни один вес не оценивается против неправильного layout, ни одна модель не admitted без
верной подписи.

```text
   train ──▶ ┌───────────────────────────────────────────────────────────────┐
             │ MODEL SIGNING AUTHORITY                                        │
             │   sign(digest) с keyid ─▶ подпись встроена, keystore по keyid  │
             │   rotation: старый ключ ещё verifiable · revoke: fail-closed   │
             └───────────────────────────────┬───────────────────────────────┘
                                             ▼
   ┌───────────────────────── PROMOTION REGISTRY (state machine) ─────────────────────┐
   │                                                                                   │
   │   REGISTERED ──offline gate──▶ OFFLINE_PASSED ──shadow gate──▶ SHADOW_PASSED      │
   │       │                             │  требует verified signature      │          │
   │       │                             │                                  ▼          │
   │       │                             │                            ──AB gate──▶ AB_PASSED
   │       │                             ▼                                  │          │
   │       └─ revoked key ──▶ BLOCKED ◀──┴──── stale featureSchemaVersion ──┘          │
   │                                          или stale taxonomyVersion → refuse       │
   └───────────────────────────────────────────┬───────────────────────────────────────┘
                                               ▼
                         MODEL_ADMITTED  (требует signing authority + свежий layout)
                                               │  admission runs BEFORE lease
                                               ▼        (worker-level concurrency precheck)
                                    assessment_runs — owning row для assessment_run_id
```

**Смысл гейтов.** Три независимых барьера — offline (метрики на holdout), shadow
(теневой прогон без влияния на Verdict, требует верной подписи) и A/B (сравнение с
действующей моделью). Ключ можно ротировать без потери проверяемости старых подписей;
отозванный ключ проваливает верификацию — и модель, прошедшая offline+shadow, всё равно
BLOCKED, если её ключ отозван. Модель со stale `featureSchemaVersion` или
`taxonomyVersion` отвергается: считать её против изменившегося layout нельзя.

---

## 6. Отчётные поверхности: JSON · Markdown · SARIF

Одна `ReportInput`, три рендерера, один инвариант: наружу уходит **ссылка на
доказательство, а не байты**.

```text
   committed Observations ─▶ correlateFindings() ─▶ Findings
        │  (id, targetId, probeId, verdict, evidenceRefs)      модель ВХОДА не имеет
        ▼                                                       поля для payload
   ┌──────────────────────── ReportInput ───────────────────────┐
   │ observations[] · findings[] · coverage?                     │
   └───────┬──────────────────┬──────────────────────┬──────────┘
           ▼                  ▼                      ▼
   ┌──────────────┐   ┌──────────────┐      ┌────────────────────────┐
   │ buildJson    │   │ buildMarkdown│      │ buildSarifReport()      │  ← НОВОЕ
   │ Report()     │   │ Report()     │      │ SARIF 2.1.0             │
   │              │   │              │      │  · result → logical     │
   │ + coverage   │   │ findings tbl │      │    location target:<id> │
   │   denominator│   │              │      │  · evidence → related   │
   │ (может       │   │              │      │    location rtap-artifact:│
   │  отказать)   │   │              │      │  · incomplete run →     │
   └──────────────┘   └──────────────┘      │    executionSuccessful=false│
           │                  │              └───────────┬────────────┘
           └──────────────────┴──────────────────────────┘
                              │
                              ▼
        LAW  redteam.artifact/public-report-never-inlines-payload  (implemented, 200 trials)
        «raw payload не появляется НИ в одном из трёх; SARIF при этом ссылается на каждый ref»

   производит:  npm run report -- --db=… --assessment-run-id=… --format=sarif
```

**Почему SARIF отдельно важен.** Это OASIS-стандарт, который глотает GitHub code
scanning и прочие инструменты — самая вероятная поверхность, которую RTAP публикует
наружу. Именно поэтому закон о невстраивании payload называет её первой. Target — это
LLM-эндпоинт или агент, а не файл, поэтому result указывает на `logicalLocation`
(`target:<id>`), а не на выдуманный `path:line`. Доказательства уходят как
`rtap-artifact:<ref>` в `relatedLocations` — content-addressed ссылка, никогда не байты.
Незавершённый по coverage прогон помечается `executionSuccessful=false` — тот же отказ,
что делает `buildAssessmentReport()`, на языке SARIF.

---

## 7. Границы доверия и реестр законов

```text
 ┌──────────────────────── ГРАНИЦЫ ДОВЕРИЯ ─────────────────────────┐
 │ Execution engines → evidence и native grading (не Verdict)        │
 │ Control Plane     → каноническая Observation / Finding / Verdict  │
 │ Frozen            → advisory planning signal, НИКОГДА не Verdict   │
 │ Artifact Store    → точный крипто-dedup (sha256), не FNV identity  │
 │ Event Store       → source of truth; world — replayable проекция   │
 │ Signing Authority → keyid+rotation; отзыв = fail-closed            │
 └───────────────────────────────────────────────────────────────────┘

 ┌──────────────── ARCHITECTURE LAW REGISTRY ────────────────┐
 │ 94 закона всего · 90 implemented (90 held, 0 failed)       │
 │ 4 pending — каждый с явной причиной:                       │
 │   frozen/aggregate-boundary-is-enforced    (Rust-side)     │
 │   frozen/state-change-advances-epoch       (Rust-side)     │
 │   run/committed-step-is-idempotent         (нет durable    │
 │                                             RunStep engine) │
 │   signing/kms-profile-round-trips          (нет live KMS)  │
 │                                                            │
 │ каждый implemented закон = seeded property test,           │
 │ replay через --seed=N.  `npm run laws` печатает всё,       │
 │ exit 1 при любом падении.  pending виден, не скрыт.        │
 └────────────────────────────────────────────────────────────┘
```

**Как читать реестр.** Закон — это исполняемый инвариант со стабильным ID, набором
рандомизированных trials и seed для реплея. Evidence-уровни честные: `✓/✗` — свойство
реально проверялось; `·` — pending с указанной причиной и фазой, которая его
разблокирует. «Счётчик не подделывается»: pending-закон намеренно виден, а не тихо
пропущен. Это же дисциплина, что в CI — `npm run laws` рядом с `npm test`,
`npm run typecheck` и `npm run build`.

---

### Легенда

```text
 ▶ ▼ ◀ ▲   направление потока данных
 │ ─ ┌ └   границы модуля / агрегата
 ╔ ═ ╚     внешняя граница платформы
 ┌ ─ disabled ─  duo-llm: путь есть, выключен до ремонта (real TargetProvider + grading)
 ← НОВОЕ   добавлено в этой ревизии (SARIF report surface)
```

Полные тексты и доказательства: [ARCHITECTURE.md](../ARCHITECTURE.md) (нормативная),
[RTAP_AS_BUILT.md](../RTAP_AS_BUILT.md) (as-built), [EXECUTION_SAFETY_RECOVERY.md](../EXECUTION_SAFETY_RECOVERY.md)
(панель №3), [FROZEN_INTEGRATION.md](../FROZEN_INTEGRATION.md) (панели №4–5).
