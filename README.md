# MEDIS NLG (Ollama)

Folder ini berisi template implementasi chatbot yang melakukan **Data Interpretation** (angka hasil lab) dan **Anamnesis** (tanya jawab gejala) dalam 1 alur.

## 1) Buat model Ollama

Pastikan Ollama sudah berjalan:

```bash
ollama serve
```

Buat model kustom:

```bash
ollama create medis-nlg -f Modelfile
```

Tes cepat:

```bash
ollama run medis-nlg
```

## 2) Jalankan via Python (API Ollama)

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
- memanggil Ollama `http://localhost:11434/api/generate`

## 3) Kustomisasi pertanyaan (Q1–Q27)

File `anamnesis_q.json` sudah berisi Q1–Q27 dan skala N/R/S/O/F/A sesuai Table IV–V.

## 4) Frontend Node.js

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

Buka:

```text
http://localhost:3000
```

Jika ingin memakai Ollama untuk NLG dari UI:

1. Jalankan Ollama:

```bash
ollama serve
```

2. Pastikan model ada:

Tarik (download) model dasar dulu (contoh):

```bash
ollama pull llama3
```

Lalu buat model kustom:

```bash
ollama create medis-nlg -f Modelfile
```

3. Jalankan server Node dengan env var:

```bash
set OLLAMA_URL=http://localhost:11434
set OLLAMA_MODEL=medis-nlg
npm run dev
```

## Catatan medis

Output bersifat **edukasi dan skrining awal**, bukan diagnosis final. Jika ada nilai kritis, ikuti saran untuk pertolongan medis segera.
