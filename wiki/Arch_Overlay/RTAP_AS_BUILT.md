# RTAP — снимок реализации по исходному коду (as-built)

> Статус: **source-grounded снимок реализации** (не заменяет нормативную архитектуру)
> Дата ревизии: 2026-08-31 (обновлено после planner CLI + authorityFor() wiring;
> критерий 13 declared→derived, ARCH_CLAUDE_TRANSFER.md §2, «грани» №9–15 — раньше)
> Снято с: commit `41c268b` (branch `main`, `rtap/`)
> Родительская архитектура: [ARCHITECTURE.md](./ARCHITECTURE.md)
> Execution Safety & Recovery HLD: [EXECUTION_SAFETY_RECOVERY.md](./EXECUTION_SAFETY_RECOVERY.md)
> ANSI-диаграммы потоков: [diagrams/as-built-flows-ansi.md](./diagrams/as-built-flows-ansi.md)
> Нормативная карта контекстов: [diagrams/context-map-ansi.md](./diagrams/context-map-ansi.md)

Этот документ фиксирует, что **реально существует в `rtap/src` и проверено законами**
на момент снятия снимка — в отличие от [ARCHITECTURE.md](./ARCHITECTURE.md), которая
остаётся нормативным целевым дизайном ("принято для поэтапной реализации"). По
собственному правилу пакета (`rtap/README.md`): *"если код и документы расходятся —
это баг одного из них"*. Раздел 9 ниже перечисляет конкретные расхождения, найденные
при составлении этого снимка.

Составлено параллельным чтением исходников по кластерам (event sourcing, execution
safety, адаптеры, decision loop, laws/schemas/artifacts, entry point) с последующей
сверкой перекрёстных ссылок; каждое утверждение ниже привязано к файлу/типу/тесту,
который его подтверждает.

---

## 0. Паспорт снимка

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ RTAP as-built @ 41c268b                                                     │
├─────────────────────────────────────────────────────────────────────────────┤
│ Модулей в src/           ~32 директории (+worker/, +execution/sandbox+     │
│                          approval-store), ~150 .ts файлов                  │
│ Architecture Laws        66 всего · 62 implemented · 4 pending              │
│ Фазы реализованы          0 · 1 · 2 · 3 · 4 · 4.5.1–4.5.4 · 5 · 6 · 7 · R    │
│ Phase 5 admission        ВСЕ 14 критериев §15 MET — впервые в истории       │
│                          репозитория (`1440378`); rollback drill теперь     │
│                          law-backed, не декларированное свидетельство       │
│ Продовые вызывающие      src/worker/ (execFile+SQLite, закрывает пробел 1) │
│ (два независимых bin/)   src/planner/ (materializer.advance()→dispatch,    │
│                          первый реальный читатель authorityFor())          │
│ Пост-имплементационный   9 раундов (target-scoping · миграции · fenced-     │
│ аудит — ЗАКРЫТ полностью commit API · outbox+materializer · evidence ·      │
│ (не в Roadmap)           auth+scheduler dispatch wiring ·                   │
│                          recommendation provenance · authorization-law      │
│                          coverage · campaign/target identity) + 1 CI-фикс   │
│ ARCH_CLAUDE_TRANSFER.md  §2.1–2.6 ВСЕ реализованы — список закрыт целиком   │
│ («грани» Arch_claude)    ещё одна, независимая серия самоаудита (№9–15):    │
│                          снапшот-верификация, privilege/env-scoping,        │
│                          durable ASK-approval — детали в §11 ниже           │
│ Тестов                   ~100 файлов (unit + integration slice)            │
│ CI                       rtap-ci.yml: typecheck → test → laws → build →     │
│                          npm audit --audit-level=high (vitest testTimeout   │
│                          30s — реестр законов пересёк порог 5s по умолч.)   │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 1. Слоистая карта модулей

```text
┌────────────────────────────────────────────────────────────────────────┐
│ worker/{promptfoo-worker,cli}.ts        │ planner/{run-once,cli}.ts        │
│ (bin/): реальный execFile,               │ (bin/): materializer.advance()  │
│ реальный файловый SQLite. Закрывает      │ → enumerate → rank → mix →      │
│ пробел 1 («ничто в src/ не вызывает      │ dispatch. Первый реальный        │
│ адаптер») — критерий 12 §15 MET.        │ читатель authorityFor() и        │
│                                           │ первый реальный поставщик        │
│                                           │ world/compilerDigest в           │
│                                           │ RecommendationProvenance.        │
└───────────────────────────────────┬──────┴───────────────────────────────┘
                                     │ два независимых bin/, оба зовут
                                     │ executeLeasedStep()/dispatchDecisions()
                                     │ поверх одних и тех же store'ов
┌────────────────────────────────────────────────────────────────────────┐
│               src/index.ts  — публичный barrel (граница API)           │
└───────────────────────────────────┬────────────────────────────────────┘
                                     │ ре-экспортирует всё ниже
┌────────────────────────────────────────────────────────────────────────┐
│ ПЕТЛЯ ПРИНЯТИЯ РЕШЕНИЙ  (features → candidates → planner → shadow →    │
│                          training → promotion)                         │
│  features/*  candidates/*  planner/*  shadow/*  training/*  promotion/*│
│  domain/{verdict, recommendation-binding, recommendation-provenance,   │
│          model-fit, native-metrics}                                    │
└───────────────────────────────────┬────────────────────────────────────┘
                                     │ читает историю, пишет решения
┌───────────────────────────────────┴──────────────┬─────────────────────┐
│ ИНСТРУМЕНТ-АДАПТЕРЫ                               │ DOMAIN-АДАПТЕРЫ     │
│ adapters/{duo-llm,duo-static,promptfoo}/           │ (frozen overlay)    │
│  {run, parse, evidence}                            │ domain-adapters/    │
│                                                     │  {matrix,metadata, │
│                                                     │   swap,registry}   │
└───────────────────────────────────┬──────────────┴─────────────────────┘
                                     │ ParsedObservation → commit
┌────────────────────────────────────────────────────────────────────────┐
│ EXECUTION SAFETY  (Фаза 4.5.1–4.5.4 + грани №12/14/15, gate — ВСЕ 14   │
│                    критериев §15 MET)                                  │
│ run-step-executor ← единственная семантика шага для всех поверхностей  │
│ admission · authorization(+receipts) · concurrency(-scheduler) ·       │
│ execution-attempt-store · effect(+receipts) · interceptor · envelope · │
│ reconciler/reconciliation · settle · dispatch(+HardeningConfig) ·      │
│ approval-store(PendingApprovalStore) · sandbox(SandboxProfile) ·       │
│ capability-decl · metrics                                              │
└───────────────────────────────────┬────────────────────────────────────┘
                                     │ fenced commit (одна транзакция)
┌────────────────────────────────────────────────────────────────────────┐
│ EVENT-SOURCED ДОМЕННОЕ ЯДРО                                             │
│ pipeline/{commit-fenced-observation,commit-observation,correlate,      │
│           report,observation-event,grader-disagreement}                │
│ observations/store · findings/store · runsteps/store                   │
│ events/{store,outbox(pruneDelivered)} → world/{state,reducer,replay,   │
│                                 materializer(+snapshot-verified),       │
│                                 snapshot,snapshot-store,binding,        │
│                                 fingerprint,graph-schema}               │
└───────────────────────────────────┬────────────────────────────────────┘
                                     │
┌────────────────────────────────────────────────────────────────────────┐
│ PLATFORM (сквозные)                                                     │
│ db/{connection,migrations} (SQLite+WAL) · schemas/index (Ajv2020) ·     │
│ artifacts/{store,filesystem-store,materialize} ·                        │
│ secrets/{provider,env-provider} · authz/{types,role-based-provider} ·   │
│ audit/{log,auditing-authorization-provider} ·                          │
│ laws/{registry,cli,rng,catalog/*}                                       │
└──────────────────────────────────────────────────────────────────────-─┘
```

