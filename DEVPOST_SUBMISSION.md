# Devpost Submission Draft: Strazh / RTAP

**Hackathon:** Nebius × NVIDIA Hackathon  
**Track:** Best Apps and Agents  
**Project Name:** Strazh / RTAP (Red Team Assessment Platform)  
**Elevator Pitch:** An AI red-team assessment and reporting platform that evaluates LLM application safety against single-turn prompt injections, canary disclosures, and instruction overrides using NVIDIA Nemotron models served via Nebius Token Factory, validated by formal architectural laws (94 defined, 90 passing, 4 pending) and exportable to OASIS SARIF.

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

Security evaluations of LLMs and generative AI applications face three difficult engineering challenges:
1. **Non-Evaluable Outputs & Silent Failures:** When a model returns empty content or whitespace under attack, naive evaluation harnesses that only test negative assertions (such as `not-contains`) can mistakenly score silence as successful defense.
2. **Incomplete Coverage Masking:** If an inference provider times out or an endpoint crashes during an evaluation run, tools that do not enforce strict coverage accounting can drop or ignore failed probes, masking the failure and giving false assurance.
3. **Sensitive Payload Exposure:** Evaluating prompt injections and canary tokens requires handling confidential strings that should not be inlined directly into shared reports, public repositories, or CI logs.

We built **Strazh / RTAP** to address these challenges with law-enforced engineering discipline. Rather than a conversational chatbot or code-generating agent, Strazh is an **automated security assessment control plane and evaluation runner** that executes declarative adversarial probe suites, leases execution attempts, validates model responses against formal architectural laws, and outputs standardized, audit-grade SARIF security findings.

---

## 2. What It Does (The App & Architecture)

Strazh / RTAP operates as a law-enforced control plane for LLM red-teaming:

1. **Target Ingestion & Declarative Probe Execution:** Ingests declarative target definitions (`target.yaml`) and dispatches bounded adversarial probes testing for direct canary extraction, instruction overrides, and system prompt leakage.
2. **Deterministic Architecture Laws:** Strictly validates every execution against formal architectural laws (**94 defined, 90 passing, 4 pending** external runtime integration). Laws enforce single-transaction fenced lease commits, out-of-band evidence isolation, and immutable audit logging.
3. **Four-State Verdict Semantics:**
   - **`VULNERABLE`:** Confirmed compromise (canary secret disclosed or instructions overridden). Maps to SARIF `fail`.
   - **`RESISTANT`:** Confirmed defense (target actively refused or contained the attack). Maps to SARIF `pass`.
   - **`UNVERIFIED`:** Inconclusive signal (empty output or whitespace). Under RTAP laws, silence is not proof of defense. Maps to SARIF `review`.
   - **`ERROR`:** Transport or adapter failure (target unavailable, timeout). Maps to SARIF `notApplicable`.
4. **Honest Coverage Accounting:** If any probe fails due to transport, network, or provider failure, the run status is marked **`INCOMPLETE` (Exit Code 2)**, preventing false claims of security.
5. **Decoupled Out-of-Band Evidence Storage:** Public reports reference raw prompts and completions solely by SHA-256 content hashes (`artifacts/local:sha256:...`). Storing evidence out-of-band and keeping raw artifact directories out of git reduces exposure in public reports and commits, without relying on hashes alone for confidentiality.
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
- **Evidence Hashes & Out-of-Band Storage:** Content addressing (`artifacts/local:sha256:...`) and out-of-band storage decouple raw payload strings from public reports and reduce exposure in public repositories and commits; content hashes alone are not encryption and do not replace access control.
- **SARIF Status:** SARIF 2.1.0 export is implemented and schema-valid; end-to-end ingestion into GitHub Advanced Security Code Scanning tabs in a live CI pipeline has not been demonstrated in this repository.
- **Hosted Demo Status:** `https://strazh.dev` is verified live and publicly accessible on an AWS EC2 instance (`t3a.medium`) running Docker Compose with Nginx reverse proxy and Let's Encrypt TLS. Unauthenticated judge replays and system status endpoints are active and verified from external browsers.

---

## 6. Feedback on Nebius Token Factory & NVIDIA Tools

