# MEDIS NLG (OpenAI-compatible API)

Folder ini berisi template implementasi chatbot yang melakukan **Data Interpretation** (angka hasil lab) dan **Anamnesis** (tanya jawab gejala) dalam 1 alur.

## 1) Jalankan via Python (OpenAI-compatible)

Install dependency:

```bash
pip install -r requirements.txt
```

Jalankan:

```bash
python medis_nlg.py
```

Script akan:
- parsing teks lab (Hb, Leukosit/WBC, Trombosit/PLT)
- menandai abnormal/kritis (aturan ringkas sesuai prompt)
- memilih 2–3 pertanyaan anamnesis dari `anamnesis_q.json` (Q1–Q27)
- menghitung CF berbasis rule Table V–VIII (RA1–RA7 & RB1–RB6) bila jawaban Q tersedia
- memanggil OpenAI-compatible endpoint `/chat/completions`

## 3) Kustomisasi pertanyaan (Q1–Q27)

File `anamnesis_q.json` sudah berisi Q1–Q27 dan skala N/R/S/O/F/A sesuai Table IV–V.

## 2) Frontend Node.js

## 0) One-button start (Windows)

Jika ingin mulai dari nol (setup + run) dengan 1 klik:

- Jalankan `START.bat` (paling gampang), atau
- Jalankan `START.ps1` (PowerShell)

Script ini akan:
- cek Node.js + npm + Python
- membuat `.venv` bila belum ada
- install `requirements.txt`
- install `npm install` bila `node_modules` belum ada
- menjalankan `node server.js` dan membuka `http://localhost:3000`

Alternatif via npm:

```bash
npm run start:win
```

Install dependency Node:

```bash
npm install
```

Jalankan server:

```bash
npm run dev
```

### Log di terminal

Saat server berjalan, request dari browser ke endpoint `/api/*` akan otomatis di-log ke terminal (method, URL, status, durasi).

Env var yang bisa dipakai:

- `LOG_LEVEL=info` (default): log ringkas per request.
- `LOG_LEVEL=debug`: tambahan log awal request + preview body JSON (dipotong).
- `LOG_STATIC=true`: ikut log request file statik (CSS/JS/favicon) — biasanya lebih rame.

Buka:

```text
http://localhost:3000

## Konfigurasi API key (wajib untuk LLM)

Project ini memakai provider OpenAI-compatible (mis. OpenAI, OpenRouter, Together, atau server OpenAI-compatible lokal seperti LM Studio).

Disarankan: buat file `.env` dengan menyalin `.env.example`, lalu isi `OPENAI_API_KEY`.

### A) UI (Node.js)

Windows PowerShell:

```powershell
$env:NLG_PROVIDER = "openai"
$env:OPENAI_API_KEY = "<API_KEY_ANDA>"
$env:OPENAI_BASE_URL = "https://api.openai.com/v1"  # sesuaikan bila pakai OpenRouter/LM Studio
$env:OPENAI_MODEL = "gpt-4o-mini"                  # sesuaikan sesuai provider
npm run dev
```

Catatan: toggle `useOllama` di UI tetap dipakai sebagai “aktifkan LLM”. Saat aktif, backend akan memanggil OpenAI-compatible API.

### B) CLI Python

```powershell
$env:NLG_PROVIDER = "openai"
$env:OPENAI_API_KEY = "<API_KEY_ANDA>"
$env:OPENAI_BASE_URL = "https://api.openai.com/v1"
$env:OPENAI_MODEL = "gpt-4o-mini"
python medis_nlg.py
```

## Catatan medis

Output bersifat **edukasi dan skrining awal**, bukan diagnosis final. Jika ada nilai kritis, ikuti saran untuk pertolongan medis segera.

## Deploy dari GitHub (Azure App Service)

Repo ini bisa auto-deploy ke 2 Azure App Service (Linux Web App):
- **Web (Node/Express)**: `medis-nlg-web-fpvtjrtpckvxo`
- **PyAPI (Python/FastAPI)**: `medis-nlg-pyapi-fpvtjrtpckvxo`

Workflow GitHub Actions ada di [.github/workflows/deploy-appservice.yml](.github/workflows/deploy-appservice.yml).

Jika kamu ingin **full dari 0 sampai live** (provision infra + deploy app) langsung dari GitHub, gunakan workflow OIDC + `azd`:
- `.github/workflows/deploy-azd-oidc.yml`

### 1) Tambahkan secrets di GitHub

Di GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **New repository secret**:

- `AZURE_WEBAPP_PUBLISH_PROFILE_WEB`
	- Isi: *Publish Profile* untuk web app `medis-nlg-web-fpvtjrtpckvxo`
- `AZURE_WEBAPP_PUBLISH_PROFILE_PYAPI`
	- Isi: *Publish Profile* untuk web app `medis-nlg-pyapi-fpvtjrtpckvxo`

Cara ambil Publish Profile:
- Azure Portal → masing-masing Web App → **Get publish profile** (download `.PublishSettings`) → copy seluruh isi XML ke secret.

Opsional (kalau nama web app berbeda):
- GitHub repo → **Settings** → **Secrets and variables** → **Actions** → **Variables**
	- `AZURE_WEBAPP_NAME_WEB` (default: `medis-nlg-web-fpvtjrtpckvxo`)
	- `AZURE_WEBAPP_NAME_PYAPI` (default: `medis-nlg-pyapi-fpvtjrtpckvxo`)

### 2) Trigger deploy

- Push ke branch `main` atau `master`, atau
- Jalankan manual dari GitHub → **Actions** → workflow **Deploy to Azure App Service** → **Run workflow**.

### OIDC + azd (recommended untuk dari 0 sampai live)

Workflow: **Deploy (azd + OIDC)**.

Secrets yang perlu dibuat (GitHub → Settings → Secrets and variables → Actions → Secrets):
- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`

Variables yang perlu dibuat (GitHub → Settings → Secrets and variables → Actions → Variables):
- `AZD_ENV_NAME` (contoh: `medis-nlg`)
- `AZURE_LOCATION` (default: `southeastasia`)
- `AZURE_RESOURCE_GROUP` (default: `rg-medis-nlg`)

Catatan: untuk OIDC, kamu perlu membuat **App Registration / Service Principal** + **Federated Credential** untuk repo GitHub ini. Cara paling mudah adalah menjalankan `azd pipeline config` sekali (bootstrap), setelah itu deploy selanjutnya otomatis dari GitHub.

## Deploy dari 0 sampai online (Render)

Repo ini mendukung deploy ke Render menggunakan **Render Blueprint** lewat file [render.yaml](render.yaml).

Yang akan dibuat:
- `medis-nlg-web` (Node/Express)
- `medis-nlg-pyapi` (Python/FastAPI)

### Langkah
1. Push project ke GitHub.
2. Render Dashboard → **New** → **Blueprint**.
3. Pilih repo GitHub ini → Render akan membaca `render.yaml` dan membuat 2 Web Service.
4. Setelah service terbentuk, buka masing-masing service → **Environment** dan isi env var yang dibutuhkan (contoh: `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`).
5. Tunggu build+deploy selesai (status “Live”).

### Verifikasi
- Web: `GET /api/health`
- PyAPI: `GET /health`
