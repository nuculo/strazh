# RTAP Architectural & Workspace Reconciliation Report

**Date:** 2026-09-26  
**Repository:** `https://github.com/nuculo/red_team` (`feat/live-promptfoo-proof`)  
**Scope:** Workspace inspection of repository files, dependencies, and execution harnesses.

---

## 1. Executive Summary & Purpose

This reconciliation report documents the objective codebase audit conducted to evaluate discrepancies between conversational assertions regarding external architecture (specifically claims of GitLab CI pipelines, GitLab-managed components, and Rust-based assessment runners/microservices) and the physical codebase present in the inspected repository checkout.

---

## 2. Methodology & Inspection Scope

A comprehensive filesystem and repository audit was conducted across the checkout:

1. **Repository Topology & Version Control:**
   - Remote URL: `https://github.com/nuculo/red_team`
   - Active Branch: `feat/live-promptfoo-proof`
   - CI/CD Workflows: `.github/workflows/` (GitHub Actions)
   - Commit History: Linear commit progression from Phase 0 (`2ea4553`) through M0 (`15484ec`), M1 (`4d01594`), M1 correctness pass (`157d9ec`), and local dashboard implementation (`d1960a0`).

2. **Language & Toolchain Scans:**
   - Rust toolchain search: Pattern matching for `Cargo.toml`, `Cargo.lock`, `*.rs`.
   - GitLab configuration search: Pattern matching for `.gitlab-ci.yml`, `gitlab-ci/`, `.gitlab/`.
   - Build manifests: Root and package manifests (`rtap/package.json`, `rtap/tsconfig.json`, `rtap/vitest.config.ts`).
   - Adapters and runtime engines: `rtap/src/adapters/` and `_tooling/promptfoo-runtime/`.

---

## 3. Findings & Evidence

### 3.1 Codebase Reality: TypeScript / Node.js Architecture
- **Primary Runtime:** The Red_Team Assessment Platform (`rtap`) is implemented entirely in TypeScript targeting Node.js (`ES2022`, module resolution `NodeNext`).
- **Dependencies & Tools:** Managed via npm (`@google/genai`, `commander`, `better-sqlite3`, `zod`, `vitest`).
- **Control Plane Boundaries:**
  - Per `wiki/Arch_Overlay/ARCHITECTURE.md` and `.cursorrules`, the RTAP Control Plane is the sole mediation bus, authority, and orchestration boundary.
  - External harnesses (`promptfoo`, `duo-agents`) serve strictly as external adapters and are not the source of security truth.
  - Raw attack payloads and LLM completions are isolated in the local content-addressed ArtifactStore (`local:sha256:...`) and are never inlined into public reports (`redteam.artifact/public-report-never-inlines-payload`).

### 3.2 Evaluation of GitLab Components
- **Checkout Scan:** No `.gitlab-ci.yml`, `.gitlab/` directory, or GitLab pipeline configuration exists within the repository.
- **Remote Host:** The remote tracking origin is hosted on GitHub (`https://github.com/nuculo/red_team`).

### 3.3 Evaluation of Rust Components
- **Checkout Scan:** Zero `.rs` source files, `Cargo.toml` manifests, or compiled Rust binaries were found in the inspected checkout.
- **Persistence & Execution:** All persistence and execution logic is handled through Node.js and SQLite (`better-sqlite3`).

---

## 4. Precise Reconciliation Conclusion

> **Conclusion:**
> The claimed GitLab/Rust components were **not found** in the inspected repository/workspace.
>
> This finding reflects the verified state of the inspected checkout at the time of audit. It does **not** conclude that such components never existed elsewhere (such as in private external repositories, unmerged branches, or separate infrastructure environments).