### Nebius Token Factory
- **Strengths:**
  - **OpenAI REST Compatibility:** Seamless integration with standard HTTP completion adapters without requiring proprietary client SDKs.
  - **Predictable Latency & High Availability:** Fast round-trip times on completions during live bounded runs against `https://api.tokenfactory.nebius.com/v1`.
  - **Transparent Pricing & Token Counting:** Clear token usage reporting in completion payloads enabled precise tracking of the 204 tokens consumed.
- **Observations & Developer Suggestions:**
  - **Granular Usage Breakdown:** Adding detailed breakdown for cached prompt tokens vs. uncached prompt tokens in response chunks would assist automated cost-accounting harnesses.
  - **Stop Reason Documentation:** Under certain adversarial system overrides, Nemotron-3-Nano returned empty text completions with `finish_reason: "stop"`. Clearer documentation on provider-level safety filters vs. model-level EOS stops would help red-team tooling categorize responses more easily.

### NVIDIA Nemotron Models
- **Strengths:**
  - **Built-in Guardrails Against Direct Extraction:** In our live baseline tests, `nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` demonstrated impressive inherent resistance to direct canary disclosure without requiring heavy prompt engineering.
  - **Compact Footprint with High Instruction Adherence:** Nano-30B offers fast inference suitable for high-throughput security pipeline scanning.
- **Observations & Developer Suggestions:**
  - **Response Behavior on Adversarial Boundary Probes:** When subjected to conflicting system instructions (override attempts), the model returned an empty text completion (`""`) with `finish_reason: "stop"` rather than an explicit explanatory refusal. While safe from disclosure, an empty completion does not positively prove containment, reinforcing the necessity of Strazh's `UNVERIFIED` verdict law.

---

## 7. Challenges We Ran Into

1. **Subprocess Concurrency & SQLite Locks:** Integrating Promptfoo into an automated control plane initially ran into SQLite lock contention during parallel evaluations. We resolved this by isolating execution environments with dedicated `PROMPTFOO_CONFIG_DIR`, disabling internal caching (`PROMPTFOO_CACHE_ENABLED: false`), and enforcing single-run concurrency ($N=1$).
2. **The "Silence is Defense" Epistemic Trap:** In our first live baseline evaluation, empty model responses on instruction override probes were naively scored as `RESISTANT`. We caught this flaw, codified the invariant into our architectural laws, and developed offline derived re-evaluation to prove the fix without re-spending API tokens.
3. **Preventing Evidence Exposure:** Red-team evaluation tools often accidentally expose the very payloads they test into git logs or public reports. Designing the out-of-band SHA-256 content-addressing architecture ensured that public reports reference artifacts by digest while keeping raw payloads on private storage.

---

## 8. Accomplishments That We're Proud Of

- **Extensive Deterministic Test Suite:** **109 test files and 757 test cases** passing with zero flakiness (`npm test`).
- **Formal Architectural Law Enforcement:** **94 architectural laws defined, with 90 passing deterministically** (`npm run laws`) and 4 pending external runtime integration.
- **Production Staging & Working Demo:** Deployed live on AWS EC2 at `https://strazh.dev` (and `https://www.strazh.dev`) with Let's Encrypt TLS and a zero-inference interactive replay console for judges.
- **Honest Security Accounting:** Strict exit code discipline (Exit Code 2 on partial/interrupted runs) ensuring security teams never mistake a dropped probe for a secure system.

---

## 9. What We Learned

- **Deterministic Evaluation Over Vibes:** Security testing LLMs requires deterministic invariants, transaction fencing, and state-machine rigor rather than assuming silent models defended themselves.
- **Epistemic Humility in Grading:** A model remaining silent is not evidence that it defended against an attack—automated tools must explicitly distinguish between verified resistance and unverified silence.

---

## 10. What's Next for Strazh / RTAP

1. **Multi-Turn Conversational Jailbreak Probes:** Extend beyond single-turn bounded extractions to adaptive multi-turn tree-search probes.
2. **Hardware KMS/HSM Signatures:** Transition from local filesystem signing keys to AWS/GCP KMS hardware root-of-trust for enterprise compliance (addressing pending Law 90).
3. **Direct GitHub Actions Scanner Integration:** Build a native GitHub Action that consumes RTAP SARIF output directly into repository Security tabs.
