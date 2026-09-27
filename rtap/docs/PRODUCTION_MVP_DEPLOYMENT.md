# RTAP Production MVP: Deployment Topology & Domain Runbook (strazh.dev)

## 1. Overview & Architecture Preservation
The RTAP Production MVP exposes an authenticated, bounded operator interface on **`strazh.dev`** that drives the canonical RTAP control-plane execution pipeline:

$$\text{Web UI} \xrightarrow{\text{Auth (Bearer)}} \text{Server API} \xrightarrow{\text{Allowlist Check}} \text{RTAP Engine (\texttt{runAssessment})} \xrightarrow{} \text{Promptfoo Worker} \xrightarrow{} \text{Observation \& Evidence Stores} \xrightarrow{} \text{Reports \& SARIF}$$

### Critical Safety Invariants
1. **Zero Public Access to Model Inference or Target URLs:** Public users cannot submit arbitrary target URLs or custom Promptfoo evaluation configs. Only predefined approved targets from `APPROVED_TARGETS` (`src/server/targets.ts`) can be executed.
2. **Server-Side Secret Isolation:** `NEBIUS_API_KEY` is never delivered to or accessible from frontend code. It is injected exclusively into the server process environment (`process.env.NEBIUS_API_KEY`) and passed to scoped probe executions via `buildSandbox()`.
3. **Strict Concurrency Cap ($N=1$):** At most one assessment job can execute across the entire server instance simultaneously. Concurrent requests receive HTTP `429 Too Many Requests`.
4. **Execution Bounds & Kill Switch:**
   - Request Budget: Max 4 probe attempts per assessment run.
   - Per-Probe Timeout: 15,000 ms wall-clock limit with process-level SIGKILL termination.
   - Operator Kill Switch: `POST /api/assessments/:id/cancel` immediately aborts the active assessment via `AbortSignal`.

---

## 2. Domain Verification: `strazh.dev` & `kupol.app`
- **Primary Domain:** `strazh.dev` (Verified. Configured as the primary host for the RTAP Production MVP).
- **Secondary Domain Investigation:**
  - Repo records (`README.md`, `rtap/README.md`) confirm ownership of **`kupol.app`** (purchased for the Kupol guardrail system).
  - **`kupol.dev` is NOT recorded or controlled in this repository.** Do not configure DNS or TLS for `kupol.dev` unless domain acquisition is confirmed.

---

## 3. Container Backend Runtime & Production Orchestration

### Multi-Stage Container Image (`rtap/Dockerfile`)
The RTAP production backend builds reproducibly via multi-stage Node 22:
- **Build Stage:** Compiles TypeScript control plane (`src/`) and demo execution engine (`demo/`) into `dist/`.
- **Runtime Stage (`node:22-bookworm-slim`):**
  - Installs system packages: `ca-certificates`, `curl`, `git`, `python3`.
  - Installs pinned Promptfoo runtime (`0.122.0`) in `/opt/promptfoo-runtime`.
  - Mounts persistent volume at `/app/runs` for SQLite databases, probe configs, and separated public reports (`reports/report.json`, `reports/report.sarif`, `reports/report.md`).
  - Runs as unprivileged `node` user with isolated `HOME=/home/node`.
  - Health check probes `http://127.0.0.1:3000/api/system/status`.

### Production Docker Compose (`rtap/docker-compose.yml`)
```yaml
services:
  rtap-server:
    build:
      context: .
      dockerfile: Dockerfile
    image: rtap-server:latest
    container_name: rtap-production-server
    restart: unless-stopped
    environment:
      - NODE_ENV=production
      - PORT=3000
      - HOST=0.0.0.0
      - RTAP_DATA_DIR=/app/runs
      - OPERATOR_TOKEN=${OPERATOR_TOKEN}
      - NEBIUS_API_KEY=${NEBIUS_API_KEY:-}
      - NEBIUS_BASE_URL=${NEBIUS_BASE_URL:-https://api.tokenfactory.nebius.com/v1}
    volumes:
      - rtap-runs:/app/runs
    networks:
      - rtap-net
    expose:
      - "3000"

  nginx:
    image: nginx:1.27-alpine
    container_name: rtap-nginx-proxy
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./deploy/nginx/strazh.dev.conf:/etc/nginx/conf.d/default.conf:ro
      - ./deploy/certs:/etc/ssl/certs:ro
      - ./deploy/private:/etc/ssl/private:ro
      - certbot-www:/var/www/certbot:ro
    depends_on:
      rtap-server:
        condition: service_healthy
    networks:
      - rtap-net

volumes:
  rtap-runs:
    name: rtap_runs_data
  certbot-www:
    name: rtap_certbot_www

networks:
  rtap-net:
    name: rtap_production_network
```

