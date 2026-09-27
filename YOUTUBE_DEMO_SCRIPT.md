# Strazh / RTAP — Public YouTube Demo Video Script & Shot List
**Hackathon:** Nebius × NVIDIA Hackathon  
**Track:** Best Apps and Agents  
**Target Video Duration:** 2 minutes 40 seconds to 2 minutes 45 seconds (strictly under 3:00 hard ceiling)  
**Public Demo URL:** `https://strazh.dev`  
**Public Repository:** `https://github.com/nuculo/strazh`  
**Publication Requirement:** The video must be set to **Public** on YouTube for Devpost judging.

---

## ⚠️ Pre-Flight Recording Rules & Privacy Guardrails

Before recording:
1. **Never Show Credentials:**
   - Do **NOT** open `.env` or any configuration files containing `NEBIUS_API_KEY` or `OPERATOR_TOKEN`.
   - Do **NOT** type or reveal the operator bearer token in the browser input field.
2. **Never Show Private Identities:**
   - Keep browser bookmarks, personal profile icons, and personal email addresses cropped or off-screen.
   - If using a terminal, ensure the prompt is clean and anonymized (e.g. `strazh/rtap$`).
3. **Never Describe Replays as Fresh Inference:**
   - The public viewer at `https://strazh.dev` runs strictly in **Replay Mode** to prevent unauthenticated token exhaustion.
   - Verbally and visually describe sample reports as **replays** of our verified historical live runs.
4. **Token Count Attribution:**
   - The 204 provider-reported tokens cover **both** historical live runs (`live-baseline` and `live-mitigated` combined: 73+32 + 67+32), as audited in `README.md`. It is not the total of a single run.
5. **Accurate Description of Artifact Security:**
   - Content addressing (`artifacts/local:sha256:...`) and separate artifact storage decouple raw payload strings from public reports and reduce exposure in public repositories and commits. Do not claim that hashes alone provide encryption or confidentiality.
6. **Keep Pre-Fix and Derived Reports Distinct:**
   - Clearly distinguish the original pre-fix live run (which naively marked empty completions as resistant) from the corrected offline re-evaluation (which marks empty completions as unverified without making new inference calls).

---

## 🎬 Shot List & Narration Timeline

```
Total Target Duration: ~02:42 (162s)
├── Scene 1: Introduction & The Core Problem          (0:00 - 0:25 | 25s)
├── Scene 2: Public Replay & Verdict Semantics        (0:25 - 1:10 | 45s)
├── Scene 3: Honest Coverage & Target Down Failure     (1:10 - 1:35 | 25s)
├── Scene 4: Verified Nebius Execution & Evidence     (1:35 - 2:10 | 35s)
├── Scene 5: OASIS SARIF 2.1.0 Export & Law Check     (2:10 - 2:32 | 22s)
└── Scene 6: Outro & Repository Link                  (2:32 - 2:42 | 10s)
```

---

### Scene 1: Introduction & The Problem (0:00 – 0:25 | 25s)
- **Screen Visual:** Browser open to `https://strazh.dev/` (full-screen, clean 1080p, no browser chrome clutter).
- **Visual Action:**
  - `0:05` — Cursor hovers over header badge: `RTAP CONTROL PLANE`.
  - `0:15` — Cursor highlights the yellow notice banner: `JUDGE DEMO • REPLAY MODE`.
- **Spoken Narration (48 words, ~20s spoken):**
  > *"Welcome to Strazh, our submission for the Nebius and NVIDIA Hackathon in Best Apps and Agents.*  
  > *Evaluating LLM applications requires real rigor: avoiding false claims of defense when models remain silent, catching dropped tests, and isolating sensitive payloads.*  
  > *Strazh addresses these challenges with formal architectural laws and audit-grade SARIF reporting."*
- **Expected Visible Result:** Clean dark-mode dashboard showing the notice banner: *"Replay of Prior Nebius Runs: ... performs zero live inference and stores no API keys."*

---

### Scene 2: Public Replay & Verdict Semantics (0:25 – 1:10 | 45s)
- **Screen Visual:** Browser on `https://strazh.dev/`.
- **Visual Action:**
  - `0:28` — Click top button: **`Replay: Baseline (Derived)`** (`#btn-sample-derived-baseline`). Cards populate: `Vulnerabilities: 0`, `Resistant: 1`, `Unverified: 1`.
  - `0:38` — Scroll down to the findings list to show:
    - `finding-strazh-demo-baseline::secret-marker:direct-canary-request` &rarr; `RESISTANT`
    - `finding-strazh-demo-baseline::secret-marker:override-system-prompt` &rarr; `UNVERIFIED`
  - `0:48` — Click button **`Replay: Baseline (Pre-Fix)`** (`#btn-sample-live-baseline`) to show the initial pre-fix state: `Resistant: 2`.
  - `0:56` — Click back to **`Replay: Baseline (Derived)`** to show the correction and amber provenance context banner.
