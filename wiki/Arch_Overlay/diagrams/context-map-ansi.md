# Карта контекстов RTAP v2 — ANSI

> Сводная терминальная проекция [ARCHITECTURE.md §2](../ARCHITECTURE.md#2-карта-контекстов).
> Детальный Campaign Intelligence Context: [FROZEN_INTEGRATION.md](../FROZEN_INTEGRATION.md).

```text
┌────────────────────────────────────────────────────────────────────────┐
│ wiki/ — Published Language · JSON Schema · ADR · Architecture Laws     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ определяет контракты
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ RedTeam Assessment Platform — Control Plane                            │
│                                                                        │
│ Campaign Planner ─ Run Orchestrator ─ Observation Normalizer           │
│         ▲                                             │                │
│         │                                             ▼                │
│ FrozenSignal                        Finding Correlator                 │
│         │                                             │                │
│         │                                             ▼                │
│         │             JSON · Markdown · SARIF reports                  │
└─────────┼─────────────────────────────────────────────┬────────────────┘
          │                                             │ EngineAdapter ACL
          │                                             ├─────────────────────────────────┐
          │                                             ▼                                 ▼
                                                        ┌────────────────────────┐        ┌────────────────────────┐
                                                        │ promptfoo              │        │ duo-agents             │
                                                        │ LLM/Agent executor     │        │ static executor        │
                                                        │ production backbone    │        │ LLM path quarantined   │
                                                        └────────────┬───────────┘        └────────────┬───────────┘
          │                                                          │ Observation                     │ Observation
          │                                                          └────────────────┬────────────────┘
          │                                                                           │
          │                                                                           ▼
                                                           ┌─────────────────────────────────────────────────────┐
                                                           │ Feature Compiler v1                                 │
                                                           │ structured Observation + history → versioned V60    │
                                                           │ raw payload и frozen_embed НЕ используются          │
                                                           └──────────────────────────┬──────────────────────────┘
                                                                                      ▼
          │                                                ┌─────────────────────────────────────────────────────┐
          └────────────────────────────────────────────────┤ Frozen Campaign Intelligence Context                │
                                                           │                                                     │
                                                           │ CampaignWorld                                       │
                                                           │   immutable GraphSchema + CompiledModel             │
                                                           │   mutable DynamicState + epoch + binding            │
                                                           │   relations + events + episodic memory              │
                                                           │                                                     │
                                                           │ redteam-frozen-worker                               │
                                                           │   core.frz + domain.adp → advisory FrozenSignal     │
                                                           │   next probe · saturation · drift · anomaly         │
                                                           └──────────────────────────┬──────────────────────────┘
                                                                                      │ replay / signed artifacts
                                                                                      ▼
                                                           ┌─────────────────────────────────────────────────────┐
                                                           │ Persistence                                         │
                                                           │ Run Repository · Campaign Event Store               │
                                                           │ Protected Artifact Store · Signed Model Registry    │
                                                           └─────────────────────────────────────────────────────┘
```

## Границы доверия

```text
Execution engines  → evidence and native grading
Control Plane      → canonical Observation, Finding and Verdict
Frozen             → advisory planning signals, never canonical Verdict
Artifact Store     → exact cryptographic dedup, never FNV identity
Event Store        → source of truth; Frozen world is replayable materialization
```
