# RTAP as-built — потоки исполнения, ANSI

> Сводная терминальная проекция [RTAP_AS_BUILT.md](../RTAP_AS_BUILT.md).
> Нормативная карта контекстов: [context-map-ansi.md](./context-map-ansi.md).
> Снято с: commit `e4d923f` (branch `main`, `rtap/`).

## A. Событийное ядро: outbox → инкрементальный материализатор

```text
 commitFencedObservation()
 ┌──────────────────── одна транзакция (BEGIN IMMEDIATE) ────────────────┐
 │ 1. attempts.bindNativeResult()  — проверка fencing (lease совпал?)    │
 │      ├─ REJECTED  → пишем execution_quarantine, committed:false       │
 │      └─ PERMITTED ↓                                                   │
 │ 2. observations.put(observation)        ┐                             │
 │ 3. events.append(campaignEvent)         │ insertObservationAndEvent() │
 │      ├─ INSERT campaign_events(seq)     │                             │
 │      └─ INSERT outbox(event_id,         │                             │
 │                        delivered_at=NULL)┘                             │
 │ 4. attempts.markTerminal(id,'COMPLETED')                               │
 └───────────────────────── COMMIT (всё-или-ничего) ──────────────────────┘
                                     │
                                     ▼
                CampaignWorldMaterializer.advance(campaignId)
                ┌────────────────────────────────────────────┐
                │ 1. current() из materialized_worlds         │
                │    или emptyWorld()                         │
                │ 2. outbox.listUndelivered(seq > lastSequence)│
                │ 3. BEGIN IMMEDIATE:                          │
                │    для каждой строки → reducer.applyEvent()  │
                │    (идемпотентно на уже применённый eventId, │
                │     жёстко останавливается — не пропускает — │
                │     на gap / illegal-relation)                │
                │    UPSERT materialized_worlds                │
                │    outbox.markDelivered(rows)                │
                │ 4. COMMIT                                    │
                └───────────────────┬────────────────────────────┘
                     крах между COMMIT и следующим вызовом?
                     → строки остаются undelivered, при повторном
                       advance() применяются повторно идемпотентно
                                     ▼
                CampaignWorldState{entities, relations,
                                    lastSequence, appliedEventIds, epoch}
                                     │
              fingerprint(state) ═══ проверяется против ═══▶ replay(allEvents)
              (sha256, БЕЗ generation —                      (полный fold от emptyWorld —
               это proof консистентности,                     живой oracle, НЕ deprecated;
               не дедупликация)                                используется и напрямую,
                                                                 напр. в shadow-ranking)
```

## B. Effect lifecycle state machine

```text
 Счастливый путь:
  ADMITTED → AUTHORIZED → EFFECT_STARTED → EFFECT_ACKNOWLEDGED →
  NATIVE_RESULT_RECEIVED → RESULT_NORMALIZED → OBSERVATION_COMMITTED →
  EVENT_PUBLISHED (terminal)

 Терминальные ответвления (TRANSITIONS — литеральная таблица переходов,
 незаконный переход структурно невозможен):
  ADMITTED/AUTHORIZED   --ADMISSION_DENIED-------▶ REJECTED
  EFFECT_STARTED/ACK'D  --CRASH_OR_LOST_ACK,
                           CANNOT_RECONCILE-------▶ UNKNOWN_EFFECT_OUTCOME
                           (fail-closed: никогда не авто-ретраится —
                            ручное разрешение по RUNBOOK.md)
  NATIVE_RESULT_RECEIVED --INVALID_NATIVE_RESULT-▶ NORMALIZATION_FAILED
```

`decideRecovery()` — чистая функция над `{effectStarted: bool|null, capability,
queriedReceiptOutcome?}`: `effectStarted` трёхзначен и становится `false` только через
доказательство (не через отсутствие receipt); `CONFIRMED`-receipt всегда идёт напрямую в
`PROCEED_TO_NATIVE_RESULT`; `AT_MOST_ONCE_UNPROVEN` на неразрешённом исходе всегда даёт
`UNKNOWN_EFFECT_OUTCOME`.

`ConcurrencyScheduler` — durable SQLite-резервация (`concurrency_reservations`), не
in-process лок:

```text
 reservationsConflict(a, b):
   EXCLUSIVE         конфликтует со ВСЕМ (включая другой EXCLUSIVE — глобальный барьер)
   TARGET_SERIAL     конфликтует с любым, кто делит resource key
   CAMPAIGN_SERIAL    то же самое, но в рамках campaignId
   READ_ONLY_PARALLEL никогда не конфликтует сам с собой (ограничен maxInFlight)

 Резервации НИКОГДА не снимаются по таймауту lease — это отдано effect recovery policy.
```

## C. Evidence materialization flow