### Private Repository Deployment (INTERNAL Repo Safety)
Because the GitHub repository `https://github.com/nuculo/red_team` is currently **INTERNAL**, standard unauthenticated `git clone` will fail.
**Strict Security Requirement:** Never pass personal access tokens (PAT) in URL strings (`https://token@github.com/...`) or shell history, and never bake GitHub credentials into Docker images or container filesystems.

#### Recommended Method: Dedicated Read-Only GitHub Deploy Key
1. Generate an isolated, passphraseless ed25519 deploy key on the deployment host:
   ```bash
   ssh-keygen -t ed25519 -f ~/.ssh/rtap_deploy_key -N "" -C "rtap-deploy@strazh.dev"
   ```
2. Display the public key:
   ```bash
   cat ~/.ssh/rtap_deploy_key.pub
   ```
3. Add to GitHub: Navigate to `https://github.com/nuculo/red_team` $\rightarrow$ **Settings** $\rightarrow$ **Deploy keys** $\rightarrow$ **Add deploy key**:
   - Title: `strazh-prod-deploy-readonly`
   - Key: Paste `rtap_deploy_key.pub`
   - Allow write access: **UNCHECKED** (strictly read-only)
4. Configure SSH on the host (`~/.ssh/config`):
   ```text
   Host github.com
     IdentityFile ~/.ssh/rtap_deploy_key
     IdentitiesOnly yes
     StrictHostKeyChecking accept-new
   ```
5. Clone using SSH cleanly without passwords or tokens:
   ```bash
   git clone -b release/public-hackathon git@github.com:nuculo/red_team.git /opt/red_team
   ```
*(Alternative: If deploy keys are not desired, use `ssh -A` with SSH agent forwarding from your local developer machine, or transfer the code via `rsync -avz --exclude '.git' --exclude 'node_modules' ./ user@host:/opt/red_team`.)*

### Zero-Leak Production Secret Provisioning (`.env`)
Never type, echo, or commit secret keys in command history. Secrets reside on the deployment host file system in `/opt/red_team/rtap/.env`, protected with `0600` permissions (`-rw-------`). Docker Compose injects them directly into container process memory; the `.env` file itself is **never mounted into any container volume**.

Execute this zero-leak script on the host to generate a fresh high-entropy operator token and silently capture your Nebius API key:
```bash
# 1. Silently prompt for the Nebius API key (no characters echoed to terminal):
echo -n "Enter Nebius API Key (input is masked): "
read -s NEBIUS_API_KEY
echo ""

# 2. Atomically create .env with strict 0600 permissions
(umask 077 && cat <<EOF > /opt/red_team/rtap/.env
NODE_ENV=production
OPERATOR_TOKEN=$(openssl rand -hex 32)
NEBIUS_API_KEY=${NEBIUS_API_KEY}
NEBIUS_BASE_URL=https://api.tokenfactory.nebius.com/v1
EOF
)

# 3. Immediately scrub shell variables from environment
unset NEBIUS_API_KEY
```
Verification of file protection:
```bash
ls -l /opt/red_team/rtap/.env
# Must show: -rw------- 1 <user> <user> ...
```

---

## 4. Cloudflare DNS, Origin CA & TLS Configuration for `strazh.dev`

