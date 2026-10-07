# ⚡ CODE//ARENA

A high-performance coding contest platform and live proctoring dashboard designed for lab tests, hackathons, and university coding exams.

Code execution (Python & C/C++) runs **client-side directly inside each contestant's browser via WebAssembly**, offloading 100% of the compilation and execution load from your host machine. Includes a live **PostgreSQL** database backend (with automatic SQLite fallback), **Cloudflare Tunnel with Custom Domain support**, and native **Firestore / Firebase Authentication** for verifying registered contestants.

---

## 🚀 Quick Start (Under 1 Minute)

### 1. Launch with Cloudflare Tunnel & Custom Domain
```bash
# Option A: Quick Public Tunnel (Default)
python3 start_tunnel.py

# Option B: With Your Custom Domain (e.g. arena.yourdomain.com)
python3 start_tunnel.py --domain arena.yourdomain.com

# Option C: With Cloudflare Zero Trust Tunnel Token (Permanent Domain Route)
python3 start_tunnel.py --token <YOUR_CLOUDFLARE_TUNNEL_TOKEN> --domain arena.yourdomain.com
```

- **Student Arena:** `https://fathers-indoor-male-builders.trycloudflare.com` (or your custom domain)
- **Admin Control Center:** `https://fathers-indoor-male-builders.trycloudflare.com/admin.html`
- **Admin Password:** `Mlrit#2026-jrll`

---

## 🌐 How to Point Your Custom Domain to CodeArena

You have two easy ways to run CodeArena on your own domain:

### Method 1: Instant DNS CNAME (Works with any Domain Registrar)
1. Run `python3 start_tunnel.py --domain arena.yourdomain.com`.
2. Look at the generated `trycloudflare.com` hostname (e.g. `fathers-indoor-male-builders.trycloudflare.com`).
3. In your DNS provider (Cloudflare, GoDaddy, Namecheap, etc.), add a **CNAME** record:
   - **Type:** `CNAME`
   - **Name / Host:** `arena` (or `@` for root domain)
   - **Target / Value:** `fathers-indoor-male-builders.trycloudflare.com`
   - **Proxy status:** Proxied (if using Cloudflare)
4. Your students can now immediately access: `https://arena.yourdomain.com`

### Method 2: Cloudflare Zero Trust Named Tunnel (Permanent / Recommended)
1. Go to **[Cloudflare Dashboard](https://one.dash.cloudflare.com/)** → **Networks** → **Tunnels**.
2. Click **Create a Tunnel** (name it e.g. `codearena`).
3. Under the **Public Hostname** tab:
   - **Subdomain:** `arena`
   - **Domain:** `yourdomain.com`
   - **Service:** `HTTP` → `localhost:5517`
4. Copy your Tunnel Token and start the tunnel:
   ```bash
   python3 start_tunnel.py --token <YOUR_TUNNEL_TOKEN> --domain arena.yourdomain.com
   ```

---

## 🔥 Firestore Student Authentication

Contestants log in using their registered credentials created during registration.

### How It Works:
1. Student enters their **User ID / Roll Number** (e.g. `25R21A05JR`) and their **Password**.
2. CodeArena verifies them against:
   - **Firestore `registrations` collection**: Confirms their registration exists and fee status is `paid`.
   - **Firebase Authentication**: Validates their registered password.
3. Automatically retrieves the student's **registered Full Name** (`name`) from Firestore.
4. Activates **Fullscreen Exam Mode** and enters the Coding Arena!
5. Unregistered students or incorrect passwords are automatically rejected with clear error messages.

### Configuration (`firebase-config.json` & `serviceAccountKey.json`):
Both files are already configured and connected to your live Firebase project `codearena-31947`:
- **Web API Key:** `AIzaSyAS8NMWRcKyU-6WK791X5QXy7lV4QgcNgU`
- **Project ID:** `codearena-31947`
- **Firestore Service Account:** Active in `serviceAccountKey.json` for real-time document validation.

---

## ⚡ Can 1 Computer Handle 60 Simultaneous Students?

### **YES, easily — and here is why:**

1. **Zero Server CPU Load for Code Execution:**
   - **Python 3**: Runs via [Pyodide](https://pyodide.org/) (CPython WebAssembly running inside the student's browser tab).
   - **C++17 / C17**: Compiled and executed in-browser using Clang WebAssembly workers.
   - When 60 students click "Run" or "Submit", all 60 compilations and test suite evaluations run **on their own laptops/desktops**. Your server CPU usage remains close to 0%.

2. **Ultra-Lightweight Polling Load:**
   - 60 active contestants polling the contest clock/state every 4 seconds produces only **~15 lightweight JSON HTTP requests per second**.
   - Python's multithreaded server and PostgreSQL connection pool (`ThreadedConnectionPool`) handle thousands of requests per second with single-digit millisecond latency.

3. **Cloudflare Edge CDN Acceleration:**
   - Cloudflare Tunnel automatically caches static CSS, Monaco editor files, and WASM bundles at edge servers closest to the students, eliminating network bottlenecks on your host computer.

---

## 🐘 Connect with PostgreSQL

Point CodeArena to your PostgreSQL database:
```bash
python3 serve.py --postgres "postgresql://username:password@localhost:5432/codearena"
```
*(If no PostgreSQL URL is provided, CodeArena automatically falls back to SQLite at `results/contest.db`).*

---

## 🛡️ Admin Control Center (`/admin.html`)

- **URL:** `http://localhost:5517/admin.html` (or `<your-domain>/admin.html`)
- **Password:** `Mlrit#2026-jrll`

### Proctor Capabilities:
- **Timer Management:** Start, pause, resume, or add extra time (`+5m`, `+10m`, `+15m`, `+30m`) synced live to all student screens.
- **Escape Detection & Live Unblock:** Instant alerts whenever a contestant leaves fullscreen or switches tabs. Unblock them with a single click.
- **Real-Time Submissions Stream:** View pass/fail verdicts and inspect submitted source code in real time.
- **Broadcast Announcements:** Send hall-wide alerts that appear instantly as banners and toast notifications.
- **Questions & Test Suites Management:** Add/edit questions, public samples, and hidden judge test suites directly from the admin panel.

---

## ☁️ Google Cloud Free Tier Deployment (VM + Cloud Run)

To run CodeArena 24/7 in Google Cloud for 60+ simultaneous students completely free:

### 1. Deploy the Java Judge to Cloud Run (1 Command)
Cloud Run provides 2 million free requests/month with 2 GB RAM per execution:
```bash
cd judge-service
gcloud run deploy codearena-java-judge \
  --source . \
  --platform managed \
  --region us-central1 \
  --allow-unauthenticated \
  --memory 2Gi
```
Copy the generated Service URL (e.g., `https://codearena-java-judge-xyz-uc.a.run.app`).

### 2. Run CodeArena on the Free Google Cloud VM (`e2-micro`)
1. Create an `e2-micro` VM (Ubuntu 24.04, 30 GB disk) in `us-central1`, `us-east1`, or `us-west1`.
2. SSH into your VM and clone the repository:
   ```bash
   git clone <your-repo-url> codearena
   cd codearena
   pip3 install -r requirements.txt
   ```
3. Set your Cloud Run URL and start CodeArena:
   ```bash
   export JAVA_JUDGE_URL="https://codearena-java-judge-xyz-uc.a.run.app"
   python3 serve.py
   ```
4. Expose with Cloudflare Tunnel:
   ```bash
   python3 start_tunnel.py --domain arena.yourdomain.com
   ```

# CodeArenaLive
