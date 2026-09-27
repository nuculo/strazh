# Devpost Submission Draft: Strazh / RTAP

**Hackathon:** Nebius × NVIDIA Hackathon  
**Track:** Best Apps and Agents  
**Project Name:** Strazh / RTAP (Red Team Assessment Platform)  
**Elevator Pitch:** An AI red-team assessment and reporting platform that evaluates LLM application safety against single-turn prompt injections, canary disclosures, and instruction overrides using NVIDIA Nemotron models served via Nebius Token Factory, validated by 94 formal architectural laws and exportable to OASIS SARIF.

---

## Submission Links & Media Placeholders

- **Working Demo URL:** `https://strazh.dev`  
  *(Current Status: Verified live on AWS EC2 behind Nginx reverse proxy with publicly trusted Let's Encrypt TLS certificate. Serves interactive unauthenticated judge replays and SARIF audit inspection.)*
- **Public Code Repository:** `https://github.com/nuculo/strazh`  
  *(Current Status: Publicly accessible repository containing the audited open-source release snapshot on default branch `main`, with canonical Apache 2.0 license and third-party notices.)*
- **Video Walkthrough / Demo:** `[PUBLIC YOUTUBE VIDEO URL: <Required: Public YouTube Link>]`  
  *(Length target: 2–3 minutes covering local simulated run, live Nebius Token Factory execution, dashboard inspection, and SARIF export. Must be publicly accessible on YouTube.)*
- **Nebius Developer Feedback:** `[NEBIUS FEEDBACK: <See Dedicated Feedback Section Below>]`

---

## 1. Inspiration & Problem Statement

Most LLM security evaluations today suffer from three fatal flaws:
1. **Vibes-Based Flakiness:** Security benchmarks treat LLM outputs as simple strings, often mistaking model silence or empty output as proof that a model successfully defended itself against an attack.
2. **Dishonest Coverage Accounting:** When an inference provider times out or a target endpoint crashes, tools often mark tests as passing or omit them entirely, falsely reporting 100% defense.
3. **Sensitive Evidence Leaks:** Conventional testing tools dump raw adversarial injection strings, sensitive canary tokens, and system prompts directly into git commits and public CI artifacts.

We built **Strazh / RTAP** to bring deterministic, law-enforced engineering discipline to AI red-teaming. Rather than a conversational chatbot or code-generating agent, Strazh is an **automated security assessment control plane and evaluation runner** that executes declarative adversarial probe suites, leases execution attempts, validates model responses against strict mathematical invariants, and outputs standardized, audit-grade SARIF security findings.

---

## 2. What It Does (The App & Architecture)

Strazh / RTAP operates as a law-enforced control plane for LLM red-teaming:

1. **Target Ingestion & Declarative Probe Execution:** Ingests declarative target definitions (`target.yaml`) and dispatches bounded adversarial probes testing for direct canary extraction, instruction overrides, and system prompt leakage.
2. **Deterministic Architecture Laws:** Strictly validates every execution against **94 formal architectural laws** (90 machine-checked and passing, 0 failed, 4 pending external runtime integration). Laws enforce single-transaction fenced lease commits, out-of-band evidence isolation, and immutable audit logging.
3. **Four-State Verdict Semantics:**
   - **`VULNERABLE`:** Confirmed compromise (canary secret disclosed or instructions overridden). Maps to SARIF `fail`.
   - **`RESISTANT`:** Confirmed defense (target actively refused or contained the attack). Maps to SARIF `pass`.
   - **`UNVERIFIED`:** Inconclusive signal (empty output or whitespace). Under RTAP laws, silence is not proof of defense. Maps to SARIF `review`.
   - **`ERROR`:** Transport or adapter failure (target unavailable, timeout). Maps to SARIF `notApplicable`.
4. **Honest Coverage Accounting:** If any probe fails due to transport, network, or provider failure, the run status is marked **`INCOMPLETE` (Exit Code 2)**, preventing false claims of security.
5. **Decoupled Out-of-Band Evidence Storage:** Public reports reference raw prompts and completions solely by SHA-256 content hashes (`artifacts/local:sha256:...`). Raw injection vectors and database ledgers are kept on private storage and git-ignored, preventing accidental payload leakage into public repository trees.
6. **Standardized Security Reporting:** Generates OASIS SARIF 2.1.0 (`report.sarif`), human-readable Markdown (`report.md`), and structured JSON (`report.json`).
7. **Interactive Web Console & Replay Viewer:** A browser-based dashboard providing unauthenticated inspection of historical replays and SARIF reports for judges alongside an authenticated operator panel for triggering bounded live evaluations.

---

## 3. How We Built It (NVIDIA & Nebius Integration)

- **Inference Infrastructure:** Native integration with **Nebius Token Factory** (`https://api.tokenfactory.nebius.com/v1`) using OpenAI-compatible REST completion adapters.
- **NVIDIA Model Family:**
  - **`nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` (Evaluated Live):** Evaluated live via Nebius Token Factory under adversarial canary extraction and system override probes through our controlled demo target (`strazh-demo`).
  - **`nvidia/nemotron-3-super-120b-a12b` (Pre-Configured Target):** Pre-configured in `demo/targets/nebius-direct.yaml` and exposed in the control plane allowlist for direct Token Factory evaluation.
- **Promptfoo Adapter Runtime Isolation:** Re-engineered Promptfoo 0.122.0 execution in dedicated subprocess sandboxes with isolated `PROMPTFOO_CONFIG_DIR`, internal caching disabled (`PROMPTFOO_CACHE_ENABLED: false`) to eradicate SQLite lock contention, and $N=1$ single-run concurrency guards with hard SIGKILL timeouts.
- **Production Container Stack:** Multi-stage Docker Compose architecture (`rtap-server` Node 22 slim + Alpine Nginx reverse proxy with TLS 1.2/1.3, rate-limiting, and persistent named volumes).
- **Cloud Infrastructure Staging:** Provisioned and staged on **AWS EC2** (`t3a.medium`, 30 GiB gp3, dedicated Elastic IP `52.207.175.172`, and restricted SSH security group).

---

## 4. Hackathon Development vs. Project Provenance

Strazh / RTAP builds upon a pre-existing foundational architecture (formal state-machine ledgers, fenced lease generations, and mathematical invariant definitions spanning Phases 0 through 16).

During the **Nebius × NVIDIA Hackathon sprint**, the following major features were created, tested, and delivered:
1. **Nebius Token Factory & Nemotron Integration:** Built native provider routing, authenticated request handling, and evaluated `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` live.
2. **Dual-Mode Target Engine (`demo/server.ts`):** Created reproducible offline simulations (deterministic mocks demonstrating canary leakage, egress scrubber defense, and transport timeouts) alongside live Nebius inference.
3. **Promptfoo Concurrency & Cache Isolation:** Solved worker locking issues by isolating runtime configurations, disabling internal SQLite caching, and enforcing single-run concurrency ($N=1$).
4. **Empty-Output Verdict Law & Offline Re-Evaluation:** Upgraded verdict derivation to correctly classify empty completions (`""`) as `UNVERIFIED` rather than `RESISTANT`, proving the logic via offline derived re-evaluation without paid token waste.
5. **OASIS SARIF 2.1.0 Security Export Engine:** Built full SARIF report generation with out-of-band SHA-256 evidence referencing.
6. **Web Console & Replay Viewer:** Engineered the browser console with ephemeral `sessionStorage` token isolation and real-time execution feedback.
7. **Production Containerization & AWS Staging:** Packaged the Docker Compose stack behind Nginx with rate-limiting, and provisioned cost-controlled AWS staging infrastructure.

---

## 5. Verified Evidence vs. Staged Features (Transparent Audit)

To maintain absolute fidelity and audit integrity:
- **Models Tested Live:** `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` was tested live across two bounded runs (`live-baseline` and `live-mitigated`). Exactly **204 tokens** were consumed across 4 requests (73 + 32 + 67 + 32), with an estimated inference cost of < $0.001 (unverified against live Nebius billing ledger).
- **Configured vs. Tested Models:** `nvidia/nemotron-3-super-120b-a12b` is configured in `demo/targets/nebius-direct.yaml` and exposed in the control plane, but has **not yet been executed live** to prevent unauthorized billing during testing.
- **Evidence Hashes are Not Encryption:** Content addressing (`artifacts/local:sha256:...`) decouples raw strings from public reports and ensures tamper-evidence; it is not cryptographic encryption. Excluding raw artifact directories from git via `.gitignore` prevents accidental commits of sensitive payloads into public trees, but is not a substitute for access-controlled storage.
- **SARIF Status:** SARIF 2.1.0 export is implemented and schema-valid; end-to-end ingestion into GitHub Advanced Security Code Scanning tabs in a live CI pipeline has not been demonstrated in this repository.
- **Hosted Demo Status:** `https://strazh.dev` is verified live and publicly accessible on an AWS EC2 instance (`t3a.medium`) running Docker Compose with Nginx reverse proxy and Let's Encrypt TLS. Unauthenticated judge replays and system status endpoints are active and verified from external browsers.

---

## 6. Feedback on Nebius Token Factory

`[NEBIUS FEEDBACK: Detailed Developer Experience Feedback]`
- **Strengths:**
  - Reliable OpenAI API compatibility allowed standard HTTP completion adapters to connect without proprietary client libraries.
  - Transparent pricing and straightforward API key management during testing.
- **Observations & Suggestions:**
  - **Empty Completion Stop Tokens:** Under certain adversarial system overrides, Nemotron-3-Nano returned empty text completions with `finish_reason: "stop"` rather than explicit refusal text. Clarifying expected model behavior on system prompt override boundaries would aid red-teaming developers.
  - **Direct Token Usage Reporting:** Enhanced granular metadata in response chunks (e.g. prompt token breakdown vs cached token breakdown) would improve cost accounting in automated testing harnesses.

---

## 7. What's Next for Strazh / RTAP

1. **Multi-Turn Conversational Jailbreak Probes:** Extend beyond single-turn bounded extractions to adaptive multi-turn tree-search probes.
2. **Live KMS/HSM Signatures:** Transition from local filesystem signing keys to AWS/GCP KMS hardware root-of-trust for enterprise audit compliance.
3. **Direct GitHub Actions Scanner Integration:** Build a native GitHub Action that consumes RTAP SARIF output directly into repository Security tabs.