### Cloudflare Origin CA Invariant
> **CRITICAL ARCHITECTURAL FACT:** A Cloudflare Origin CA certificate is issued by Cloudflare's internal Certificate Authority. It is **specifically designed for traffic proxied through Cloudflare (Orange Cloud)**.
> - When Cloudflare proxy is active, the visitor's browser trusts Cloudflare's public Edge certificate, while Cloudflare connects to your origin server over HTTPS trusting the Origin CA certificate.
> - Direct browser connections to your server IP using an Origin CA certificate will show an untrusted CA warning. Therefore, **Cloudflare DNS Proxying must remain ENABLED (Orange Cloud)** and Cloudflare SSL/TLS mode must be set to **Full (strict)**.

### Minimal, High-Precision DNS Records (Cloudflare Managed DNS)
We serve both the public UI and the API from the single canonical domain `strazh.dev`. Subdomains like `api.strazh.dev` are unneeded and removed.
| Type | Name | Content / Target | Proxy Status | TTL | Description |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **A** | `strazh.dev` | `<Host Public IPv4>` | **Proxied (Orange Cloud)** | Auto | Primary canonical application |
| **CNAME** | `www` | `strazh.dev` | **Proxied (Orange Cloud)** | Auto | Canonical redirect to `strazh.dev` |

### Installing the Cloudflare Origin CA Certificate on Host
1. In Cloudflare Dashboard: **SSL/TLS** $\rightarrow$ **Origin Server** $\rightarrow$ **Create Certificate**:
   - Hostnames: `strazh.dev`, `*.strazh.dev`
   - Validity: 15 years
   - Key format: RSA (2048) or ECDSA
2. On the server, paste the certificate into `rtap/deploy/certs/strazh.dev.crt`:
   ```bash
   nano /opt/red_team/rtap/deploy/certs/strazh.dev.crt
   ```
3. Paste the private key into `rtap/deploy/private/strazh.dev.key`:
   ```bash
   (umask 077 && nano /opt/red_team/rtap/deploy/private/strazh.dev.key)
   chmod 600 /opt/red_team/rtap/deploy/private/strazh.dev.key
   ```
*(Note: `deploy/certs/*.crt` and `deploy/private/*.key` are strictly ignored by `.gitignore` and can never be committed.)*

---

## 5. Cloud Hosting Architecture: AWS vs. Azure (Credit Consumption)

Using existing cloud credits eliminates out-of-pocket costs. Because RTAP requires Docker Compose, an isolated local ext4 persistent volume for SQLite (avoiding network-share file lock bugs), and an Nginx reverse proxy, a **single small Linux compute instance** is the most reliable, deterministic topology.

### Pricing & Specification Comparison (Verified September 2026 Rates)

| Requirement | AWS EC2 Specification | Azure VM Specification |
| :--- | :--- | :--- |
| **Instance Type** | **`t3a.medium`** (AMD) or **`t3.medium`** (Intel) | **`Standard_B2s`** (Intel/AMD) |
| **vCPU / RAM** | 2 vCPU / 4.0 GiB RAM | 2 vCPU / 4.0 GiB RAM |
| **Operating System** | Ubuntu 24.04 LTS x86_64 | Ubuntu 24.04 LTS x86_64 |
| **Hourly Compute Cost** | **$0.0376/hr** (`t3a.medium`) / **$0.0416/hr** (`t3.medium`) | **$0.0416/hr** |
| **Monthly Compute** | ~$27.45 / month (billed hourly) | ~$30.37 / month (billed hourly) |
| **Storage (SSD)** | 30 GiB EBS gp3 (3,000 IOPS baseline): **$2.40/mo** | 32 GiB Standard/Premium SSD: **$2.40 – $4.80/mo** |
| **Static Public IPv4** | In-use IPv4 ($0.005/hr): **$3.60/mo** | Standard Public IP ($0.005/hr): **$3.60/mo** |
| **Total Estimated Cost** | **~$33.45 – $36.37 / month** (~**$1.15 – $1.20 / day**) | **~$36.37 – $38.77 / month** (~**$1.20 – $1.29 / day**) |
| **Credit Draw** | Deducted automatically from AWS credits | Deducted automatically from Azure credits |