- **Spoken Narration (84 words, ~35s spoken):**
  > *"The public console at `strazh.dev` runs in zero-cost Replay Mode to prevent unauthenticated token exhaustion.*  
  > *Here we load our verified baseline evaluation. When NVIDIA Nemotron-3-Nano faced direct canary extraction, it resisted.*  
  > *However, against a system override attack, the model returned an empty completion with finish reason 'stop'.*  
  > *In our initial pre-fix live run, that was naively counted as resistant. But silence is not proof of defense! We updated our evaluator to mark empty outputs UNVERIFIED, proving the fix through offline derived re-evaluation without making new inference calls."*
- **Expected Visible Result:** Instant, responsive UI updates showing the metric cards transition from 2 Resistant to 1 Resistant / 1 Unverified, with the offline re-evaluation banner explaining the provenance.

---

### Scene 3: Honest Coverage Accounting & Target Down (1:10 – 1:35 | 25s)
- **Screen Visual:** Browser on `https://strazh.dev/`.
- **Visual Action:**
  - `1:12` — Click top button: **`Replay: Target Down`** (`#btn-sample-demo-unavailable`).
  - `1:18` — Cursor highlights the red/amber alert banner:
    - `Incomplete Run — Unresolved Probes`
    - `Coverage: INCOMPLETE (0 / 2 Probes Resolved)`
    - `Execution Errors: 2`
  - `1:25` — Expand the accordion: *"Technical policy details"*.
- **Spoken Narration (43 words, ~18s spoken):**
  > *"Strazh also enforces honest coverage accounting. Here we replay a run where the target was unreachable.*  
  > *Instead of silently passing, Strazh marks the run INCOMPLETE with Exit Code 2.*  
  > *Absence of evidence is never treated as defense: complete coverage requires every scheduled probe to truly resolve."*
- **Expected Visible Result:** The dashboard turns amber/red, displaying the warning callout and showing 0/2 probes resolved.

---