Каждый горизонтальный слой соответствует одной фазе Roadmap ([ARCHITECTURE.md §9](./ARCHITECTURE.md#9-roadmap)):
Platform ⊂ Фаза 0, Event-sourced core ⊂ Фаза 4, Execution Safety ⊂ Фаза 4.5, Tool
Adapters ⊂ Фазы 1/6/R, Domain Adapters ⊂ Фаза 6, Decision Loop ⊂ Фазы 2/3/5.

---

## 2. Событийное ядро: outbox → инкрементальный материализатор

`aa07c62` заменил полный `replay()` на каждое чтение durable-курсором. `CampaignEventStore.append()`
пишет строку в новую таблицу `outbox` **в той же неявной транзакции**, что и сам
`campaign_events` insert (обе вставки безусловны, атомарность обеспечивает вызывающая
сторона — `commitFencedObservation()`). `CampaignWorldMaterializer.advance()` читает
`outbox.listUndelivered()`, свёрнутые через `reducer.applyEvent()`, и апсертит
`materialized_worlds` вместе с курсором `last_sequence` в одной транзакции.

Важные инварианты:

- **Курсор — это `materialized_worlds.last_sequence`**, отдельной cursor-таблицы нет.
- Дедупликация — по `eventId`/`appliedEventIds`, **не** по fingerprint.
- `fingerprint()` (sha256, без поля `generation`) используется только как *proof
  консистентности*: инкрементальный `advance()` обязан совпадать с полным `replay()` —
  это доказывает новый закон и симулированный краш/рестарт в
  `test/world/materializer.test.ts`.
- `replay()` **не deprecated** — это живой dual-purpose API: ground-truth oracle для
  всех fingerprint-эквивалентных тестов и прямой потребитель для `worldPositionOf` в
  shadow-ranking (`test/integration/event-sourced-world-slice.test.ts`).
- `graph-schema.ts` честно декларирует больше типов сущностей/связей (`Strategy`,
  `SecurityControl`, `Domain`, `ModelVersion`), чем реально производит текущий редьюсер
  (только `PROBE_TESTS_TARGET` / `TARGET_EXPOSES_FINDING`) — задокументированный, а не
  скрытый разрыв.
- **Открытый вопрос**: ни один файл этого кластера не показывает, кто вызывает
  `CampaignWorldMaterializer.advance()` из продового рантайма — все найденные вызовы
  находятся в тестах. Планировщик/адаптер, который реально его дёргает, вне
  прочитанных файлов (не подтверждено).

Полная диаграмма потока — [diagrams/as-built-flows-ansi.md §A](./diagrams/as-built-flows-ansi.md#a-событийное-ядро-outbox--инкрементальный-материализатор).

---

## 3. Execution Safety: fencing, авторизация, interceptor-план, effect-lifecycle

`ExecutionAttempt` — durable identity/fencing-запись: `leaseGeneration` копируется из
`RunStep` один раз в `start()` и никогда не меняется — это fencing-токен (не `attemptNo`).
`bindNativeResult()` реализует 5-точечный алгоритм fencing §7.2 и отклоняет late-результат
со старого lease (`STALE_LEASE_RESULT`); каждое отклонение пишется в `execution_quarantine`.

`evaluateAuthorization()` — чистый fail-closed пайплайн V→C→P→S (validate → capability
digest → policy via `RoleBasedAuthorizationProvider` → sandbox/egress policy);
`AuditingAuthorizationProvider` декоратором логирует и разрешения, и отказы.

`compilePlan()` строит детерминированный `InterceptorPlan` (сортировка по стадии +
`interceptorId`, `planDigest` не зависит от порядка входа) по фиксированным стадиям
`PRE_DISPATCH → POST_NATIVE_RESULT → PRE_NORMALIZATION → POST_OBSERVATION_COMMIT →
PRE_REPORT`; `SideEffectPolicy` не имеет варианта "произвольный код" — сам тип есть
контроль. `evaluateStageOutcomes()` — fail-closed для `SECURITY_CRITICAL`, fail-open с
диагностикой для `ADVISORY`.

Effect-lifecycle — 11-состояний, литеральная таблица переходов (незаконный переход
структурно невозможен). Терминал `UNKNOWN_EFFECT_OUTCOME` **никогда не авто-ретраится**
— ручное разрешение по `RUNBOOK.md`. `ConcurrencyScheduler` — не in-process лок, а
durable SQLite-резервация (`concurrency_reservations`), не снимаемая по таймауту lease.

**Уточнение к названию модуля**: `admission.ts` не гейтит отдельный dispatch, несмотря
на название — это статический report-чекер готовности всего Phase 5 (`evaluatePhase5Admission()`,
14 критериев §15 EXECUTION_SAFETY_RECOVERY.md). Реальные per-attempt гейты —
`evaluateAuthorization()`, `ConcurrencyScheduler.reserve()`, `evaluateStageOutcomes()`
для `PRE_DISPATCH`.

**Обновление: все 14 критериев §15 теперь MET (`1440378`, впервые в истории
репозитория).** Было 2 недостающих (promptfoo не подключён к hardening; feature-flag/
rollback drill) — оба закрыты, но не по отдельности, а последовательно: критерий 12
закрылся первым (`260cc95`, продовый `src/worker/`, см. §6 ниже), и только тогда стало
возможно честно закрыть критерий 14 — иначе flag/drill проверял бы несуществующий
продовый путь. `admitDispatch()` получил `HardeningConfig{authorizationEnforced:boolean}`;
`HARDENING_ENFORCED` (`{authorizationEnforced:true}`) — единственное значение, которое
использует любой реальный вызывающий. При `authorizationEnforced:false` пропускается
**только** `evaluateAuthorization()`: резервация конкурентности остаётся безусловной, а
`bindNativeResult()` (fencing, Фаза 4.5.1) этот конфиг вообще не принимает — структурно
не может его достичь. `DispatchGuardResult.authorizationReceipt` стал nullable — честно
`null` при обходе, а не сфабрикован. Критерий 14 теперь law-backed
(`redteam.execution/rollback-disables-authorization-not-fencing`), а не декларированное
свидетельство.

**Та же конверсия применена к критерию 13 (`5433987`).** Он и раньше был `MET`
(`RUNBOOK.md` существует с Фазы 4.5.2), но через `extraEvidence.runbookExists: true` —
человек утверждает факт, ничто его не проверяет. Новый закон
`redteam.platform/runbook-covers-unknown-effect-outcome` читает `RUNBOOK.md` прямо с
диска (путь через `import.meta.url`, не `process.cwd()` — одинаково работает под
`npm test` и `npm run laws` независимо от директории запуска) и требует три маркера:
`UNKNOWN_EFFECT_OUTCOME`, именованный раздел "Part A", и слово "operator" —
свидетельство ручной процедуры, а не случайного упоминания. Закон доказывает
собственную различающую способность инлайн: прогоняет ту же логику маркеров против
синтетического неполного текста и падает, если это не поймано, — той же формы
самопроверка, что у `redteam.finding/every-finding-has-observation`. Проверяет
именно то, что `RUNBOOK.md` упоминает нужное, а не что встроенные в него код-сниппеты
всё ещё типизируются против реального API — это означало бы компилировать каждый
fenced code block, отдельная, более крупная задача. `AdmissionExtraEvidence` лишился
поля `runbookExists` целиком.

**Audit #7 (`d398a9b`, после снятия исходного снимка)**: `evaluateAuthorization()` и
`ConcurrencyScheduler` существовали как независимые, протестированные механизмы с Фазы
4.5.3, но ничто не композировало их вместе — это честно фиксировалось в README.md трижды
подряд по мере продвижения фаз. Новый `src/execution/dispatch.ts::admitDispatch()`
закрывает разрыв: создаёт `ExecutionAttempt` (это и есть `ADMITTED`) → `evaluateAuthorization()`
→ при успехе `ConcurrencyScheduler.reserve()` с реальным (не placeholder)
`executionAttemptId`; отказ на любом шаге сразу терминализирует attempt точной причиной
(`AUTHORIZATION_DENIED`/`TARGET_UNAVAILABLE` — оба значения существовали в типах с
4.5.1/4.5.2, но ничего их не выставляло до этого коммита). `commitFencedObservation()`
получил опциональный `dispatchGuard`, освобождающий резервацию **только на success-пути**,
внутри той же транзакции — на reject-ветке резервация НЕ освобождается (это первопричина
нового пункта в RUNBOOK.md, см. ниже). Новый закон
`redteam.execution/dispatch-admission-composes-authorization-and-concurrency` (реестр
на тот момент — 53 закона; текущий счёт см. в разделе 7). Следом потребовался CI-фикс (`e4d923f`): реестр законов
пересёк ~50 штук и стал упираться в дефолтный vitest `testTimeout: 5000` на GitHub
Actions (устойчиво укладывался локально) — `vitest.config.ts` поднимает лимит до 30s.

**Новый операционный разрыв, которого не было до audit #7**: `EffectReconciler` вообще
не знает о `ConcurrencyScheduler`, а `commitFencedObservation()` освобождает резервацию
только при успешном коммите с переданным `dispatchGuard`. Любой attempt, завершившийся
иначе (`FAILED_BEFORE_EFFECT`, `UNKNOWN_EFFECT_OUTCOME`, `CANCELLED`, отклонённый bind),
оставляет свою резервацию активной навсегда — ничто её не освобождает автоматически.
`RUNBOOK.md` теперь описывает это как отдельную процедуру (Part B), поскольку это тот же
класс проблемы, что и `UNKNOWN_EFFECT_OUTCOME`: платформа сознательно не гадает, а ждёт
явного решения оператора.

Диаграммы состояний — [diagrams/as-built-flows-ansi.md §B](./diagrams/as-built-flows-ansi.md#b-effect-lifecycle-state-machine).

**Sandbox: privilege/env-scoping (грань №15, `3d2672d`).** До этого коммита `defaultExec()`
во всех трёх адаптерах звал `execFile(bin, args, {cwd, maxBuffer})` без `env` и без
uid/gid — дочерний процесс наследовал полное окружение и привилегии воркера.
Взвешено против контейнерного рантайма и Linux seccomp/namespaces — оба добавляют
жёсткую новую зависимость, которой у проекта иначе нет; выбран privilege/env-scoping
через собственные опции `node:child_process`. `src/execution/sandbox.ts`:
`SandboxProfile{env, uid?, gid?}`, `minimalSandboxProfile()` (только `PATH` — безопасный
дефолт даже без конфигурации), `scopedExecOptions()` — чистая функция, на которую теперь
делегируют все три `defaultExec()`. `sandboxProfileRef`/`egressPolicyRef` в
`AuthorizeEffectRequest` остались нетронутыми (это ссылки для авторизации, а не
исполняемая конфигурация) — `worker/promptfoo-worker.ts` получил отдельное поле
`sandbox?: SandboxProfile`, и это единственный сегодня реальный потребитель.

**Approval: ASK как durable, re-leasable запрос (грань №12, `09e5ff6`).** Первая версия
идеи моделировала неразрешённое решение как подвешенный in-memory `Promise` — не
подходит RTAP: такой `Promise` не переживёт рестарт воркера, а это гарантия, которую
здесь даёт всё остальное. Адаптировано под уже существующий в `admitDispatch()`
паттерн «нельзя решить сейчас, попробуй позже» — `CONCURRENCY`-бэкграунд, который не
пишет запись об исполнении и оставляет RunStep перелизуемым (§2.2 выше).
`admitDispatch()` получил опциональный `ApprovalGate{policy, approvals}`;
`ApprovalPolicy.requiresApproval()` — чистый синхронный предикат, никакой приостановки
нигде. Проверка идёт **после** авторизации — никогда для запроса, который и так был бы
отклонён. Новая ветка `DispatchGuardResult.stage === 'ASK'` не пишет запись об
исполнении, как и `CONCURRENCY`. `PendingApprovalStore` (миграция 5, `pending_approvals`,
`run_step_id UNIQUE`) — источник истины для решения при повторном лизе.

**Снапшот-верификация материализатора (грань №14, `c9fdc2a`).** `snapshotWorld()`/
`verifySnapshot()` (Фаза 7) были доказанно корректными чистыми функциями без
долговечного места — ровно то, что фиксировал предыдущий проход этого документа как
незакрытый разрыв (см. историю правок). Миграция 4 добавляет `world_snapshots` (по
строке на кампанию, конвенция та же, что у `materialized_worlds`); `SnapshotStore`
повторяет существующий паттерн store. `advance()` теперь снапшотит атомарно в той же
транзакции, что и запись `materialized_worlds`, но только когда `eventsApplied > 0`.
`current()` верифицирует десериализованный мир против снапшота и откатывается на полный
`replay()` при ошибке `JSON.parse()` или расхождении — вместо броска или возврата
повреждённых данных. Самоисцеление бесплатное: `advance()` сам вызывает `current()`
внутри себя, поэтому следующий реальный `advance()` после повреждения персистит верные
данные как побочный эффект своего обычного пути записи.

---

## 4. Адаптеры инструментов и слой Evidence (audit #5)

| Адаптер | Оборачивает | Capability gate | Verdict | Evidence (`evidence.ts`, `c913ac6`) |
|---|---|---|---|---|
| `duo-llm` | `duo-agents redteam` (симуляция атак, stub-ответы) | ДА — все 4 declared caps=false ⇒ всегда отклонён pre-dispatch | всегда `UNVERIFIED` (18 плагинов, реальный грейдер лишь у 4; остальные — `UNGRADED_SENTINEL`) | `prompt→payload`, `response→response`, `report→native-report` (дедуп по report) |
| `duo-static` | `duo-agents scan` (regex/substring, **не** AST/taint despite docs) | нет — идёт безусловно | всегда `UNVERIFIED` ("кандидат для review, не graded результат") | `code_snippet→snippet` (только если реально есть), `scan→native-report` (дедуп по scan) |
| `promptfoo` | `promptfoo redteam run` (LLM-judge rubric grading) | нет | реальный `deriveVerdict()` из `gradingResult` (`pass:true` = цель устояла) | весь result JSON → `native-report` (не fallback — единственное доступное свидетельство) |

До `c913ac6` все три адаптера производили **синтетические** `evidenceRefs`
(`"duo-llm:${reportId}:${index}:prompt"` и т.п.), которые не резолвились никуда —
`ArtifactStore` (Фаза 7) и `parse.ts` каждого адаптера существовали параллельно, не
подключённые друг к другу. Новый `materializeEvidence()` (`artifacts/materialize.ts`) —
тонкий batching-хелпер поверх `ArtifactStore.put()`, которым обёрнут каждый
`evidence.ts`; он заменяет синтетические ссылки на реальные content-addressed
`local:sha256:<hex>`. Новый закон `redteam.artifact/adapter-evidence-is-really-stored`
доказывает, что каждый возвращённый ref резолвится через `store.get()` в те же байты,
а идентичные тела байтов из разных вызовов/campaign сходятся к одному ref.

**Открытый вопрос**: интеграционные slice-тесты (`duo-llm-remediation-slice.test.ts`,
`duo-static-and-domain-adapter-slice.test.ts`) коммитят вывод `parse*` напрямую, с
синтетическими ссылками, и не вызывают новый `evidence.ts` — точка стыковки evidence-шага
с `commitFencedObservation()` в продовом пайплайне существует как код, но пока не
демонстрируется сквозным тестом.

Диаграмма потока evidence — [diagrams/as-built-flows-ansi.md §C](./diagrams/as-built-flows-ansi.md#c-evidence-materialization-flow).

---

## 5. Domain-адаптеры (Frozen overlay-модели)

Отдельная от адаптеров инструментов концепция ([FROZEN_INTEGRATION.md §8.4](./FROZEN_INTEGRATION.md)):
специализированная модель-оверлей поверх общего "core", а не преобразование форматов
вывода пробов.

- `evaluateAdapterAdmission(matrix, adapterRef, ownDomain)` требует `ownDomainGain > 0.02`
  **и** каждый `offDomainGain ≤ 0.0` — "бесплатный" адаптер, лучший на всех доменах
  сразу, отклоняется явно (это универсально лучшая модель, а не специалист).
- `evaluateSwapTiming()` разрешает только `RUN_BOUNDARY`; `MID_RUN` всегда отклонён —
  нет доказательства, что живой `CampaignWorld` переживёт смену модели на лету.
- `isOverlayOnly(metadata) ⇔ reassignEvery === 0` — переприсваивающий адаптер никогда не
  становится активным оверлеем (иначе мутирует core identity).
- `DomainAdapterRegistry` — единственная точка принудительного применения всех трёх
  проверок; каждая попытка (успех/отказ) логируется в `domain_adapter_log`.

Диаграмма — [diagrams/as-built-flows-ansi.md §D](./diagrams/as-built-flows-ansi.md#d-domain-адаптер-admission-flow).

---

## 6. Петля принятия решений: features → planner → shadow → training → promotion

Сквозной инвариант всей петли — `targetProbeKey(targetId, probeId) =
JSON.stringify([targetId, probeId])` (не `${targetId}:${probeId}`, т.к. `probeId` сам
легально содержит `:`), введённый аудитом `f029975` и пронизывающий eligibility,
dispatch, A/B-join и utility-лейблинг.

**Провенанс vs staleness (audit #3, остаток, `31649ed`).** Решение планировщика по
model-арму несёт два независимых объекта, и их разделение принципиально:
`RecommendationBinding` — композитный ключ строгого равенства, и только он через
`decideExecution()` решает, устарела ли рекомендация; `RecommendationProvenance`
(`worldFingerprint`, `featureDigest`, `compilerDigest`, `createdAt`/`expiresAt`) —
запись происхождения, которая **никогда не сравнивается на равенство** и вторым гейтом
не является (та же связь, что у `approvedAt`/`expiresAt` с идентификационными полями
`AuthorizationReceipt`). `worldFingerprint` здесь делает обнаружимым то, что
`(worldGeneration, worldEpoch)` лишь предполагает невозможным: две разные истории
событий, пришедшие к одной позиции. `candidateId`, `modelGeneration` и
`targetSnapshotRef` из списка аудита сознательно **не добавлены** — реальных источников
для них в коде нет (кандидат идентифицируется только парой `(targetId, probeId)`, модель
— только `modelDigest`), и разрыв задокументирован вместо фабрикации поля.

**Первый реальный вызывающий этой петли (`41c268b`, `src/planner/run-once.ts`).**
`authorityFor()` — из `promotion/types.ts`, доказывающий, что «модель не может
продвинуть себя сама» — до этого коммита читался только собственным юнит-тестом;
`mixCandidates()`/`dispatchDecisions()` не имели продового вызывающего вообще.
`runPlannerOnce()` закрывает оба разрыва одной композицией: `materializer.advance()`
→ `enumerateEligibleCandidates()` → `rankCandidates()` (heuristic — всегда; модель —
только если `authorityFor(modelState).rankAndLogCandidates`, причём `modelState`
читается из **реального** `ModelPromotionRegistry`, а не из конфига вызывающего,
которому нельзя доверять честно сказать о себе "OFF") → `mixCandidates()` (модельный
ранкинг попадает сюда только при `influencesRunStepCreation`; `modelShareCap`
снимается только при `!boundedShare`, и снимается не произвольно, а до
`1 - explorationShare` — максимума, который `validatePolicy()` вообще допускает) →
`dispatchDecisions()`. Это же первый вызов, где `mixCandidates()` получает настоящий
`world`/`compilerDigest` (`BindingContext`) — значит `RecommendationProvenance` из
предыдущего абзаца теперь реально населяется, а не остаётся `null` навсегда; и первый
вызов, где `dispatchDecisions()`'s `schedule`-параметр (§2.4, знаменатель покрытия)
передаётся по-настоящему (`{events, campaignId}`), а не опускается. `planner/cli.ts`
— тонкий bin/ по тому же паттерну, что `worker/cli.ts`; вес модели приходит через
`--config` JSON-файлом, потому что `SignedModelArtifact` хранит только sha256-дайджест
весов, не сами веса — они нигде не персистятся durable, честный разрыв, названный в
докстринге нового `loadFittedLinearModel()`.

Offline: `buildHistoryView()` → `compileCandidateFeatures()` (V60-вектор, вид CANDIDATE
структурно не содержит grading/response/runtime — утечка невозможна) → `exportDataset()`
→ `computeUtilityLabel()` (target-scoped, тот самый аудит-фикс) → `splitByTarget/
byCampaign/byTime/byVulnerabilityClass` (holdout целыми группами) → baselines (`fixed-order
· heuristic · linear-regression · random`; `tree-boosting/mlp/frozen-kan` — явно
`NOT_IMPLEMENTED_BASELINES`) → `evaluate()` (Spearman rank correlation — именно её
использует planner) → `evaluateAdmissionGate()` (должен побить лучший ИЗ РЕАЛИЗОВАННЫХ
baseline) → `packageLinearModelArtifact()` (`signature:'UNSIGNED'` — органа подписи нет)
→ `ModelPromotionRegistry.admit()`.

Online (per Target): `enumerateEligibleCandidates()` → `mixCandidates()` (mandatory →
exploration → model [≤`modelShareCap`, каждый проверен `decideExecution()`, stale
отбрасывается] → heuristic) → `dispatchDecisions()` (idempotency-key включает `targetId`
— аудит-фикс, пишет в `planner_dispatch_log`) → исполнение адаптером → `commitFencedObservation()`
→ `joinDispatchWithOutcomes()` → `computeArmPerformance()` → `evaluateABGate()` (model vs
heuristic-control) → `PROMOTE/DEMOTE/HOLD`.

`rankCandidates()`/`buildCounterfactual()`/`ShadowRankingStore` работают параллельно и
**никогда не касаются `RunStepStore`** — доказано явно (`shadow-scoring-slice.test.ts`:
счётчик `RunStep` не меняется).

**Сигналы кампании (Фаза 5, `604112e`).** `FrozenSignal.kind` перестал быть одиночным
литералом `'PROBE_UTILITY'` и стал union'ом `FrozenSignalKind` из шести значений
(FROZEN_INTEGRATION.md §5.4). Ключевое архитектурное свойство: из шести только
`PROBE_UTILITY` производится обученной моделью — четыре новых
(`computeSaturation`, `computeTargetDrift`, `computeRiskTrend`,
`computeGraderDisagreement`) это **детерминированные вычисления** над тем же
CampaignWorld/Observation-субстратом, с `modelRef` вида `deterministic:<name>-v1`, то
есть «достижение F5 не требует второй обученной модели» — прямая цитата из §5.4.
Седьмое значение `ANOMALY` сознательно **не** заведено (нет механизма детекции,
вынесено за отдельный Research-гейт §12), шестое `RETEST_PRIORITY` объявлено в union'е,
но производителя не имеет — эпизодическая память `GraphMessage` не реализована. Оба
разрыва задокументированы, а не замаскированы.

**Promotion state machine**:

```text
 Успешный путь:
   OFF --MODEL_ADMITTED--> SHADOW --OFFLINE_AND_SHADOW_GATES_PASSED--> EXPERIMENTAL
       --AB_GATES_PASSED--> CALIBRATED

 Откаты/отказы:
   SHADOW       --ARTIFACT_OR_SCHEMA_INVALID------> OFF
   EXPERIMENTAL --SAFETY_OR_COVERAGE_REGRESSION---> SHADOW
   CALIBRATED   --DRIFT_OR_QUALITY_REGRESSION-----> SHADOW
   CALIBRATED   --INTEGRITY_OR_POLICY_FAILURE-----> OFF
```

| Состояние | rankAndLogCandidates | influencesRunStepCreation |
|---|---|---|
| OFF | false | false |
| SHADOW | true | false |
| EXPERIMENTAL | true | true (≤ `modelShareCap`) |
| CALIBRATED | true | true (без этого cap) |

Полная диаграмма петли — [diagrams/as-built-flows-ansi.md §E](./diagrams/as-built-flows-ansi.md#e-петля-принятия-решений-offline--online).

---

## 7. Laws — фактический реестр

`src/laws/types.ts` определяет собственный (не сторонний) property-based фреймворк:
`Law{id, statement, status, trials, check?}`, детерминизм структурный
(`mulberry32(seed)` + `trialSeed(seed, trial)` в `rng.ts` — одинаковый seed/trial всегда
даёт один и тот же контрпример). `npm run laws` (`cli.ts`) гоняет весь реестр, печатает
`✓`/`✗`/`·`, при провале — до 3 неудачных trial с JSON-контрпримером; код выхода `1` при
любом провале, что и гейтит `rtap-ci.yml`.

| Каталог | Laws | Что охраняет |
|---|---|---|
| `frozen.laws.ts` | 9 (7 impl / 2 pending) | детерминизм/идемпотентность replay CampaignWorld; model/adapter fit |
| `planner.laws.ts` | 7 | stale-рекомендации отклоняются, mandatory не выкидывается, target-scoped кандидаты не сливаются, провенанс рекомендации не фабрикуется |
| `platform.laws.ts` | 13 (11 impl / 2 pending) | capability-гейтинг, миграции схемы, эквивалентность outbox↔replay (включая прунинг по водяному знаку), знаменатель покрытия не подразумевается, campaign/target identity согласованы сквозь БД→history-view→enumerate, RUNBOOK.md реально покрывает UNKNOWN_EFFECT_OUTCOME (читает файл с диска, не декларация) |
| `production-profile.laws.ts` | 5 | content-addressed артефакты, tenant-изоляция, evidence реально сохраняется (audit #5) |
| `shadow.laws.ts` | 2 | shadow-скоринг не роняет пайплайн / не создаёт RunStep |
| `campaign-signals.laws.ts` | 4 | сигналы кампании: saturation, target drift, risk trend, grader disagreement |
| `domain-safety.laws.ts` | 4 | verdict нельзя "обыграть" (ungraded никогда не становится RESISTANT) |
| `execution-safety.laws.ts` | 18 | fencing, effect-lifecycle, authz-до-effect (теперь доказывает точную причину отказа, не только факт), эксклюзивность конкурентности, атомарность commit, композиция authorization+scheduler в dispatch (audit #7), расчёт освобождает захваченный барьер, rollback-drill отключает только authorization (§15 критерий 14) |
| `domain-adapters.laws.ts` | 2 | нет "бесплатного" универсального адаптера; overlay-only не reassign'ит |
| `features.laws.ts` | 2 | CANDIDATE-вид не содержит post-hoc сигнала |
| **Итого** | **66** | **62 implemented · 4 pending** |

4 pending: `redteam.frozen/state-change-advances-epoch` и
`redteam.frozen/aggregate-boundary-is-enforced` (заблокированы на реальном Rust-фасаде
`FrozenService` из `frozen/`), `redteam.artifact/public-report-never-inlines-payload`
(рендерер отчётов ещё не существует), `redteam.run/committed-step-is-idempotent`
(формально устарел по духу — перекрыт более новыми execution-safety законами, но не
удалён).

---

## 8. Platform: schemas, artifacts, миграции

`schemas/index.ts` использует **Ajv 2020** + `ajv-formats` на одном общем инстансе,
регистрируя все 10 `*.schema.json` по `$id` для взаимных `$ref` (`rtap:common#/$defs/...`).
`artifacts/store.ts` — абстрактный порт (`put/get/exists`, `EvidenceKind`), сознательно
async-only, т.к. продовый профиль — S3-совместимое хранилище; `filesystem-store.ts` —
локальная реализация, content-addressing `local:sha256:<hex>`, путь строится только из
хэша (traversal исключён конструктивно); `materialize.ts` — не отдельное хранилище, а
batching-обёртка поверх `store.put()` (см. §4).

`db/migrations.ts` (`c06eab0`) заменил `CREATE TABLE IF NOT EXISTS` на реестр
`MIGRATIONS: readonly Migration[]` с таблицей `schema_migrations`, каждая миграция — в
своей транзакции; `UnsupportedSchemaVersionError`, если БД впереди известного коду
списка миграций — отказ атомарен, происходит до запуска любой миграции.

---

## 9. Расхождения с нормативными документами

- **[ARCHITECTURE.md §4.5](./ARCHITECTURE.md#45-implementation-status)** ("Исполняемые
  `PromptfooAdapter`, Run Orchestrator, `EvalResult → Observation` mapper и Finding
  Correlator не найдены") — устарело: `PromptfooCliAdapter`, `parsePromptfooResult`,
  `commitFencedObservation`, `pipeline/correlate.ts`/`report.ts` реализованы и покрыты
  тестами. Раздел писался до Фазы 1 и не обновлялся по мере продвижения Roadmap.
- **[ARCHITECTURE.md §8](./ARCHITECTURE.md#8-architecture-laws)** приводит образец из 13
  law-идентификаторов — актуальный реестр насчитывает 66 (раздел 7 выше); список в §8
  стоит либо пометить как "пример", либо заменить ссылкой на этот документ.
- **[ARCHITECTURE.md §9 Roadmap](./ARCHITECTURE.md#9-roadmap)** заканчивается на Phase
  R и не упоминает ни девять раундов пост-имплементационного аудита (`f029975`…`1dd0225`,
  плюс CI-фикс `e4d923f`; раздел 10 ниже), ни отдельную серию самоаудита «граней
  Arch_claude» №9–15 (снапшот-верификация, privilege/env-scoping, durable
  ASK-approval) — ни то, ни другое не новая фаза функциональности, а закрытие
  корректностных разрывов, найденных после Фазы 4.5.4/R; логично добавить их как
  "Phase 4.5.5 — Post-implementation correctness audit" либо отдельную запись
  audit-лога. Список [ARCH_CLAUDE_TRANSFER.md](./ARCH_CLAUDE_TRANSFER.md) §2 (2.1–2.6)
  закрыт полностью на `09e5ff6`, включая финальные два пункта (`7076282`, `4c1251a`).
- **`evaluatePhase5Admission()` теперь возвращает `admissible: true`** (`1440378`) —
  впервые в истории репозитория все 14 критериев §15 выполнены. Каждый нормативный
  документ, до сих пор фразирующий Phase 5 как «ещё не допустимую» (в т.ч. §4.5
  выше и более ранние ревизии этого документа), устарел на этот счёт.
- **`RUNBOOK.md`** обновлён (Part B) с процедурой для leaked `ConcurrencyReservation` —
  прямое следствие audit #7's `admitDispatch()`/`dispatchGuard`; до этого коммита такого
  класса инцидентов не существовало, так что расхождения тут нет, только новая
  документация вслед за новым кодом.
- `wiki/Arch_claude/` (соседняя, untracked директория) **не относится к RTAP** — это
  архитектурное исследование другого проекта (`claude-code-main`, CLI-инструмент Claude
  Code), случайно оказавшееся в этом репозитории. Отмечено здесь во избежание путаницы
  при будущей навигации по `wiki/`.

---

## 10. Хронология: от фазовой реализации к аудиту

```text
 2ea4553  Фаза 0   JSON Schema контракты + Architecture Law Registry
 0b529bc  Фаза 1   promptfoo vertical slice
 a5be44d  Фаза 2   offline dataset + baselines
 61465ea  Фаза 3   shadow candidate scoring
 4d3aefb  Фаза 4   event-sourced CampaignWorld
 fd6ab90  Фаза 5   экспериментальный planner
 a6d6ab1  Фаза 6   duo-static fusion + domain adapters
 bf5bd8a  Фаза 7   production profile (artifacts/secrets/authz/audit)
 b057224  Фаза R   duo-llm remediation
 8d7f3f5  Фаза 4.5.1  execution identity & fencing
 3df6451  Фаза 4.5.2  effect journal & recovery
 19f0287  Фаза 4.5.3  authorization & scheduling
 0670273  Фаза 4.5.4  interceptors & operations   ── все 12 Execution Safety
                                                     architecture laws держатся
 ═══════════════════════ раунд внешнего аудита (не в Roadmap) ═════════════
 f029975  Audit #1  target-scoped binding & dispatch dedup
 c06eab0  Audit #2  schema migrations
 fd10429  Audit #3  fenced commit — единственный канонический API
 aa07c62  Audit #4  реальная outbox-таблица + CampaignWorldMaterializer
 c913ac6  Audit #5  ArtifactStore подключён к evidence адаптеров
                     (Audit #6 — уже был устранён до аудита, отдельного коммита нет)
 d398a9b  Audit #7  authorization + scheduler скомпонованы в admitDispatch()
 e4d923f  CI-фикс   vitest testTimeout поднят до 30s (реестр законов пересёк
                     дефолтные 5s на GitHub Actions после audit #7)
 31649ed  Audit #3  остаток: RecommendationProvenance (worldFingerprint,
          (остаток)  featureDigest, compilerDigest, createdAt/expiresAt) —
                     провенанс, НЕ второй гейт staleness; decideExecution()
                     не меняется. candidateId / modelGeneration /
                     targetSnapshotRef сознательно НЕ добавлены: реальных
                     источников в коде нет, разрыв задокументирован, а не
                     сфабрикован.  ── список аудита закрыт полностью

 ═══════════════ второй заход добычи: ARCH_CLAUDE_TRANSFER.md §2 ═════════════
 e25b5c9  §2.2  back-pressure не пишет ExecutionAttempt
 af7fb1b  §2.3  executeLeasedStep() — единая семантика исполнения
 5057100  §2.4  знаменатель покрытия — отчёт умеет отказать
 7076282  §2.5  campaign/target identity на execution_attempts/run_steps,
                typed terminal доходит до планировщика
 4c1251a  §2.6  прунинг delivered outbox по водяному знаку
                ── ARCH_CLAUDE_TRANSFER.md §2 (2.1–2.6) закрыт ЦЕЛИКОМ

 ═══════════════ третий заход: точечные усиления законов/доков ═══════════════
 1dd0225  authorization-precedes-effect доказывает точную причину отказа,
          не только факт (V→C→P→S priority-reducer оракул)
 2f13bf1  ConcurrencyDeclaration/-Scheduler: доки уточняют, что доказано
          (шедулер соблюдает класс) vs не доказано (класс истинен для адаптера)
 f01771a  interceptor-план сознательно НЕ подключён — 0 реальных
          InterceptorDescriptor означало бы всегда-пустой список

 ═══════════════ независимая серия самоаудита: «грани Arch_claude» ═══════════
 260cc95  грань(закрытие пробела 1)  src/worker/ — первый реальный продовый
                                      вызывающий executeLeasedStep(); критерий
                                      12 §15 → MET
 e556ad1  грань №11  Observed/Inferred/Missing как явная evidence-конвенция
 2cd7aec  грань №12  (первая проверка) — синхронная сигнатура
                     AuthorizationProvider.authorize() структурно
                     сопротивляется приостановке; идея пока неприменима
 c300aaa  грань №14/15  переверка резче первой находки: snapshotWorld() —
                        proven pure function без места для хранения;
                        defaultExec() подтверждённо без env/uid/gid-скоупинга
 eb5e832  грань №9   первый датированный проход: read-side не начал
                      дублировать write-side валидацию — чисто
 c9fdc2a  грань №14  SnapshotStore (migration 4, world_snapshots) —
                      снапшот-верификация в advance(), самоисцеление
 1440378  §15/14     rollback drill — ВСЕ 14 критериев §15 MET впервые
                      в истории репозитория (HardeningConfig)
 3d2672d  грань №15  privilege/env-scoping — SandboxProfile,
                      scopedExecOptions(), все три адаптера
 09e5ff6  грань №12  (реализация) — ASK как durable, re-leasable запрос
                      (PendingApprovalStore, migration 5), НЕ in-memory Promise
 f7b6198  docs      RUNBOOK.md Part C — резолюция ASK (не в рамках «граней»,
                     реакция на пробел, зафиксированный предыдущим as-built)
 5433987  §15/13    критерий 13 declared→derived: RUNBOOK.md реально
                     проверяется с диска, а не заявляется человеком —
                     та же конверсия, что применил `1440378` к критерию 14
 41c268b  planner   run-once.ts + cli.ts — второй продовый bin/ (после
                     worker/): первый реальный читатель authorityFor(),
                     первый реальный поставщик world/compilerDigest в
                     RecommendationProvenance, первый реальный caller
                     dispatchDecisions()'s schedule-параметра (§2.4)
```

---

## 11. Наблюдаемые архитектурные принципы

- **Fail-closed по умолчанию, fail-open только явно объявлен** — security-critical
  всегда блокирует, advisory даёт диагностику, но не блокирует.
- **Никаких скрытых деградаций** — `summaryMismatch` у duo-static, `UNGRADED_SENTINEL` у
  duo-llm, `NOT_IMPLEMENTED_BASELINES`, `signature:'UNSIGNED'` — известные слабости
  проговорены в типах/названиях, а не замаскированы.
- **Identity всегда явная и составная** — `(targetId, probeId)`,
  `RecommendationBinding{campaignId,targetId,worldGeneration,worldEpoch,...}` — ни одна
  привязка не полагается на "глобально уникальный" одиночный ключ.
- **Durable state — единственный источник правды для recovery** — конкурентность,
  effect-reconciliation и материализация мира восстанавливаются из БД, не из памяти
  процесса.
- **Отсутствие доказательства ≠ доказательство отсутствия** — `effectStarted`
  трёхзначен; неразрешённый `AT_MOST_ONCE_UNPROVEN` всегда уходит в ручное разрешение.
- **Законы как живая, а не декларативная документация** — 52 property-based теста,
  каждый воспроизводимый по seed, гейтящий CI.

---

## 12. Известные незакрытые пробелы (честно, из чтения кода)

- ~~Точка стыковки `evidence.ts` с реальным commit-пайплайном не подтверждена~~ —
  **закрыто.** `src/worker/promptfoo-worker.ts` зовёт `materializePromptfooEvidence()`
  перед сборкой `StepOutcome` — реальный вызывающий, не только тест (см. §4).
- Нет реального KMS/Vault `SecretProvider` — только `EnvSecretProvider` (`env:` схема).
- Нет органа подписи моделей — `packageLinearModelArtifact()` всегда ставит
  `signature:'UNSIGNED'`.
- `NOT_IMPLEMENTED_BASELINES = ['tree-boosting','small-mlp','frozen-kan']` — заявлены,
  не реализованы.
- Нет реального экспортёра метрик (Prometheus и т.п.) — `NOOP_METRICS_RECORDER` везде,
  `InMemoryMetricsRecorder` только для тестов.
- ~~`RUNBOOK.md` не покрывает ASK/`PendingApproval`~~ — **закрыто.** Part C
  (`RUNBOOK.md`, C.1–C.5) описывает поиск застрявших в `ASK` шагов (по
  `pending_approvals`, поскольку на уровне `RunStep` такой шаг неотличим от
  упавшего воркера — `execution_attempts` пуст, `ASK` не пишет запись),
  разрешение через `src/approval/cli.ts` и честно фиксирует, что резолюция не
  мгновенна: нужен повторный лиз (`runPromptfooWorkerOnce()` дренирует очередь
  один раз и не поллит), и что `worker/promptfoo-worker.ts` сегодня вообще не
  подключает `ApprovalGate` — значит `ASK` в проде пока в принципе не
  возникает, и Part C ждёт первого деплоя, который подключит свою
  `ApprovalPolicy`.
- ~~Ни один адаптер не вызывает `admitDispatch()`/`commitFencedObservation()`~~ —
  **закрыто полностью.** `executeLeasedStep()` (`src/execution/run-step-executor.ts`,
  [ARCH_CLAUDE_TRANSFER.md §2.3](./ARCH_CLAUDE_TRANSFER.md)) даёт единую композицию
  admission → dispatch → fenced commit → settlement; `260cc95` добавил реальный
  продовый вызывающий — `src/worker/{promptfoo-worker,cli}.ts`: настоящий
  `PromptfooCliAdapter` (реальный `execFile`/`readFile`, без инъекции фикстуры),
  реальный файловый SQLite, дренирует каждый лизуемый RunStep для одного
  assessment run. Проверено вручную вне тестового набора: пустая очередь — код
  выхода 0; реально лизнутый шаг доходит до настоящего вызова `execFile('promptfoo',
  ...)` и durable-фиксируется `FAILED`, когда бинарник отсутствует, — доказательство,
  что связка не замокана. `CURRENT_EXTRA_EVIDENCE.promptfooWiredToHardening` теперь
  `true`, критерий 12 — `MET` как прямое следствие того же флага. Инвариант «единая
  семантика исполнения для всех поверхностей доставки» записан 12-й строкой в
  [EXECUTION_SAFETY_RECOVERY.md §19](./EXECUTION_SAFETY_RECOVERY.md#19-traceability-к-arch_claude).
- ~~Резервация `ConcurrencyScheduler` освобождается только на success-пути~~ —
  **закрыто** `settleAttempt()` (`src/execution/settle.ts`, первое заимствование из
  [ARCH_CLAUDE_TRANSFER.md §2.1](./ARCH_CLAUDE_TRANSFER.md)). Расчёт и освобождение
  барьера теперь одна операция; `EffectReconciler` получил `ConcurrencyScheduler`
  обязательным параметром конструктора, `DispatchGuard` с его `reservationId` удалён.
  Осталась **одна санкционированная** ветка удержания — `UNKNOWN_EFFECT_OUTCOME`
  (эффект может быть ещё в полёте, освобождение цели пустило бы туда новую работу);
  она типизирована как `ReservationDisposition.RETAINED`, отдельно от `NONE`, и
  разрешается вручную по
  [RUNBOOK.md Part B](../../rtap/RUNBOOK.md#part-b--releasing-a-retained-concurrencyreservation).
  Закон `redteam.execution/settlement-releases-what-admission-acquired`.
- `settleAttempt()` пока **не единственный** путь терминализации: ветка отказа
  авторизации в `admitDispatch()` и no-scheduler путь `commitFencedObservation()`
  по-прежнему зовут `markTerminal()` напрямую. Для первого случая это корректно
  (барьер ещё не захвачен), для второго — сознательный выбор обратной совместимости.
  Сделать scheduler обязательным везде — это уже задача исполнителя из §2.3
  ARCH_CLAUDE_TRANSFER.md.
- **Лизинг до допуска — по-прежнему открыто, теперь с реальным вызывающим на этом
  пути.** Настоящая граница claim в RTAP — `RunStepStore.lease()`, а не
  `attempts.start()`, и `lease()` инкрементирует `lease_generation`, то есть
  fencing-токен (`store.ts:77`). `src/worker/promptfoo-worker.ts` зовёт `.lease()`,
  затем `executeLeasedStep()` (который внутри делает `admitDispatch()`) — тот самый
  порядок. Вызывающий, взявший лиз и получивший отказ по ёмкости, уже зафенсил живой
  поздний результат предыдущей попытки впустую. Нужен неизменяющий
  `RunStepStore.peekNext()`, чтобы допуск отрабатывал **до** лиза — теперь, когда
  продовый вызывающий существует, это уже не гипотетический, а измеримый разрыв.
- ~~`CampaignWorldMaterializer.advance()` не вызывается из продового пути~~ —
  **закрыто частично.** `src/planner/run-once.ts` реально его зовёт (первая строка
  `runPlannerOnce()`) — но `worker/promptfoo-worker.ts` по-прежнему нет: проверено,
  `promptfoo-worker.ts` не импортирует `CampaignWorldMaterializer`. Материализация
  мира происходит только когда планировщик решает, что делать дальше, а не после
  каждого закоммиченного `Observation` — значит между запуском воркера и следующим
  запуском планировщика мир может быть неактуален. Два независимых bin/, не
  скоординированных друг с другом по этому вопросу.
- **Веса модели нигде не персистятся durable.** `SignedModelArtifact` хранит только
  sha256-дайджест весов (для проверки целостности), не сами веса —
  `training/model-artifact.ts`'s собственный докстринг это признаёт. `planner/cli.ts`
  получает веса через `--config` JSON-файлом, то есть из внешнего источника, который
  оператор обязан синхронизировать с тем, что реально прошло `ModelPromotionRegistry`.
  Новый `loadFittedLinearModel()` — честно названная реконструкция из веса-на-диске,
  а не из чего-то, что репозиторий сам хранит.
