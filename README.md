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
