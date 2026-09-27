# Что RTAP стоит взять из Arch_claude — второй заход добычи

> Статус: **исследование, не нормативный документ** — предложения к реализации
> Из них реализовано: §2.1 (`settleAttempt()`) и §2.3 (`executeLeasedStep()`)
> полностью, §2.2 (back-pressure) и §2.4 (знаменатель покрытия) частично —
> см. пометки в самих разделах
> Дата ревизии: 2026-08-31
> Проверено против: commit `e4d923f`; пересверено на `31649ed` — см. §0
> Источник добычи: [`wiki/Arch_claude/`](../Arch_claude/) — архитектурное
> исследование `claude-code-main` (CLI Claude Code), 14 документов, ~12 000 строк
> Первый заход: [EXECUTION_SAFETY_RECOVERY.md §19](./EXECUTION_SAFETY_RECOVERY.md#19-traceability-к-arch_claude)
> Состояние реализации RTAP: [RTAP_AS_BUILT.md](./RTAP_AS_BUILT.md)
> Родительская архитектура: [ARCHITECTURE.md](./ARCHITECTURE.md)

`EXECUTION_SAFETY_RECOVERY.md` §19 фиксирует **11 паттернов**, уже перенесённых из
Arch_claude — и все они взяты из **3 документов из 14** (11, 12, 13), исключительно
под execution safety. Остальные 11 документов не разбирались никогда. Этот документ —
второй заход: полная выработка всех 14 документов с адверсарной проверкой каждого
кандидата против реального кода `rtap/src`.

---

## 0. Метод и граница доказательности

```text
┌─────────────────────────────────────────────────────────────────────────┐
│ Фаза 1 «Mine» — 7 агентов, все 14 документов по два на агента           │
│   каждому передан бриф RTAP с 14 задекларированными пробелами;          │
│   §163,165-168,181,184-187,203-207 объявлены уже заимствованными        │
└────────────────────────────────┬────────────────────────────────────────┘
                                  │ 60 кандидатов → дедуп между атласами
                                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ Фаза 2 «Verify» — 6 агентов, по одному на топ-кандидата                 │
│   позиция по умолчанию — скепсис: сначала грепят rtap/src на предмет    │
│   дублирования уже построенного, затем сверяют с «что сознательно не    │
│   делаем» (ARCHITECTURE.md §0/§10).  ADOPT / ADAPT / REJECT             │
└────────────────────────────────┬────────────────────────────────────────┘
                                  ▼
                        Фаза 3 «Synthesize»
```

**Что проверено:** шесть кандидатов, каждый против реального кода, с попыткой
опровержения. **Что не проверено:** ~45 кандидатов из раздела 4 — это гипотезы, а
не выводы. Глубина по документам неровная: 01–04 разобраны построчно, 05–10 и 14
поверхностно, 11–13 выработаны прошлым заходом и давали в основном повторы.

**Пересверка на `31649ed`.** Адверсарная проверка шла против `e4d923f`; пока она шла,
в `main` приземлился `31649ed` (остаток audit #3: `domain/recommendation-provenance.ts`,
54-й закон). Три утверждения этого документа зависели от отсутствия конкретных структур,
и все три перепроверены после него и **остались верны**: `run_steps`
(`migrations.ts:34-48`) и `execution_attempts` (`migrations.ts:172-190`) по-прежнему без
колонок `campaign_id`/`target_id` — блокер §2.5 стоит; таблицы `assessment_runs`
по-прежнему нет — §2.4 п.4 стоит; у `ProbeScheduled` по-прежнему нет производителя в
`src/` — §2.4 п.1 стоит. Соседство с §2.5 при этом содержательное, а не конфликтное:
`RecommendationProvenance` — это провенанс *решения планировщика*, тогда как §2.5 про
чтение планировщиком *типизированного терминала исполнения*; `31649ed` намеренно **не**
добавил `targetSnapshotRef`/`candidateId`/`modelGeneration` ровно по той же причине, по
которой §2.5 вынужден начинать с миграции — реального источника для них в коде нет.

**Оговорка о цитируемости.** `wiki/Arch_claude/` **не находится под git** — это
локальное исследование чужой кодовой базы (`claude-code-main`, CLI Claude Code),
лежащее рядом в рабочем дереве. Ссылки вида `../Arch_claude/...` и номера секций ниже
разрешаются только там, где эта директория физически присутствует; при клонировании
репозитория они не разрешатся. То же ограничение уже действует для таблицы
[EXECUTION_SAFETY_RECOVERY.md §19](./EXECUTION_SAFETY_RECOVERY.md#19-traceability-к-arch_claude),
поэтому здесь оно не новое — но каждое утверждение о Claude Code ниже намеренно
сформулировано самодостаточно, чтобы предложение можно было оценить, не открывая
источник.

Формальный итог проверки: **0 ADOPT, 6 ADAPT, 0 REJECT** — но эта статистика
обманчива. Отбраковка проявилась как **ампутация внутри выживших**: 30 подкомпонентов
отвергнуты (раздел 3), и у трёх кандидатов из шести предложенная центральная часть
оказалась регрессией относительно уже реализованных законов.

---

## 1. Итог

Из шести кандидатов, переживших адверсариальную проверку против реального кода RTAP,
**ни один не переносится в исходном виде** — каждый пришлось ампутировать. Остаётся
шесть исправленных изменений, и у них есть один настоящий, не выдуманный общий
признак: **RTAP с высокой строгостью моделирует путь успеха и с той же строгостью
типизирует причины неуспеха — но у причин неуспеха нет ни одного потребителя.**
`TerminalReason` пишется и не читается планировщиком; `ConcurrencyScheduler`
резервирует и освобождает ровно на одной ветке из четырёх; `ProbeScheduled` лежит в
закрытом enum схемы событий без единого производителя; `{ok:false}` адаптеров
возвращается в никуда; `advance().stoppedAt` не персистится. Каждое рекомендованное
изменение — это **потребитель для факта, который RTAP уже производит**, а не новый
механизм.

Второй честный вывод: **исходные документы дали диагнозы, а не механизмы.**
Практически каждое исправление выводится из собственной вики RTAP
(`EXECUTION_SAFETY_RECOVERY.md` §9, `ADAPTIVE_REDTEAM_RUNTIME.md` §11,
`FROZEN_INTEGRATION.md` §1/§3.3, `RUNBOOK.md` часть B). Из Arch_claude по-настоящему
нова ровно одна формулировка — инвариант «единственная семантика исполнения для всех
поверхностей доставки» (02 §19.1).

---

## 2. Рекомендованные заимствования, по убыванию ценности

### 2.1 `settleAttempt()` — расчёт освобождает то, что захватил допуск

> **Статус: РЕАЛИЗОВАНО.** `src/execution/settle.ts`, закон
> `redteam.execution/settlement-releases-what-admission-acquired` (реестр — 55
> законов, 51 implemented). Реализовано в основном как описано ниже, с двумя
> отличиями по факту работы с кодом: `DispatchGuard` не просто лишился поля
> `reservationId`, а удалён целиком в пользу простого опционального
> `ConcurrencyScheduler`; и диспозиция резервации сделана явным типом
> `ReservationDisposition` с вариантом `RETAINED`, отдельным от `NONE`, — иначе
> «удержано намеренно» было бы неотличимо от «барьера не было». `RUNBOOK.md` Part B
> переписан: его посылка «течёт всё, кроме success-пути» после этого фикса неверна,
> осталась одна санкционированная ветка удержания.

**Паттерн (01-overview-and-core.md §8.4, с §19.2, §30.4 строка abort, §17.3
TaskRegistry в doc 02).** Каждый принятый `tool_use` обязан завершиться ровно одним
согласованным `tool_result` — включая abort, ошибку валидации и падение соседа;
рантайм синтезирует результат, если реальность его не дала. §17.3 добавляет ресурсную
половину: завершение или отмена освобождает ресурсы.

**Закрываемый гэп: 10, полностью.** `EffectReconciler` не имеет `ConcurrencyScheduler`
в конструкторе вообще (проверено: `reconciler.ts:33-36` принимает только `attempts` и
`receipts`), а `reconciler.ts:62` — голый `this.attempts.markTerminal(...)`.
Освобождение происходит только на success-ветке `commitFencedObservation()`. Правило
при этом уже записано у RTAP трижды (`EXECUTION_SAFETY_RECOVERY.md:432-434`,
`concurrency-scheduler.ts:28-36`, `RUNBOOK.md:100-180` часть B) — отсутствует только
автоматика.

```text
                      admitDispatch()
                            │
                    reserve() ── INSERT concurrency_reservations
                            │        (released_at = NULL)
                            ▼
                   ExecutionAttempt (не terminal)
                            │
        ┌───────────────────┼──────────────────┬──────────────────┐
        ▼                   ▼                  ▼                  ▼
 commitFencedObs      EffectReconciler   fencing reject      краш / throw
   (успех)              markTerminal       quarantine          адаптера
        │                   │                  │                  │
   release() ✔          нет release ✘      нет release ✘     нет release ✘
        │                   │                  │                  │
        ▼                   └──────────────────┴──────────────────┘
    свободно                            │
                                        ▼
                      reservation живёт вечно → TARGET_SERIAL /
                      CAMPAIGN_SERIAL / EXCLUSIVE заклинены навсегда
```

**Конкретное изменение в `rtap/src`.** Новый `src/execution/settle.ts`:

```
settleAttempt(attempts, scheduler, executionAttemptId, reason: TerminalReason, now?)
  -> { attempt: ExecutionAttempt; released: string | null }
```

- **Не открывает транзакцию** (ambient, как `markTerminal`/`release`/
  `bindNativeResult`) — SQLite не вкладывает транзакции, а `commitFencedObservation()`
  уже держит `BEGIN IMMEDIATE` на строке 100.
- Сначала `attempts.markTerminal()` — он уже обеспечивает иммутабельность терминала
  (`execution-attempt-store.ts:103-116`), поэтому «ровно один расчёт» достаётся
  бесплатно.
- Резервацию находит сам, через новый
  `ConcurrencyScheduler.activeReservationForAttempt(id)` по уже существующей колонке
  `concurrency_reservations.execution_attempt_id` (`migrations.ts:242`). Никакого
  `reservationId` от вызывающего.
- **Освобождает по исчерпывающему `switch` над `TerminalReason`**, кроме
  `UNKNOWN_EFFECT_OUTCOME` — его резервация удерживается намеренно (`RUNBOOK.md`
  B.2/B.4, `RTAP_AS_BUILT.md:186`).

```text
любой terminal ──► settleAttempt(...)
                       ├─ markTerminal(reason)              ← иммутабельность уже есть
                       └─ switch (reason)
                            ├ UNKNOWN_EFFECT_OUTCOME ─► RETAINED, released: null
                            └ все остальные          ─► release()
```

Затем: `reconciler.ts` получает scheduler в конструктор, строка 62 →
`settleAttempt(...)`. И — более крупная победа, чем сам фикс реконсилятора —
`commit-fenced-observation.ts:116-119` заменяется на один вызов, после чего
**интерфейс `DispatchGuard` с полем `reservationId` (строки 11-15) удаляется
целиком**: вызывающий больше физически не может забыть освободить.

Новый закон в `src/laws/catalog/execution-safety.laws.ts` в стиле RTAP
(seeded-генератор + in-memory DB, ~300 испытаний), id
`redteam.execution/settlement-releases-what-admission-acquired`: после каждого расчёта
нет строки с `released_at IS NULL AND terminal_reason IS NOT NULL AND terminal_reason
<> 'UNKNOWN_EFFECT_OUTCOME'` — и обратно: каждый `UNKNOWN_EFFECT_OUTCOME`, державший
резервацию, держит её до сих пор.

**Трудоёмкость: SMALL.** **Первый коммит:** `src/execution/settle.ts` +
`activeReservationForAttempt()` + подключение `EffectReconciler`, с юнит-тестом,
доказывающим, что `FAILED_BEFORE_EFFECT` барьер снимает, а `UNKNOWN_EFFECT_OUTCOME`
доказуемо нет.

---

### 2.2 Back-pressure не создаёт `ExecutionAttempt` (ACK после принятия ответственности)

> **Статус: РЕАЛИЗОВАНО частично.** `src/execution/dispatch.ts`, закон
> `redteam.execution/backpressure-is-not-an-execution-record` (реестр — 60 законов).
> Ветка `CONCURRENCY` типизирована как `attempt: null`, отказ авторизации по-прежнему
> пишет свою терминальную строку (асимметрия намеренная, см. §3 п. 28). Закон
> проверялся против старого поведения и падал на каждом сиде — не принят «на веру».
> Появилась одна новая ветка, которой не было в плане: резервация берётся до создания
> строки, поэтому бросок `start()` теперь освобождает барьер перед пробросом.
> **Не сделано:** `RunStepStore.peekNext()` и перенос допуска до `lease()`. Опасность
> реальна (`lease()` инкрементирует fencing-токен, отказ по ёмкости после лиза
> зафенсил бы живой поздний результат), но это изменение *последовательности вызовов
> у вызывающего*, а вызывающего пока нет — уходит к исполнителю §2.3. Метрика
> back-pressure тоже не добавлена: `OPERATIONAL_METRICS` — фиксированный список семи
> имён из §11 без экспортёра, восьмое имя было бы и расхождением с доком, и
> ненаблюдаемым.

**Паттерн (03-code-deep-dives.md §40.1, §44.2 boundary 5; 04-sequence-diagrams.md
§61).** Рабочий элемент нельзя ACK-ать до решения реально его обрабатывать; при
исчерпании ёмкости он намеренно остаётся не-ACK-нутым, и отказ **не порождает никакой
записи** — именно это делает переотправку корректной.

**Закрываемый гэп: часть 1, плюс семантическая ложь в каноническом журнале
исполнения.** Сегодня `dispatch.ts:56` вызывает `attempts.start()` **до** обеих
проверок, и при отказе шедулера терминализует свежесозданную попытку как
`TARGET_UNAVAILABLE`. Для `TARGET_SERIAL`-цели конкуренция — это установившийся режим
кампании, а не сбой: каждая спорная попытка кладёт в БД долговечную строку,
утверждающую неудачную попытку исполнения против цели, с тем же кодом причины, что и
реально недоступная цель. Для системы, вся ценность которой — не фабриковать
security-truth, это артефакт формы «ложный негатив».

```text
СЕЙЧАС                                   ПОСЛЕ
─────────────────────────────────────    ─────────────────────────────────────
attempts.start()      ← «ACK» не там     id = randomUUID()
   │                                        │
evaluateAuthorization()                  evaluateAuthorization()
   │ denied → markTerminal(AUTH_DENIED)     │ denied → start(id)+markTerminal   ← СОХРАНЯЕМ
   │                                        │          (AUTHORIZATION_DENIED)
scheduler.reserve()                      scheduler.reserve({…, id})
   │ refused → markTerminal(                │ refused → { admitted:false,
   │           TARGET_UNAVAILABLE)  ✘       │            stage:'CONCURRENCY',
   │           ↑ долговечная строка о       │            attempt: null }  ✔
   │             несостоявшемся исполнении  │
   ▼                                     attempts.start({…}, now, id)
```

**Конкретное изменение.** В `src/execution/dispatch.ts`: сначала `randomUUID()`, затем
авторизация (ветка отказа **не меняется** — см. §3, п. 28), затем `reserve()` с
преминченным id, и только при успехе `attempts.start()` с тем же id. Оба параметра уже
инъектируемы (`execution-attempt-store.ts:33`, `concurrency-scheduler.ts:40`) —
**никакого `probe()` не нужно**, и `TARGET_UNAVAILABLE` резервируется за реальной
пост-claim недоступностью.

Граница claim в RTAP — это `lease()`, а не `attempts.start()`: добавить
`RunStepStore.peekNext(assessmentRunId, now)` (тот же SELECT из `store.ts:56-67` без
UPDATE), чтобы допуск отрабатывал **до** лизинга. Лизить-и-отказывать нельзя:
`lease()` инкрементирует `lease_generation` (`store.ts:77`), а это fencing-токен
(`execution-attempt-store.ts:132`), и отказ по ёмкости зафенсил бы реальный поздний
результат прошлой попытки.

Видимость: не счётчик попыток (`run_steps.attempt` уже есть и не должен считать
отказы), а метрика back-pressure через существующий `OperationalEnvelope`/
`OPERATIONAL_METRICS`.

Законы: **изменить**
`redteam.execution/dispatch-admission-composes-authorization-and-concurrency`
(утверждение на `execution-safety.laws.ts:779`), добавить
`redteam.execution/backpressure-is-not-an-execution-record`.

**Трудоёмкость: SMALL** (~20 строк src). **Первый коммит:** `fix(rtap): concurrency
back-pressure creates no ExecutionAttempt` — переупорядочить `admitDispatch()`,
добавить вариант результата `attempt: null`, обновить `test/execution/dispatch.test.ts:131,134`,
`test/integration/authorization-and-scheduling-slice.test.ts:219` и закон на строке
779. Оркестратор для этого не нужен.

---

### 2.3 `executeLeasedStep()` + инвариант единственной семантики исполнения

> **Статус: РЕАЛИЗОВАНО.** `src/execution/run-step-executor.ts`, инвариант записан
> 12-й строкой в [EXECUTION_SAFETY_RECOVERY.md §19](./EXECUTION_SAFETY_RECOVERY.md#19-traceability-к-arch_claude).
> Реализовано как описано, с двумя уточнениями по факту работы с кодом:
> **(1)** отказ по конкуренции возвращает `ADMISSION_REFUSED` и **не** трогает RunStep —
> провалить его было бы неверно, конкуренция транзиентна, шаг должен остаться
> перелизуемым; **(2)** брошенный `runner()` settle'ится как `UNKNOWN_EFFECT_OUTCOME`
> (барьер удерживается), а не как `FAILED_BEFORE_EFFECT` — необработанное исключение
> не сообщает исполнителю ничего, а §7.2/§13 запрещают считать отсутствие
> свидетельства свидетельством отсутствия; runner, который *знает*, что эффект не
> стартовал, обязан сказать это типизированно и получить освобождение барьера.
> `vertical-slice.test.ts` **не** переписан вопреки плану: он намеренно покрывает
> pre-4.5 путь через `commitObservationWithEvent()`, и перевод его на исполнитель
> уничтожил бы реальное покрытие. Вместо этого добавлен
> `test/integration/executor-slice.test.ts` — настоящий promptfoo-результат проходит
> adapter → evidence → parse → executor → commit → outbox → материализованный мир.
> **Не сделано:** `peekNext()` и допуск до лиза (см. известную цену в докстринге
> модуля); критерий 12 admission-сюиты остаётся `NOT_MET` — продового вызывающего
> исполнителя нет, а флаг это декларированное свидетельство о реальном развёртывании.

**Паттерн (02-ddd-reliability-and-operations.md §19.1, §30.1-30.2).** Единственное,
что здесь реально ново: `query.ts` — единственный источник семантики model/tool-цикла
**и для интерактивного REPL, и для headless/SDK**: оболочки различаются, цикл —
никогда.

**Закрываемый гэп: 1 (крупнейший).** Подтверждено: `src/orchestration/` и
`src/orchestrator/` не существуют; единственный не-тестовый вызов адаптера во всём
`src/` — `platform.laws.ts:109`, инстанцирующий `DuoLlmCliAdapter` внутри проверки
закона. При этом «sole path» в RTAP сказано трижды — и **все три раза про commit, ни
разу про исполнение** (`grep -rn "sole" src` даёт только `commit-fenced-observation.ts`,
`commit-observation.ts`, `index.ts`). Гэп 6 (UI/MCP/GitLab объявлены, не написаны) —
это ровно тот момент, когда такой инвариант дёшево зафиксировать и дорого дозакрутить
потом.

```text
   CLI        MCP server      GitLab hook        API      ← гэп 6, ещё не написаны
    └────────────┴─────────────────┴──────────────┘
                          │
              executeLeasedStep()        ← единственная семантика шага
                          │
 admitDispatch ─► runner() ─► commitFencedObservation ─► materializer.advance
      │             │                    │                       │
  AUTHORIZED   EFFECT_STARTED    OBSERVATION_COMMITTED     EVENT_PUBLISHED
      └──────────── attemptEffectTransition() (effect.ts TRANSITIONS) ────────┘
                    ▲ незаконный порядок ОТВЕРГАЕТСЯ, а не подгоняется
```

**Конкретное изменение.** Один новый файл `src/execution/run-step-executor.ts`: один
залиженный RunStep на входе, ровно одно терминальное `EffectLifecycleState` на выходе.
**Не держит `DatabaseSync` между вызовами и не держит состояния вообще** — процессный
lease-цикл остаётся тонким вызывающим в будущем `bin/`, ключом по `assessmentRunId`
(`RunStepStore.lease`), не по кампании.

Узкие порты, никогда один context-мешок (это ровно та ловушка `ToolUseContext`,
которую doc 01:466-480 сам называет антипаттерном; прецедент 3-аргументного стиля в
RTAP уже есть — `admitDispatch`):

```
executeLeasedStep(
  db, attempts, observations, events, scheduler, authProvider,
  request: DispatchGuardRequest,        // переиспользуется дословно
  runner: StepRunner,                   // (attempt) => Promise<StepOutcome>
  now?
): Promise<StepResult>
```

Композиция под конкретный движок (`adapter.run` → `materializeEvidence` → parse) живёт
**снаружи**, в замыкании `promptfooStepRunner()`, поэтому драйвер не импортирует ни
одного адаптера, `ExecFn`-инъекция не трогается, а закон на `platform.laws.ts:109`
остаётся легальным: правило формулируется как «исполнитель — единственный
**production**-вызывающий `adapters/*/run.ts`».

Инвариант записать 12-й строкой в таблицу трассируемости
[EXECUTION_SAFETY_RECOVERY.md §19](./EXECUTION_SAFETY_RECOVERY.md#19-traceability-к-arch_claude)
и doc-комментарием на новом файле, со ссылкой на Arch_claude 02 §19.1.

Заодно переписать на `executeLeasedStep()` два де-факто оркестратора, живущих сегодня
в тестах: `test/integration/authorization-and-scheduling-slice.test.ts:157-253` и
`test/integration/vertical-slice.test.ts:31-80` (второй всё ещё зовёт снятый
`commitObservationWithEvent`). Именно это и доказывает закрытие гэпа 1.

По admission: переписать `detail` критерия 12 (`admission.ts:80-84`) под исполнитель, а
не под хирургию адаптера, и переключить `promptfooWiredToHardening` в true только после
интеграционного теста. **Не называть это «выводимым»** — это по-прежнему декларированное
свидетельство, и `admissible` остаётся false из-за критерия 14.

**Трудоёмкость: MEDIUM.** **Первый коммит:** сам `run-step-executor.ts` с
инъектируемым `StepRunner` и без импорта адаптеров, экспорт из `src/index.ts`, и один
тест на единственную гарантию, которой сегодня нет: когда `runner()` вернул
`{ok:false}` или бросил — попытка терминализована с верным `TerminalReason` **и**
`scheduler.activeReservations()` пуст.

---

### 2.4 Знаменатель покрытия: `ProbeScheduled` и отчёт, который умеет отказать

> **Статус: РЕАЛИЗОВАНО (шаги 1–3, 5).** `eventForScheduledProbe()`,
> `CampaignWorldState.scheduledUnresolved`, `buildAssessmentReport()` с отказом,
> закон `redteam.artifact/coverage-denominator-is-never-assumed` (реестр — 61 закон).
> Закон проверен против нетронутого редьюсера и падал (`expected 5 outstanding but
> world holds 0`). Три уточнения по факту работы с кодом: **(1)** новое множество
> **включено в `fingerprint()`** — иначе закон `outbox-materialization-matches-full-replay`
> не увидел бы расхождения в нём, то есть знаменатель остался бы непокрытым тем самым
> законом, который для этого и существует; **(2)** ключ — существующий
> `targetProbeKey()`, а не новая функция: `reducer.ts` уже импортирует из
> `features/history-view.js`, так что новой зависимости не возникает (мой первый
> комментарий утверждал обратное и был неверен); **(3)** производитель подключён к
> `dispatchDecisions()` — единственной функции, которой позволено создавать RunStep, —
> с `eventId` от того же ключа идемпотентности, поэтому передиспатч не может раздуть
> знаменатель, как не может создать второй RunStep. **Не сделано:** шаг 4 (таблица
> `assessment_runs`) и шаг 6 (`failurePolicy` по адаптерам). Контекст кампании в
> `dispatchDecisions()` опционален — `PlannerDecision` не несёт надёжного campaignId, —
> так что диспатч без знаменателя всё ещё возможен, но теперь даёт `UNKNOWN`, а не
> тихо сходит за полное покрытие.

**Паттерн (02 §19.7, с 01 §12.2, §12.3, §17.3).** Отказ одного компонента
локализуется, **если политика не требует fail-closed для всей операции**; радиус
поражения — объявленное свойство компонента.

**Закрываемый риск — самый глубокий из всех шести, и это единственное место, где
заявленная цель RTAP структурно не защищена.** `buildJsonReport()` (`report.ts:30-42`)
выдаёт `totalObservations`/`totalFindings` **без знаменателя**. `correlate.ts` защищает
только группы наблюдений, которые существуют; проба, которая не выполнялась, не даёт
ни группы, ни сигнала. `DuoStaticCliAdapter` при падении возвращает аккуратный
типизированный `{ok:false, error}` (`duo-static/run.ts:55-57`), который никто не
потребляет.

```text
СЕЙЧАС:  campaign_events содержит только успешно закоммиченное
         ┌──────────────────────────────┐
         │ VulnerabilityObserved  ×  3  │  → отчёт: 10 наблюдений, 3 находки.
         │ ResistanceObserved     ×  7  │     Выглядит чисто.
         └──────────────────────────────┘
         Реальность: адаптер умер на 40-й пробе из 200.
         190 непроведённых проб НЕ ОТЛИЧИМЫ от 190 проб,
         которые прошли и ничего не нашли.

ПОСЛЕ:   ProbeScheduled × 200  (эмитится атомарно с enqueue)
           − разрешённые (Vulnerability|Resistance|Unverified|ExecutionFailed)
           = scheduledUnresolved: 190
                    │
                    ▼
         buildJsonReport() → { ok:false, reason:'UNRESOLVED_COVERAGE', unresolved }
```

**Конкретное изменение, в порядке выполнения.**

1. **Эмитить знаменатель.** `ProbeScheduled` уже в закрытом enum
   `schemas/campaign-event.schema.json:33` и **не имеет ни одного производителя**
   (проверено grep-ом по `src/`, `test/`, `schemas/`). Добавить
   `eventForScheduledProbe()` рядом с `eventForObservation()` в
   `src/pipeline/observation-event.ts`, аппендить атомарно с `RunStepStore.enqueue()`.
   Схема не меняется, редьюсер не меняется (`deriveFromPayload` тотален по
   нераспознанным формам).
2. **Материализовать неразрешённое множество.** `scheduledUnresolved:
   ReadonlySet<string>` (ключ `${targetId}:${probeId}`) в `CampaignWorldState`. Едет на
   существующей машинерии `advance()`/`replay()`/`fingerprint()` бесплатно и
   автоматически покрывается уже реализованными законами про совпадение инкремента с
   полным реплеем.
3. **Отказ — в поверхности доставки, не в домене.** `src/domain/verdict.ts` **не
   трогать**: `frozen.laws.ts:218-220` утверждает структурную независимость
   `deriveVerdict()` от здоровья воркера, и «coverage-bearing Verdict» как объекта не
   существует. Вместо этого `buildJsonReport()` получает обязательный блок `coverage:
   { scheduled, resolved, unresolved, degradedEngines }` и дискриминированный результат
   с отказом.
4. **Создать отсутствующую агрегатную строку.** Таблицы `assessment_runs` нет вообще —
   `assessment_run_id` висит осиротевшим FK на восьми таблицах. Миграция id 3:
   `assessment_runs (assessment_run_id PK, campaign_id, intelligence_status DEFAULT
   'HEALTHY', coverage_acceptance, accepted_by, accepted_at)`. Одна таблица
   одновременно реализует уже специфицированный `FROZEN_INTEGRATION.md:136`
   `intelligence_status=DEGRADED`, даёт дом выбрасываемому сегодня
   `rankCandidates().usedFallback` (`shadow/rank.ts:42`, колонки в `shadow_rankings`
   нет) и даёт место для явного принятия DEGRADE.
5. **Закон** — в `platform.laws.ts` (DB-стиль), не в `domain-safety.laws.ts` (чистые
   функции + ajv).
6. **В последнюю очередь** — `failurePolicy` per-adapter, и **в
   `src/execution/capability-declarations.ts`**, где конвенция «объявлено,
   консервативный дефолт, нельзя поднять в рантайме» уже живёт
   (`resolveFailurePolicy(...)` по образцу `resolveCapability() ??
   'AT_MOST_ONCE_UNPROVEN'`). **Не** в `adapters/capability.ts` — тот тип это
   `Readonly<Record<cap, boolean>>`, строковый union туда не влезает, и это pre-dispatch
   гейт, а не обработчик рантайм-отказа.

**Трудоёмкость: LARGE** (но первый шаг крошечный). **Первый коммит:** ~40 строк —
`eventForScheduledProbe()` + тест, что `CampaignEventStore.append()` принимает его
против `rtap:campaign-event` без изменений схемы и что `applyEvent()` секвенирует его с
пустой дельтой графа.

---

### 2.5 Идентичность кампании/цели на исполнении, и типизированный терминал, дошедший до планировщика

> **Статус: РЕАЛИЗОВАНО.** Миграция id 3 (`campaign_target_identity`,
> `campaign_id`/`target_id`, nullable, на `run_steps` и `execution_attempts`);
> `RunStepPayload`, `RunStepStore.enqueue()`'s опциональный `identity`,
> `ExecutionAttemptStore.start()` копирует; `ProbeOutcomeCounts.attempts` →
> `committedOutcomes`, новое поле `CampaignHistoryView.settledAttemptsByReason` +
> `buildSettledAttemptsByReason()`; `blocksEligibility()` — исчерпывающий `switch` в
> духе `settle.ts`'s `releasesOnSettlement()`; закон
> `redteam.execution/settled-attempt-is-not-an-unattempted-candidate` (62 закона, 58
> implemented). Честно упрощено против собственной формулировки плана: «до смены
> policy version» и «без явного решения оператора» схлопнуты в «блокирует всегда» —
> ни сравнения policy-версий, ни записи operator-decision в репозитории нет. `probeId`
> не стал отдельной колонкой на `execution_attempts` — читается обратно через
> `RunStep.payload`, ровно по заявленному в плане объёму миграции (две колонки, не
> три).

**Паттерн (02 §30.1, «Факт кода / Интерпретация»).** Это **названный дефект**, а не
образец: `queryLoop()` возвращает типизированный `Terminal`, `QueryEngine` глотает его
через `for await` и **переклассифицирует испущенные сообщения**, чтобы реконструировать
внешний результат. Вердикт документа: две терминальные модели, точность теряется в
переводе.

**Где RTAP делает ровно это.** `CampaignHistoryView.ProbeOutcomeCounts.attempts`
(`history-view.ts:13,57,61` — проверено) **реконструируется подсчётом закоммиченных
`CampaignEvent`**, при том что типизированный `ExecutionAttempt.terminalReason` лежит
непрочитанным в той же базе. Поле называется `attempts`, докстринг обещает ответ на
«что кампания уже пробовала», а считает оно успешные коммиты.
`enumerateEligibleCandidates()` (`candidates/enumerate.ts:63-69`) гейтит на нём с
`maxAttemptsPerProbe: 1` — значит попытка, завершившаяся `AUTHORIZATION_DENIED` /
`TARGET_UNAVAILABLE` / `UNKNOWN_EFFECT_OUTCOME`, читается планировщиком как «никогда не
пробовали». `redteam.execution/unknown-effect-is-not-auto-retried` запрещает ретрай
**реконсилятору** и молчит про **планировщик** — дыра между двумя слоями,
открывающаяся ровно тогда, когда появится исполнитель из §2.3.

**Блокер, которого не было ни в брифе, ни в исходном предложении: join сегодня
физически не написать.** Ни `run_steps`, ни `execution_attempts` не имеют колонок
`campaign_id`/`target_id` (`migrations.ts:34-48`, `172-190`), а `run_steps.payload` —
нетипизированный JSON. `AuthorizeEffectRequest` несёт `campaignId`, но до строки
попытки он не доезжает.

**Конкретное изменение.**

1. Типизированный `RunStepPayload { campaignId, targetId, probeId }` в
   `src/runsteps/types.ts` + **новая миграция в реестр** (`INITIAL_SCHEMA_SQL` не
   редактируется — правило на `migrations.ts:29-31`) с колонками
   `campaign_id`/`target_id` на обеих таблицах; `ExecutionAttemptStore.start()`
   копирует их так же, как уже копирует `leaseGeneration`/`attemptNo`.
2. `ProbeOutcomeCounts.attempts` → `committedOutcomes` (то, что оно и считает), плюс
   вторая карта `settledAttemptsByReason: ReadonlyMap<string, Record<TerminalReason,
   number>>`, читаемая прямо из `execution_attempts.terminal_reason`, дословно, без
   схлопывания в булево. `buildHistoryView()` получает **опциональный** второй аргумент
   — все существующие тесты и законы проходят без изменений.
3. `EligibilityPolicy` — из одного скаляра в решение per-`TerminalReason`:
   `TARGET_UNAVAILABLE` → снова допустима; `AUTHORIZATION_DENIED` → недопустима до
   смены версии политики; `UNKNOWN_EFFECT_OUTCOME` → недопустима без явного решения
   оператора. Это же объясняет, почему наивная версия активно вредна: единый счётчик
   `attempts` сделал бы `TARGET_UNAVAILABLE` неретраибельным.
4. Закон `redteam.execution/settled-attempt-is-not-an-unattempted-candidate`.

**Ключевое:** `campaign_events` не трогается вообще — поэтому не возникает ни связи с
гэпом 7, ни зависимости от открытого ADR 5, ни истории версионирования схем для
терминальных причин.

**Трудоёмкость: MEDIUM.** **Первый коммит:** `feat(rtap): campaign/target identity on
run_steps and execution_attempts` — типизированный payload, миграция, копирование в
`start()`. Ничего ещё не читает новые колонки; всё зелёное.

---

### 2.6 Прунинг доставленных строк outbox по водяному знаку

> **Статус: РЕАЛИЗОВАНО.** `OutboxStore.pruneDelivered(campaignId, throughSequence)`,
> `CampaignWorldMaterializer.pruneDeliveredOutbox(campaignId)` (водяной знак —
> `materialized_worlds.last_sequence`, не новая таблица). Закон не новый — расширен
> существующий `redteam.platform/outbox-materialization-matches-full-replay`, ровно
> по инструкции плана; прунинг вызывается на ~2/3 симулированных crash-restart
> чанков внутри уже существующего прогона против `replay()`. 62 закона, 58
> implemented (без изменений — новый закон не добавлялся). Ограничение
> `appliedEventIds` осознанно не в этом коммите — отдельный, более крупный по риску
> вопрос, не входивший в исходный список из 14 гэпов.

**Паттерн (02 §31.1-31.2).** Граница компакции — одновременно рантайм-переход и маркер
персистентности; последовательность пересобирается, а не усекается на месте.

**Честная оценка: это самый слабый пункт списка.** Отличительное содержание паттерна
(«тот же момент — и переход, и маркер») **не переносится**: удаление доставленных строк
outbox ничего не меняет для рантайма (`advance()` читает только недоставленные) и не
меняет никакой родословной. Остаётся «DELETE с защитой по водяному знаку», для чего
трансфер паттерна не нужен. Включено только потому, что дефект реальный: **во всём
`src/` нет ни одного `DELETE FROM`** (проверено), и `outbox` растёт монотонно навсегда.

**Конкретное изменение.** `OutboxStore.pruneDelivered(campaignId, throughSequence)` с
предикатом `delivered_at IS NOT NULL AND sequence <= @throughSequence` — не
оптимизация, а гарантия безопасности: `listUndelivered()` фильтрует ровно по этой
колонке. Водяной знак — **не новая таблица**, а `materialized_worlds.last_sequence`;
отсюда обёртка `CampaignWorldMaterializer.pruneDeliveredOutbox(campaignId)`, чтобы
рассинхрон был невозможен по конструкции. Закон **не добавлять**, а расширить
существующий `redteam.platform/outbox-materialization-matches-full-replay`
(`platform.laws.ts:270-333`), вставив вызов прунинга внутрь цикла чанков (~строка 309):
оракул по `fingerprint()` на строке 322 уже есть.

Отдельным пунктом, **не в этом коммите**: ограничить `appliedEventIds` — он
персистится целиком и пересериализуется на каждом `advance()` (`materializer.ts:32`,
`:128`). Это неограниченный рост, которого нет в списке из 14 гэпов, и он крупнее по
риску, чем outbox.

**Трудоёмкость: SMALL.** **Первый коммит:** ровно один — метод, обёртка, вызов внутри
существующего закона. Без миграции, без таблицы, без нового закона, без касания
`campaign_events`.

---

## 3. Что рассмотрено и ОТВЕРГНУТО

Формальный список refuted пуст — **ни один кандидат не погиб целиком**. Фильтрация
проявилась как ампутация внутри выживших, и это важнее: у трёх из шести предложенная
центральная часть была регрессией.

**Отвергнуто в кандидате «двухуровневая оркестрация»:**

1. Фасад `CampaignEngine` — у RTAP всё состояние долговечно в SQLite, объект не владеет
   ничем; это composition root, т.е. собственные антипаттерны doc 02 §20.1/§20.2.
2. «Ровно два времени жизни» — у RTAP их четыре (§20:759-766), и кампания как lifetime
   исполнителя противоречит ключам: `advance()` кампанийный, а
   `lease()`/`dispatchDecisions()`/`ExecutionAttempt`/`materializeEvidence()` — по
   `assessmentRunId`.
3. Импорт «фиксированного порядка вызовов» из §30.2 — уже есть как литеральная таблица
   `TRANSITIONS` в `effect.ts:11-49`, и она богаче оригинала (типизированные ветки
   отказа).
4. Закон «`commitFencedObservation()` требует попытку, отчеканенную `admitDispatch()`»
   — **ломает пост-крашевый коммит**: `EffectReconciler` по устройству работает из
   долговечного состояния и `admitDispatch()` в том процессе не вызывается; это обмен
   двух держащихся критериев допуска (5 и 6) на один.
5. «Критерий 12 станет выводимым» — ложь дважды: это обычная константа, а его
   собственный текст требует ровно противоположного дизайна (хирургии адаптера), т.е.
   формулировку надо переписать, а не удовлетворить.
6. `compilePlan()` в шаге исполнителя — гэп 12: дескрипторов нет, вызов был бы с пустым
   массивом, т.е. театр.

**Отвергнуто в кандидате «ровно один расчёт»:**

7. `settleOrphans()` — стартовая зачистка по устаревшему `leaseGeneration` есть ровно
   то авто-освобождение по таймауту лизы, которое RTAP запрещает трижды.
8. Безусловный `settleAttempt()` в реконсиляторе — снял бы барьер при
   `UNKNOWN_EFFECT_OUTCOME`, т.е. пустил бы новую работу против цели с возможно
   летящим эффектом.
9. Закон «никаких неосвобождённых резерваций у терминальных попыток» — делает
   нарушением санкционированное состояние удержания из RUNBOOK B.2; обязан быть
   обусловлен `<> 'UNKNOWN_EFFECT_OUTCOME'`.
10. Зеркалирование `reservationId` в `execution_attempts` — второй источник истины при
    уже существующем FK.
11. Собственная транзакция в `settleAttempt()` — SQLite не вкладывает; вызывающий уже
    держит `BEGIN IMMEDIATE`.
12. Терминальное событие в `campaign_events` — телеметрия исполнения в каноническую
    security-truth, против `telemetry-is-not-authority`.
13. Утверждение «ветки отказа `admitDispatch()` текут резервациями» — фактически
    неверно: `reserve()` возвращается до INSERT на обеих ветках.

**Отвергнуто в кандидате «типизированный терминал»:**

14. Тип события `AttemptSettled` — **ломает реализованный закон**
    `redteam.execution/replay-preserves-effect-resolution` («ровно одно событие»,
    `execution-safety.laws.ts:630-633`) на каждом сиде с rounds > 0.
15. Отношение `PROBE_ATTEMPTED_ON_TARGET` — `FROZEN_INTEGRATION.md` §3.1 фиксирует
    неизменяемый словарь 7+7.
16. «Зарегистрировать 11-ю схему в `src/schemas/index.ts`» — схемы автообнаруживаются
    `readdirSync`; типу события нужен член enum, а не файл (и
    `ProbeScheduled`/`ProbeExecuted` уже свободны).

**Отвергнуто в кандидате «радиус поражения»:**

17. `failurePolicy` рядом с `EngineAdapterCapabilities` — тип это `Record<cap,
    boolean>`, строковый union не помещается, и модуль — pre-dispatch гейт по своему же
    докстрингу.
18. `deriveVerdict()`, отказывающийся выдать вердикт с покрытием — инвертирует
    утверждаемый закон `frozen.laws.ts:218` и относится к несуществующему объекту.
19. Закон в `domain-safety.laws.ts` — там только чистые функции и ajv; долговечное
    свойство покрытия принадлежит DB-стилю `platform.laws.ts`.
20. «Перенести декларацию» как заголовок — `capability-declarations.ts` уже реализует
    ровно эту конвенцию, и она сама заимствована ранее (doc 12 §184).

**Отвергнуто в кандидате «граница компакции»:**

21. Событие `CompactionBoundary` и режим replay-от-границы — replay-от-границы **это и
    есть** `materializer.advance()`.
22. Трёхсторонний закон — уже реализован как
    `outbox-materialization-matches-full-replay`, включая случай краша/рестарта и
    сравнение по `fingerprint()`.
23. Схлопывание `schema_migrations` — **ломает**
    `schema-migrations-apply-exactly-once-in-order`, отменяя точечную проверку
    членства (`migrations.ts:358`): все схлопнутые миграции переприменятся. Плюс в
    таблице две строки.
24. Прунинг `campaign_events` под доказательство `fingerprint()` — `fingerprint()`
    отбрасывает провенанс (`sourceObservationIds`, refs, payload), т.е. лицензировал бы
    удаление цепочки доказательств, доказав только форму графа. Плюс это
    преждевременное закрытие ADR 5.
25. Курсоры на подписчика для outbox — против объявленного не-цели («не вводим broker
    до появления нескольких независимых потребителей»).

**Отвергнуто в кандидате «ACK после ответственности»:**

26. `ConcurrencyScheduler.probe()` — дублирует логику конфликтов и вводит окно TOCTOU;
    не нужен, id инъектируемы.
27. Отображение ACK на `attempts.start()` — ACK у RTAP это `lease()`;
    лизить-и-отказывать поднимает `lease_generation` и зафенсило бы реальный летящий
    результат.
28. Удаление строки `AUTHORIZATION_DENIED` — регрессия безопасности: три из четырёх
    причин отказа не доходят до `AuditingAuthorizationProvider`, и терминализованная
    попытка — их единственный долговечный след.
29. Закон «каждая попытка подразумевает достигнутое решение авторизации» — вакуумный.
30. Приписывание этому кандидату закрытия гэпа 10 — не его путь.

---

## 4. Непроверенные зацепки на потом

Всё ниже — **НЕ проверено индивидуально против кода RTAP**, в отличие от шести пунктов
выше. Сгруппировано по гэпу, потому что сама конвергенция — сигнал: гэп 8 независимо
номинирован шесть раз, гэп 10 — ещё пять сверх принятого.

**Гэп 8 (дрейф ID законов), 7 номинаций:** 03 §37.1-37.2 — алиасы участвуют в поиске,
но не в дедупликации канонических имён (единственный путь без big-bang переименования);
05 §72 — неразрешимый ID это ошибка, а не тихий негатив (важно: локальный `held(lawId)`
в `admission.ts` при опечатке молча даёт NOT_MET); 07 §107.2-107.3 — провенанс записи
каталога и объявленная политика коллизий; 10 §152/§161 — инвариант это идентичность,
формулировка документа это алиас; 11 §167 — именованные «затенённые» декларации; 14
§213 — замыкание цитирований, display-vs-dispatch; 01 §15/§25 — владение словарём
внутри ограниченного контекста.

**Гэп 10 (сверх принятого):** 03 §39.2/§43/§46 — терминал первым, очистка как
пост-терминальная сага с именованным владельцем и ретраем; 08 §117 — время жизни
резервации как тотальная функция от исхода; 10 §155 — идемпотентный fan-out последствий
+ реконсилятор расхождений; 11 §174 — release как тотальная функция с явным `RETAINED`;
14 §220 — at-rest инвариант с ограниченным восстановлением.

**Гэп 2 (флаг харденинга / допуск):** 03 §35 — bypass **ниже** непреодолимого ядра в
порядке приоритета (это буквально дизайн, которого требует формулировка критерия 14);
05 §73 — таблица приоритетов; 13 §199 — харденинг как объявленный профиль политики; 12
§193.1 — эффективный дескриптор, замороженный на попытке в момент допуска (делает «флип
флага не ослабляет фенсинг» доказуемым); 09 §136 — допуск как DiagnosticRun независимых
проб вместо четырёх ручных булевых; 13 §194 — решётка свидетельств с правилом
неповышения; 01 §4.1/§6.1 — флаг выбирает composition root, а не ветку.

**Гэп 9 (sandbox/egress refs):** 05 §74 — ref обязан разрешаться в проверенную запись
реестра, а не просто быть непустым (`'sandbox-1'` проходит сегодня); 07 §104/§113.1 —
решение авторизации и статус конфайнмента это два разных долговечных факта; 07 §105 —
PolicySnapshot с ревизией от содержимого (сегодня `policyRevision` — непрозрачная
строка без производителя); 10 §149 — «не загружено» не должно выглядеть как
«разрешено»; 03 §36 — декларация конкурентности может только сужать, никогда расширять
(сегодня `ConcurrencyDeclaration` приходит без провенанса).

**Гэпы 6/7 (доставка и удержание):** 11 §176 и 13 §196-197 — полосы outbox на
потребителя с независимыми курсорами (один `delivered_at` станет молча неверным при
втором потребителе); 03 §41 — единственный дренаж, front-requeue, явный dead letter; 08
§127 — водяной знак компакции: отсутствие обязано быть однозначным; 05 §71 —
validate-before-prune с направлением отказа «сохранить лишнее»; 01 §17.7 — трёхклассовая
таксономия событий.

**Гэп 1 (форма оркестратора):** 12 §179-180 — driving shells / turn process manager /
driven planes, ценно **негативным** утверждением о том, чем оркестратор владеть не
должен; 05 §70 — алгебра Continue/Terminal с ограничителями восстановления по причинам;
08 §126 — журнал прикладной транзакции с именованной компенсацией на стадию; 06
§88/§95 — один владелец жизненного цикла, много тонких приводных адаптеров; 14 §214 —
контракт «эффективного пула» адаптеров (сегодня каждый адаптер переобъявляет свою
тройку `ExecFn`/`ExecResult`/`RunResult`); 12 §188-190 — внутренняя причина терминала
против внешнего плана результата; 03 §39.5/§60 — завершение возвращается через журнал,
исполнитель структурно не может коммитить.

**Гэп 5:** 10 §152 / 09 §140 — промоушен решает про дайджест, активация обязана
проверить, что загрузился именно он (`mixer.ts` берёт `modelDigest` строкой от
вызывающего); 13 §199-200 — дайджест ≠ подпись, fail-closed промоушен (`signature`
вообще не читается в `promotion/`).

**Гэп 13 и производные read-модели:** 09 §135 — производная модель несёт версию кода,
который её свернул; 14 §223-224 — реестр поколений схем событий, unknown никогда не
«тихо пусто»; 14 §215 — перепись «объявлено против достижимо» (та же форма у гэпов 3,
11, 12); 03 §38.2/§57 — недоступная способность это записанный пробел покрытия, а не
тишина; 10 §158 — «отброшено» не равно «отсутствует» в конвейерах формирования плана.

**Латентные дефекты без номера гэпа:** 11 §171 — `FilesystemArtifactStore.put()` пишет
прямо в финальный контент-адресуемый путь, `get()` не перехеширует, т.е. краш оставляет
файл, имя которого утверждает несуществующий sha256 — **под этим лежат все Finding**; 11
§170 — типизированная полнота нативного результата (обрезанный прогон читается как
«мало находок», т.е. как устойчивая цель); 10 §148 — два канала ошибок: `{ok:false,
error}` адаптеров строится из `err.message` и несёт stderr с атакующими payload-ами, а
законы о неразглашении payload покрывают только success-путь; 07 §109.2 —
`materializeEvidence()` без агрегатного бюджета и дедупликация через контент-адресацию
**поперёк границы доверия**; 06 §85 — стадийный composition root, где egress-способные
стадии идут после устанавливающих безопасность; 08 §117.1 — сужение способностей по
поверхности с deny-first редьюсером; 09 §143 — операторское разрешение как долговечное
продолжение с единственным претендентом; 05 §79 — долговечный командный inbox как
зеркало outbox.

---

## 5. Что этот заход не покрыл

Индивидуальной адверсариальной проверке против кода подверглись **шесть** кандидатов;
ещё около сорока пяти — нет, и всё в разделе 4 нужно считать гипотезами, а не выводами.
Глубина по документам крайне неровная: 01-04 разобраны построчно, 05-10 и 14 —
поверхностно, а 11-13 были выработаны прошлым заходом (одиннадцать записанных
трансферов) и здесь давали в основном повторы. Ни один кандидат не касается `frozen/`
(гэп 14), Rust-стороны, обучения и промоушена моделей (гэпы 5, 11) и внутренностей
фичевекторов/планировщика — и это не случайность: Arch_claude нечего сказать про
ML-конвейеры, там нет соответствующей поверхности.

Насчёт исчерпанности — ответ раздельный по осям. **Ось исполнения и долговечности
практически выработана:** шесть независимых номинаций на гэп 8 и пять на гэп 10
означают, что оставшийся материал начал повторяться, и каждая новая формулировка
описывает уже понятую проблему другими словами. **Ось поверхностей доставки и
политики/конфайнмента (гэпы 6 и 9) не выработана вовсе** — документы 07, 08, 13, 14 про
клиентский рантайм, прикладные workflow, UI и операции, то есть ровно про слои, которых
у RTAP нет. Но добывать их **сейчас преждевременно**: без кода эти паттерны нечем
атаковать, и проверка выродится в пересказ. Их время — начало Фазы 7.

Главный же вывод для приоритизации другой и он неприятный: из шести выживших только
один инвариант (02 §19.1) оказался по-настоящему новым; всё остальное выводится из
собственной вики RTAP — `EXECUTION_SAFETY_RECOVERY.md` §9, `ADAPTIVE_REDTEAM_RUNTIME.md`
§11, `FROZEN_INTEGRATION.md` §1/§3.3, `RUNBOOK.md` часть B, `ARCHITECTURE.md` §4.
Дальнейшая добыча Arch_claude имеет меньшую предельную ценность, чем реализация того,
что RTAP уже сам для себя специфицировал и не написал.