### Recommended Choice: AWS EC2 (`t3a.medium` in `us-east-1` or closest region)
- **Rationale:** 
  1. Identical 2 vCPU / 4GB RAM footprint ensures Promptfoo child processes and TypeScript runtime have zero memory throttling.
  2. Local EBS gp3 provides robust, deterministic POSIX file locks for `assessment.sqlite` without network storage lock contention (`SQLITE_BUSY`).
  3. Security Group configuration is simple:
     - Inbound: Port 22 (SSH from your IP), Port 80 (HTTP from Cloudflare/Any), Port 443 (HTTPS from Cloudflare/Any).
     - Ports 3000 (control plane) and 4000 (demo server) remain internal to Docker, completely unreachable from the internet.

---

## 6. Post-Deployment Verification & Smoke Check

Execute these commands against the live deployment to confirm operational health:

1. **Verify System Status & Primary Domain:**
   ```bash
   curl -sS https://strazh.dev/api/system/status
   # Expected: {"primaryDomain":"strazh.dev","status":"online","maxConcurrency":1,...}
   ```

2. **Verify Authentication Wall:**
   ```bash
   curl -sS -X POST https://strazh.dev/api/assessments/start \
     -H "Content-Type: application/json" \
     -d '{"targetId":"strazh-baseline-simulated"}'
   # Expected: HTTP 401 Unauthorized {"ok":false,"error":"Authentication required. Operator login needed."}
   ```

3. **Verify Operator Login:**
   ```bash
   # Provide operator token via environment or masked prompt (never hardcode in command history):
   read -s OPERATOR_TOKEN
   curl -sS -X POST https://strazh.dev/api/auth/login \
     -H "Content-Type: application/json" \
     -d "{\"token\":\"$OPERATOR_TOKEN\"}"
   # Expected: HTTP 200 {"ok":true,"token":"...","user":{"username":"operator","role":"OPERATOR"}}
   ```

4. **Verify Concurrency Cap & Kill Switch:**
   - Start an assessment via `POST /api/assessments/start`.
   - Concurrently send a second start request: verify it returns `HTTP 429`.
   - Call `POST /api/assessments/<runId>/cancel`: verify job status transitions to `CANCELLED`.

5. **Run Offline Simulated Target (Judge Demo):**
   - Execute target `strazh-baseline-simulated`.
   - Confirm completion and fetch report at `GET /api/assessments/<runId>/report`.
   - Check that verdicts match honest accounting and zero credits are spent.
   - Live Nebius targets remain disabled in the dropdown unless `NEBIUS_API_KEY` is present server-side.

---

## 7. Exact Remaining Steps for a Controlled Live Nebius Run

When authorized to execute a real live assessment against Nebius Token Factory:
1. Set the live credentials strictly in the backend server environment via masked input:
   ```bash
   # In Linux / Docker host environment (never printed or saved to history):
   read -s NEBIUS_API_KEY
   export NEBIUS_API_KEY
   ```
   ```powershell
   # In Windows PowerShell:
   $env:NEBIUS_API_KEY = [System.Net.NetworkCredential]::new('', (Read-Host 'Enter Nebius API Key' -AsSecureString)).Password
   ```
2. Verify model endpoint connectivity and available credit balance on the Nebius Token Factory console.
3. Open the Operator Console at `https://strazh.dev/` (or local `http://127.0.0.1:3000`).
4. Sign in with the operator token.
5. In the target dropdown, select:
   - **`Strazh Support Bot (Live Nebius Baseline)`** or
   - **`Strazh Support Bot (Live Nebius Mitigated)`** or
   - **`Nebius Token Factory Direct (Live Nemotron)`**
6. Click **Start Assessment**. The server runs the 2 bounded probes through the canonical RTAP execution path with maximum 4 requests and 15s timeouts.
7. Observe live execution status in the UI. When finished, honest verdicts (`RESISTANT`, `UNVERIFIED`, `VULNERABLE`, or `ERROR`) and coverage status are automatically rendered in the dashboard.