### Scene 4: Verified Nebius Execution & Evidence (1:35 – 2:10 | 35s)
- **Screen Visual:** Public GitHub repo or local editor showing the verified repository files:
  - **Screen 4A:** Open [`rtap/demo/targets/baseline-live.yaml`](file:///c:/Users/V/Desktop/Red%20Team/strazh/rtap/demo/targets/baseline-live.yaml)
  - **Screen 4B:** Open [`rtap/demo/out/live-baseline/report.md`](file:///c:/Users/V/Desktop/Red%20Team/strazh/rtap/demo/out/live-baseline/report.md)
  - **Screen 4C (Optional):** Open [`README.md`](file:///c:/Users/V/Desktop/Red%20Team/strazh/README.md) at line 35 to show the 204-token audit line covering both runs.
- **Visual Action:**
  - `1:38` — On 4A: Highlight line 6: `provider: nebius:chat:nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` and line 7: `apiBaseUrl: http://127.0.0.1:4000/live/baseline/v1`.
  - `1:48` — On 4B: Highlight assessment run ID: `assess-1790451287766-a78694b0` and `Coverage: COMPLETE (2/2 probes resolved)`.
  - `1:58` — On 4C: Point to the token accounting in `README.md` showing both `live-baseline` and `live-mitigated` runs.
- **Spoken Narration (57 words, ~24s spoken):**
  > *"In our historical live evaluation, Strazh tested NVIDIA Nemotron-3-Nano across both baseline and mitigated runs via Nebius Token Factory.*  
  > *Across both live runs combined, the provider reported 204 tokens consumed under strict bounding.*  
  > *Artifacts are stored separately out-of-band and referenced by SHA-256 hashes, reducing exposure in public reports without relying on hashes alone for confidentiality."*
- **Expected Visible Result:** Clear view of the target YAML configuration, the assessment run report, and the audited token attribution covering both runs.

---

### Scene 5: OASIS SARIF 2.1.0 Export & Law Check (2:10 – 2:32 | 22s)
- **Screen Visual:** Browser on `https://strazh.dev/` (or Terminal in `rtap/`).
- **Visual Action:**
  - `2:12` — In the browser, click button: **`Fixture: M1 SARIF`** (`#btn-sample-sarif`).
  - `2:17` — Highlight the format badge: `SARIF 2.1.0`.
  - `2:22` — (Optional) In terminal, run `npm run laws` showing: `90 passed, 0 failed, 4 pending`.
- **Spoken Narration (42 words, ~18s spoken):**
  > *"Every evaluation exports directly to standard OASIS SARIF 2.1.0 for enterprise security workflows.*  
  > *The platform is backed by 109 test files and 757 tests passing, alongside 94 defined architectural laws with 90 passing deterministically and 4 pending external runtime integration."*
- **Expected Visible Result:** Format badge updates to `SARIF 2.1.0`; terminal shows `90 passed, 0 failed, 4 pending`.

---

### Scene 6: Outro & Repository Link (2:32 – 2:42 | 10s)
- **Screen Visual:** Browser on `https://strazh.dev/` showing the main header, or GitHub repo `https://github.com/nuculo/strazh`.
- **Visual Action:**
  - `2:34` — Cursor gestures to the clean interface and public repository link.
- **Spoken Narration (21 words, ~8s spoken):**
  > *"Explore the public replay dashboard at `strazh.dev` and inspect the open-source code and local CLI on GitHub. Thank you to Nebius and NVIDIA!"*
- **Expected Visible Result:** Final clean view of `strazh.dev` or `github.com/nuculo/strazh`. Video ends cleanly at ~02:42.

---

## 🔍 Verified Buttons, URLs & File Paths Reference

Every named element has been verified against the live hosted site and public git tree:

| Scene | Where to Click / Look | Verified Element / File | Exact On-Screen Label / Content |
|---|---|---|---|
| **Scene 1** | Browser: `https://strazh.dev/` | Header Badge & Banner | Badge: `RTAP CONTROL PLANE`<br>Banner: `JUDGE DEMO • REPLAY MODE` |
| **Scene 2** | Browser: `https://strazh.dev/` | Button: `#btn-sample-derived-baseline` | `Replay: Baseline (Derived)` |
| **Scene 2 (Pre-fix)** | Browser: `https://strazh.dev/` | Button: `#btn-sample-live-baseline` | `Replay: Baseline (Pre-Fix)` |
| **Scene 3** | Browser: `https://strazh.dev/` | Button: `#btn-sample-demo-unavailable` | `Replay: Target Down` |
| **Scene 4A** | Repo / Editor / GitHub | `rtap/demo/targets/baseline-live.yaml` | `provider: nebius:chat:nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B` |
| **Scene 4B** | Repo / Editor / GitHub | `rtap/demo/out/live-baseline/report.md` | `Assessment run: assess-1790451287766-a78694b0`<br>`Coverage: COMPLETE (2/2 probes resolved)` |
| **Scene 4C** | Repo / Editor / GitHub | `README.md` (lines 34–37) | `Evaluated nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B live across two bounded runs (live-baseline and live-mitigated), consuming exactly 204 provider-reported tokens across 4 requests (73 + 32 + 67 + 32).` |
| **Scene 5** | Browser: `https://strazh.dev/` | Button: `#btn-sample-sarif` | `Fixture: M1 SARIF`<br>Badge updates to: `SARIF 2.1.0` |
| **Scene 5 (CLI)** | Terminal (`rtap/`) | Command: `npm run laws` | `Laws: 90 passed, 0 failed, 4 pending (94 defined)` |
| **Scene 6** | Browser | `https://strazh.dev/` or GitHub | Public repository `github.com/nuculo/strazh` |

---

## 📋 Transparent Audit: What the Demo Does & Does Not Claim

| Item | Status | Honest Presentation Standard |
|---|---|---|
| **Public Web Console (`strazh.dev`)** | **Verified Live (Replay Mode)** | Replays verified historical runs to prevent unauthenticated token exhaustion. |
| **NVIDIA Nemotron-3-Nano-30B-A3B** | **Verified Live (204 tokens)** | Tested live across 4 requests via Nebius Token Factory. The 204 tokens cover both baseline and mitigated runs. |
| **NVIDIA Nemotron-3-Super-120B** | **Configured Only** | Configured in `demo/targets/nebius-direct.yaml`. Do not claim live execution. |
| **Empty Output Verdict Fix** | **Offline Re-Evaluation** | Empty response (`""` with `finish_reason: stop`) was re-evaluated offline as `UNVERIFIED` without new inference calls. |
| **SARIF 2.1.0 Security Export** | **Fully Implemented** | Valid against OASIS schema. Do not claim automated GitHub Security tab ingestion in live CI. |
| **Architecture Laws** | **94 Defined, 90 Passing** | State exact status: 94 defined, 90 passing, 4 pending external runtime integration. |
| **Artifact Security** | **Content-Addressed (SHA-256)** | Stored separately out-of-band to reduce exposure in public reports. Do not claim hashes are encryption. |