```text
 parse.ts (чистый, sync)                   evidence.ts (async, NEW — audit #5)
 ┌────────────────────────┐               ┌─────────────────────────────────┐
 │ nativeResult            │               │ materializeXEvidence(store,      │
 │  → ParsedObservation    │──передаёт───▶ │   parsed, ...nativeInputs)       │
 │  .evidenceRefs =        │               │  1. собрать реальные байты       │
 │  синтетические строки   │               │  2. materializeEvidence(store,   │
 │  ("duo-llm:report:5")   │               │     runId,[{kind,body},...])     │
 │  → резолвятся в НИЧТО   │               │     → store.put() на каждый,     │
 └────────────────────────┘               │       content-addressed дедуп    │
                                            │  3. вернуть parsed с             │
                                            │     evidenceRefs, ЗАМЕНЁННЫМИ    │
                                            │     на "local:sha256:<hex>"      │
                                            └────────────────┬──────────────────┘
                                                             ▼
                                            FilesystemArtifactStore
                                            rootDir/<2-hex-префикс>/<sha256-hex>
                                            (путь строится только из хэша —
                                             traversal исключён конструктивно)

 Новый law: redteam.artifact/adapter-evidence-is-really-stored
 (каждый ref резолвится через store.get() в те же байты; одинаковые тела
  из разных вызовов/campaign сходятся к одному ref — content-addressing
  сквозной, не только на уровне одного put())
```

## D. Domain-адаптер admission flow

```text
 DomainAdapterRegistry.swap(request, admission, metadata)
   1. evaluateSwapTiming(request)
        RUN_BOUNDARY → допустимо
        MID_RUN      → всегда отклонено (нет доказательства, что живой
                        CampaignWorld переживёт смену модели на лету)
   2. evaluateAdapterAdmission(matrix, adapterRef, ownDomain)
        ownDomainGain   = adapterScore(ownDomain) − baseline(ownDomain)
        offDomainGains  = adapterScore(d) − baseline(d)  ∀ d ≠ ownDomain
        admitted ⇔ ownDomainGain > 0.02  И  все offDomainGains ≤ 0.0
        → "бесплатный" адаптер, лучший ВЕЗДЕ, отклоняется — это не
          специалист, а универсально лучшая модель
   3. isOverlayOnly(metadata) ⇔ reassignEvery === 0
        → переприсваивающий адаптер никогда не станет активным оверлеем
   4. каждая попытка (успех/отказ) логируется в domain_adapter_log;
      getActive(domain) / rollback(domain) читают domain_adapter_state
```

## E. Петля принятия решений (offline ↔ online)

```text
 OFFLINE TRAINING LOOP                        ONLINE DECISION LOOP (per Target)
 ══════════════════════                        ══════════════════════════════
 исторические Observations                     ProbeCatalogEntry[] (mandatory?)
 + CampaignEventEnvelopes                                 │
        │                                       enumerateEligibleCandidates(
        ▼                                         catalog, targetId, historyView)
 buildHistoryView(events,campaignId,asOf)                 │ исключает: already-
   — "мир до исполнения"                                   │  confirmed-vulnerable,
        │                                                   │  max-attempts-reached
        ▼                                                   │  (оба — target-scoped,
 compileCandidateFeatures() (вид CANDIDATE —                │   через targetProbeKey)
   НЕТ grading/response/runtime — утечка невозможна)         ▼
        │                                         EligibleCandidate[]
        ▼                                                   │
 computeUtilityLabel(policy,outcome,historyBefore)          ▼
   newConfirmedFinding=1.0 / independentConfirmation=0.3 /  mixCandidates(policy,arms)
   uncertaintyReduction=0.2 / cost=-0.1 / error=-0.5           mandatory → первым
   (target-scoped — audit-fix f029975)                          exploration → доля
        │                                                       model → ≤modelShareCap,
        ▼                                                              каждый проверен
 exportDataset() → TrainingExample[]                                    decideExecution()
        │                                                                (stale → drop)
        ▼                                                       heuristic → остаток
 splitByTarget/byCampaign/byTime/byVulnClass                            │
   (holdout целыми группами, checkNoLeakage)                            ▼
        │                                               PlannerDecision[]{targetId,
        ▼                                                 probeId,arm,binding}
 baselines: fixed-order · heuristic ·                                   │
   linear-regression · random                                           ▼
   (tree-boosting/mlp/frozen-kan: NOT_IMPLEMENTED)             dispatchDecisions()
        │                                                        idempotency-key
        ▼                                                        включает targetId
 evaluate() → MSE/MAE + Spearman rank corr.                       (audit-fix)
   (planner использует именно ранговую корреляцию)                → planner_dispatch_log
        │                                                                │
        ▼                                                                ▼
 evaluateAdmissionGate(candidate,baselines)                [адаптер выполняет проб,
   должен побить лучший ИЗ РЕАЛИЗОВАННЫХ baseline           evidence материализуется,
        │                                                    commitFencedObservation()]
        ▼                                                                │
 packageLinearModelArtifact() → SignedModelArtifact                      ▼
   (sha256, signature:'UNSIGNED' — органа подписи ещё нет)   joinDispatchWithOutcomes()
        │                                                     (по targetProbeKey)
        ▼                                                                │
 ModelPromotionRegistry.admit() → состояние OFF                          ▼
        │                                                     computeArmPerformance()
        ▼                                                                │
 applyEvent('MODEL_ADMITTED') → SHADOW ◀══════════════════════════════════╝
        │ (параллельно, вбок — RunStepStore не трогается никогда)
        ▼
 rankCandidates()/buildCounterfactual()/ShadowRankingStore
   (ретроспективно сравнивает модель vs heuristic/random —
    доказано: RunStep-счётчик не меняется)
        │
        ▼
 applyEvent('OFFLINE_AND_SHADOW_GATES_PASSED') → EXPERIMENTAL
        (authorityFor: влияет на dispatch, но в рамках modelShareCap
         — здесь online-петля и замыкается)
                    │
                    ▼
      evaluateABGate(computeArmPerformance) → PROMOTE/DEMOTE/HOLD
                    │
        applyEvent('AB_GATES_PASSED') → CALIBRATED (уже без modelShareCap)
```

## F. Promotion state machine

```text
 Успешный путь:
   OFF --MODEL_ADMITTED--> SHADOW --OFFLINE_AND_SHADOW_GATES_PASSED--> EXPERIMENTAL
       --AB_GATES_PASSED--> CALIBRATED

 Откаты/отказы:
   SHADOW       --ARTIFACT_OR_SCHEMA_INVALID------> OFF
   EXPERIMENTAL --SAFETY_OR_COVERAGE_REGRESSION---> SHADOW
   CALIBRATED   --DRIFT_OR_QUALITY_REGRESSION-----> SHADOW
   CALIBRATED   --INTEGRITY_OR_POLICY_FAILURE-----> OFF

 authorityFor(state) — кто реально влияет на dispatch:
   OFF          rankAndLogCandidates=false  influencesRunStepCreation=false
   SHADOW       rankAndLogCandidates=true   influencesRunStepCreation=false
   EXPERIMENTAL rankAndLogCandidates=true   influencesRunStepCreation=true  (≤modelShareCap)
   CALIBRATED   rankAndLogCandidates=true   influencesRunStepCreation=true  (без этого cap)
```

## G. admitDispatch() и leaked `ConcurrencyReservation` (audit #7)

```text
 admitDispatch(authProvider, scheduler, attempts, request)
 ┌─────────────────────────────────────────────────────────────────────┐
 │ 1. attempts.start({...})              → ExecutionAttempt (=ADMITTED) │
 │    (durable запись создана всегда — даже если ниже будет отказ)      │
 │                                                                       │
 │ 2. evaluateAuthorization(request.authorization, authProvider)        │
 │      ├─ REJECTED → markTerminal('AUTHORIZATION_DENIED')              │
 │      │             return {admitted:false, stage:'AUTHORIZATION'}   │
 │      └─ AUTHORIZED ↓                                                 │
 │                                                                       │
 │ 3. scheduler.reserve({executionAttemptId: attempt.id, declarations}) │
 │      ├─ CONFLICT/LIMIT → markTerminal('TARGET_UNAVAILABLE')          │
 │      │                   return {admitted:false, stage:'CONCURRENCY'}│
 │      └─ RESERVED ↓                                                   │
 │                                                                       │
 │ 4. return {admitted:true, attempt, reservationId, receipt}           │
 └─────────────────────────────────────────────────┬─────────────────────┘
                                                     │ caller передаёт
                                                     │ {scheduler, reservationId}
                                                     │ как dispatchGuard
                                                     ▼
                          commitFencedObservation(..., dispatchGuard?)
                          ┌──────────────────────────────────────────┐
                          │ success-путь (COMMIT):                    │
                          │   dispatchGuard.scheduler.release(         │
                          │     dispatchGuard.reservationId, now)      │
                          │   — внутри той же транзакции               │
                          │                                            │
                          │ reject-путь (fencing отклонил bind):       │
                          │   резервация НЕ освобождается —            │
                          │   "не ясно, разрешился ли attempt иначе"   │
                          └──────────────────────────────────────────┘

 Ничто другое (EffectReconciler, TIMED_OUT_BEFORE_EFFECT, CANCELLED) не
 знает про scheduler вообще → резервация остаётся released_at:NULL навсегда,
 если её не освободить вручную. См. RUNBOOK.md Part B.
```

