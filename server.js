import fs from 'node:fs/promises';
import path from 'node:path';
import 'dotenv/config';
import express from 'express';

const app = express();

const LOG_LEVEL = String(process.env.LOG_LEVEL || 'info').toLowerCase();
const LOG_STATIC = String(process.env.LOG_STATIC || '').trim().toLowerCase() === 'true';
const OLLAMA_TIMEOUT_MS = (() => {
  const raw = String(process.env.OLLAMA_TIMEOUT_MS || '').trim();
  const n = raw ? Number(raw) : 120000;
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 120000;
})();

function nowIso() {
  return new Date().toISOString();
}

function shouldLogRequest(req) {
  if (LOG_STATIC) return true;
  const p = req?.path || req?.url || '';
  // Default: log API calls and non-GET requests (user actions).
  if (String(p).startsWith('/api/')) return true;
  if (req.method && req.method.toUpperCase() !== 'GET') return true;
  // Log the first page hit.
  if (p === '/' || p === '/index.html') return true;
  return false;
}

function safeJsonPreview(value, maxLen = 400) {
  try {
    const s = JSON.stringify(value);
    if (typeof s !== 'string') return '';
    return s.length > maxLen ? `${s.slice(0, maxLen)}…` : s;
  } catch {
    return '';
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = OLLAMA_TIMEOUT_MS) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const merged = { ...options, signal: controller.signal };
    return await fetch(url, merged);
  } finally {
    clearTimeout(t);
  }
}

const RAW_PORT = process.env.PORT;
const HAS_EXPLICIT_PORT = RAW_PORT != null && String(RAW_PORT).trim() !== '';
const PARSED_PORT = HAS_EXPLICIT_PORT ? Number(RAW_PORT) : 3000;
const DEFAULT_PORTS = [3000, 3001, 3002, 3003, 3004, 3005];

const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, 'public');

app.use(express.json({ limit: '1mb' }));

// Request logger (prints to terminal)
app.use((req, res, next) => {
  const start = process.hrtime.bigint();
  const id = Math.random().toString(16).slice(2, 10);
  res.setHeader('x-request-id', id);
  req.requestId = id;

  if (LOG_LEVEL === 'debug' && shouldLogRequest(req)) {
    const bodyPreview = safeJsonPreview(req.body);
    const bodyMsg = bodyPreview ? ` body=${bodyPreview}` : '';
    console.log(`[${nowIso()}] [req:${id}] -> ${req.method} ${req.originalUrl}${bodyMsg}`);
  }

  res.on('finish', () => {
    if (!shouldLogRequest(req)) return;
    const durMs = Number(process.hrtime.bigint() - start) / 1e6;
    const status = res.statusCode;
    const lvl = status >= 500 ? 'ERROR' : status >= 400 ? 'WARN' : 'INFO';
    console.log(
      `[${nowIso()}] [req:${id}] ${lvl} ${req.method} ${req.originalUrl} -> ${status} (${durMs.toFixed(1)}ms)`
    );
  });

  next();
});

app.use(express.static(PUBLIC_DIR));

function toFloat(s) {
  if (typeof s !== 'string') return null;
  const norm = s.trim().replace(',', '.');
  const v = Number(norm);
  return Number.isFinite(v) ? v : null;
}

function parseLabText(text) {
  const raw = String(text || '');
  const lowered = raw.toLowerCase();

  const synonyms = {
    hb: ['hb', 'hemoglobin', 'haemoglobin'],
    leukosit: ['leukosit', 'leukocyte', 'leukocytes', 'leucocyte', 'leucocytes', 'wbc'],
    trombosit: ['trombosit', 'trombosiyt', 'trombosyt', 'thrombocyte', 'thrombocytes', 'platelet', 'platelets', 'plt'],
    rbc: ['rbc', 'erythrocyte', 'erythrocytes'],
    hct: ['hct', 'hematocrit', 'haematocrit'],
    mcv: ['mcv'],
    mch: ['mch'],
    mchc: ['mchc'],
    rdw: ['rdw'],
    mpv: ['mpv'],
    neutrophil: ['neutrophil', 'neutrofil', 'neu%'],
    lymphocyte: ['lymphocyte', 'limfosit', 'lym%'],
    monocyte: ['monocyte', 'monosit', 'mono%'],
    eosinophil: ['eosinophil', 'eosinofil', 'eos%'],
    hdl: ['hdl'],
    ldl: ['ldl'],
    glucose: ['glucose', 'gds', 'fbs', 'rbs', 'bg', 'blood glucose', 'gula darah'],

    // Kidney
    urea: ['urea', 'ureum', 'bun'],
    creatinine: ['creatinine', 'kreatinin', 'creat'],
    uric_acid: ['uric acid', 'asam urat', 'ua'],

    // Liver
    ast: ['ast', 'sgot'],
    alt: ['alt', 'sgpt'],
    bilirubin_total: ['bilirubin total', 'total bilirubin', 't-bil', 'tbili'],
    bilirubin_direct: ['bilirubin direct', 'direct bilirubin', 'd-bil', 'dbili', 'bilirubin direct (d)'],
    albumin: ['albumin', 'alb'],
    total_protein: ['total protein', 'protein total'],

    // Lipids
    cholesterol_total: ['cholesterol', 'total cholesterol', 'chol total', 'tc'],
    triglycerides: ['triglyceride', 'triglycerides', 'tg'],

    // Electrolytes
    sodium: ['sodium', 'natrium', 'na'],
    potassium: ['potassium', 'kalium', 'k'],
    chloride: ['chloride', 'klorida', 'cl'],

    // Inflammation
    crp: ['crp', 'c-reactive protein', 'c reactive protein']
  };

  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = {};

  const pickBest = (canonical, nums) => {
    const values = nums.map(n => toFloat(n)).filter(v => v != null);
    if (!values.length) return null;

    const inRange = (v, lo, hi) => v >= lo && v <= hi;

    if (canonical === 'hb') {
      // Hb g/dL typically ~3..25
      const candidates = values.filter(v => inRange(v, 3, 25));
      return (candidates.length ? candidates : values)[0];
    }
    if (canonical === 'leukosit') {
      // WBC typically ~0.1..200 (x10^9/L); avoid unit exponents like 10^9
      const candidates = values.filter(v => inRange(v, 0.1, 200) && v !== 10 && v !== 9 && v !== 12);
      return (candidates.length ? candidates : values).find(v => v % 1 !== 0) ?? (candidates.length ? candidates : values)[0];
    }
    if (canonical === 'trombosit') {
      // Platelets typically ~10..2000 (x10^3/uL)
      const candidates = values.filter(v => inRange(v, 10, 2000) && v !== 10 && v !== 3);
      // In single-line compact text (e.g. "Hb 8.8, Leukosit 13.14, Trombosit 370"),
      // multiple numbers can appear; platelets are typically the largest among them.
      const pool = (candidates.length ? candidates : values);
      return pool.reduce((mx, v) => (v > mx ? v : mx), pool[0]);
    }

    if (canonical === 'rbc') {
      // RBC typically ~1..10 (x10^12/L)
      const candidates = values.filter(v => inRange(v, 1, 10));
      return (candidates.length ? candidates : values)[0];
    }

    if (canonical === 'hct') {
      // Hct usually percent ~10..70
      const candidates = values.filter(v => inRange(v, 10, 70));
      return (candidates.length ? candidates : values)[0];
    }

    if (canonical === 'mcv') {
      const candidates = values.filter(v => inRange(v, 40, 140));
      return (candidates.length ? candidates : values)[0];
    }

    if (canonical === 'mch') {
      const candidates = values.filter(v => inRange(v, 10, 45));
      return (candidates.length ? candidates : values)[0];
    }

    if (canonical === 'mchc') {
      const candidates = values.filter(v => inRange(v, 20, 45));
      return (candidates.length ? candidates : values)[0];
    }

    if (canonical === 'hdl' || canonical === 'ldl') {
      const candidates = values.filter(v => inRange(v, 1, 500));
      return (candidates.length ? candidates : values)[0];
    }

    if (canonical === 'glucose') {
      const candidates = values.filter(v => inRange(v, 10, 700));
      return (candidates.length ? candidates : values)[0];
    }

    if (canonical === 'urea') {
      const candidates = values.filter(v => inRange(v, 1, 400));
      return (candidates.length ? candidates : values)[0];
    }

    if (canonical === 'creatinine') {
      const candidates = values.filter(v => inRange(v, 0.1, 30));
      return (candidates.length ? candidates : values)[0];
    }

    if (canonical === 'uric_acid') {
      const candidates = values.filter(v => inRange(v, 0.5, 30));
      return (candidates.length ? candidates : values)[0];
    }

    if (canonical === 'ast' || canonical === 'alt') {
      const candidates = values.filter(v => inRange(v, 1, 5000));
      return (candidates.length ? candidates : values)[0];
    }

    if (canonical.startsWith('bilirubin')) {
      const candidates = values.filter(v => inRange(v, 0.0, 50));
      return (candidates.length ? candidates : values)[0];
    }

    if (canonical === 'albumin') {
      const candidates = values.filter(v => inRange(v, 0.5, 10));
      return (candidates.length ? candidates : values)[0];
    }

    if (canonical === 'total_protein') {
      const candidates = values.filter(v => inRange(v, 1, 20));
      return (candidates.length ? candidates : values)[0];
    }

    if (canonical === 'cholesterol_total' || canonical === 'triglycerides') {
      const candidates = values.filter(v => inRange(v, 1, 2000));
      return (candidates.length ? candidates : values)[0];
    }

    if (canonical === 'sodium') {
      const candidates = values.filter(v => inRange(v, 80, 200));
      return (candidates.length ? candidates : values)[0];
    }

    if (canonical === 'potassium') {
      const candidates = values.filter(v => inRange(v, 1.0, 10.0));
      return (candidates.length ? candidates : values)[0];
    }

    if (canonical === 'chloride') {
      const candidates = values.filter(v => inRange(v, 50, 150));
      return (candidates.length ? candidates : values)[0];
    }

    if (canonical === 'crp') {
      const candidates = values.filter(v => inRange(v, 0, 500));
      return (candidates.length ? candidates : values)[0];
    }
    return values[0];
  };

  const matchesSynonym = (lineLowered, syn) => {
    const s = String(syn).toLowerCase().trim();
    if (!s) return false;
    // For short tokens like Na/K/Cl/UA use word boundaries to avoid false positives.
    if (s.length <= 3 && /^[a-z0-9+.-]+$/i.test(s)) {
      const re = new RegExp(`\\b${s.replace(/[-/\\^$*+?.()|[\\]{}]/g, '\\$&')}\\b`, 'i');
      return re.test(lineLowered);
    }
    return lineLowered.includes(s);
  };

  const parseInlineRef = (lineLowered) => {
    // Supports: "3.2 - 10.0" or "4.1-11"
    const m = lineLowered.match(/(-?\d+(?:[\.,]\d+)?)\s*[-–]\s*(-?\d+(?:[\.,]\d+)?)/);
    if (m) {
      const lo = toFloat(m[1]);
      const hi = toFloat(m[2]);
      if (lo != null && hi != null && lo < hi) return { lo, hi };
    }
    // Supports: "> 50" or "<100"
    const gt = lineLowered.match(/>\s*(-?\d+(?:[\.,]\d+)?)/);
    if (gt) {
      const v = toFloat(gt[1]);
      if (v != null) return { gt: v };
    }
    const lt = lineLowered.match(/<\s*(-?\d+(?:[\.,]\d+)?)/);
    if (lt) {
      const v = toFloat(lt[1]);
      if (v != null) return { lt: v };
    }
    return null;
  };

  const scanLineFor = (canonical) => {
    const syns = synonyms[canonical];
    for (const line of lines) {
      const ll = line.toLowerCase();
      if (!syns.some(s => matchesSynonym(ll, s))) continue;

      // Prefer the number that appears immediately after the matched token.
      // This fixes compact single-line inputs like: "Hb 8.8, Leukosit 13.14, Trombosit 370".
      for (const syn of syns) {
        const token = String(syn).toLowerCase().trim();
        if (!token) continue;
        const escaped = token.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
        const re = new RegExp(`\\b${escaped}\\b\\s*[:=\\-]?\\s*(-?\\d+(?:[\\.,]\\d+)?)`, 'i');
        const m = ll.match(re);
        if (m) {
          const v = toFloat(m[1]);
          if (v != null) {
            const ref = parseInlineRef(ll);
            return { value: v, unit: null, ref };
          }
        }
      }

      const nums = ll.match(/-?\d+(?:[\.,]\d+)?/g) || [];
      const value = pickBest(canonical, nums);
      if (value != null) {
        const ref = parseInlineRef(ll);
        return { value, unit: null, ref };
      }
    }
    return null;
  };

  // 1) Try per-line scan (best for OCR tables)
  for (const canonical of [
    'hb', 'leukosit', 'trombosit',
    'rbc', 'hct', 'mcv', 'mch', 'mchc',
    'rdw', 'mpv', 'neutrophil', 'lymphocyte', 'monocyte', 'eosinophil',
    'glucose', 'hdl', 'ldl', 'cholesterol_total', 'triglycerides',
    'urea', 'creatinine', 'uric_acid',
    'ast', 'alt', 'bilirubin_total', 'bilirubin_direct', 'albumin', 'total_protein',
    'sodium', 'potassium', 'chloride',
    'crp'
  ]) {
    const hit = scanLineFor(canonical);
    if (hit) out[canonical] = hit;
  }

  // 2) Fallback: compact free-text forms
  if (Object.keys(out).length === 0) {
    const compact = [...lowered.matchAll(/\b(hb|leukosit|wbc|leucocyte|plt|trombosit|platelet)\b\s*[:=\-]?\s*(-?\d+(?:[\.,]\d+)?)\b/g)];
    for (const m of compact) {
      const k = m[1];
      const value = toFloat(m[2]);
      if (value == null) continue;
      const canonical = ({
        hb: 'hb',
        leukosit: 'leukosit',
        wbc: 'leukosit',
        leucocyte: 'leukosit',
        trombosit: 'trombosit',
        plt: 'trombosit',
        platelet: 'trombosit'
      })[k];
      out[canonical] = { value, unit: null };
    }
  }

  return out;
}

function interpretLabs(labs, sex) {
  const sexNorm = String(sex || '').trim().toLowerCase();
  const isMale = new Set(['m', 'male', 'pria', 'laki', 'laki-laki']).has(sexNorm);
  const isFemale = new Set(['f', 'female', 'wanita', 'perempuan']).has(sexNorm);

  const findings = [];
  const abnormal = [];
  const critical = [];
  const suspected = [];

  const hb = labs.hb;
  if (hb) {
    const lowThr = isMale ? 13.0 : (isFemale ? 12.0 : 12.0);
    let status = 'normal';
    let note = 'Hb dalam batas yang diharapkan.';
    if (hb.value <= 7.0) {
      status = 'critical_low';
      note = 'Hb termasuk nilai kritis (<= 7.0).';
    } else if (hb.value < lowThr) {
      status = 'low';
      note = `Hb lebih rendah dari batas normal (${lowThr}).`;
    }
    const f = { name: 'Hemoglobin (Hb)', value: hb.value, unit: hb.unit, status, note };
    findings.push(f);
    if (status === 'low' || status === 'critical_low') {
      abnormal.push(f);
      suspected.push('anemia');
    }
    if (status.startsWith('critical')) critical.push(f);
  }

  const plt = labs.trombosit;
  if (plt) {
    let status = 'normal';
    let note = 'Trombosit dalam batas yang diharapkan.';
    if (plt.value <= 20.0) {
      status = 'critical_low';
      note = 'Trombosit termasuk nilai kritis (<= 20).';
    } else if (plt.value < 150.0) {
      status = 'low';
      note = 'Trombosit lebih rendah dari 150 (abnormal menurun).';
    }
    const f = { name: 'Trombosit', value: plt.value, unit: plt.unit, status, note };
    findings.push(f);
    if (status === 'low' || status === 'critical_low') {
      abnormal.push(f);
      suspected.push('dengue');
    }
    if (status.startsWith('critical')) critical.push(f);
  }

  const wbc = labs.leukosit;
  if (wbc) {
    const lo = 3.2, hi = 10.0;
    let status = 'normal';
    let note = 'Leukosit dalam batas yang diharapkan.';
    if (wbc.value > hi) { status = 'high'; note = `Leukosit meningkat di atas ${hi}.`; }
    else if (wbc.value < lo) { status = 'low'; note = `Leukosit menurun di bawah ${lo}.`; }
    const f = { name: 'Leukosit (WBC)', value: wbc.value, unit: wbc.unit, status, note };
    findings.push(f);
    if (status === 'high' || status === 'low') {
      abnormal.push(f);
    }
  }

  const applyRefOrDefault = (labObj, def) => {
    const ref = labObj?.ref;
    if (ref && typeof ref === 'object') {
      if (typeof ref.lo === 'number' && typeof ref.hi === 'number') return { lo: ref.lo, hi: ref.hi };
      if (typeof ref.gt === 'number') return { gt: ref.gt };
      if (typeof ref.lt === 'number') return { lt: ref.lt };
    }
    return def;
  };

  const pushSimple = (name, obj, refDefault, formatUnitHint) => {
    if (!obj) return;
    const ref = applyRefOrDefault(obj, refDefault);
    let status = 'unknown';
    let note = 'Tidak ada interpretasi otomatis untuk parameter ini.';
    if ('lo' in ref && 'hi' in ref) {
      if (obj.value < ref.lo) { status = 'low'; note = `${name} lebih rendah dari nilai rujukan (${ref.lo}–${ref.hi}).`; }
      else if (obj.value > ref.hi) { status = 'high'; note = `${name} lebih tinggi dari nilai rujukan (${ref.lo}–${ref.hi}).`; }
      else { status = 'normal'; note = `${name} dalam batas nilai rujukan.`; }
    } else if ('gt' in ref) {
      if (obj.value < ref.gt) { status = 'low'; note = `${name} di bawah nilai rujukan (>${ref.gt}).`; }
      else { status = 'normal'; note = `${name} memenuhi nilai rujukan (>${ref.gt}).`; }
    } else if ('lt' in ref) {
      if (obj.value > ref.lt) { status = 'high'; note = `${name} di atas nilai rujukan (<${ref.lt}).`; }
      else { status = 'normal'; note = `${name} memenuhi nilai rujukan (<${ref.lt}).`; }
    }

    const unit = obj.unit || (formatUnitHint || null);
    const f = { name, value: obj.value, unit, status, note };
    findings.push(f);
    if (status === 'low' || status === 'high' || status === 'critical_low' || status === 'critical_high') abnormal.push(f);
    return f;
  };

  const rbc = labs.rbc;
  if (rbc) {
    pushSimple('Erythrocyte (RBC)', rbc, { lo: 3.8, hi: 5.5 }, null);
  }

  const hct = labs.hct;
  if (hct) {
    pushSimple('Hematocrit (Hct)', hct, { lo: 35.0, hi: 45.0 }, '%');
  }

  const mcv = labs.mcv;
  if (mcv) {
    pushSimple('MCV', mcv, { lo: 80.0, hi: 100.0 }, 'fL');
  }

  const mch = labs.mch;
  if (mch) {
    pushSimple('MCH', mch, { lo: 28.0, hi: 34.0 }, 'pg');
  }

  const mchc = labs.mchc;
  if (mchc) {
    pushSimple('MCHC', mchc, { lo: 32.0, hi: 36.0 }, 'g/dL');
  }

  const rdw = labs.rdw;
  if (rdw) {
    // Broad adult default, lab-specific.
    pushSimple('RDW', rdw, { lo: 11.5, hi: 14.5 }, '%');
  }

  const mpv = labs.mpv;
  if (mpv) {
    pushSimple('MPV', mpv, { lo: 7.5, hi: 11.5 }, 'fL');
  }

  const neu = labs.neutrophil;
  if (neu) {
    pushSimple('Neutrofil', neu, { lo: 40.0, hi: 75.0 }, '%');
  }

  const lym = labs.lymphocyte;
  if (lym) {
    pushSimple('Limfosit', lym, { lo: 20.0, hi: 45.0 }, '%');
  }

  const mono = labs.monocyte;
  if (mono) {
    pushSimple('Monosit', mono, { lo: 2.0, hi: 10.0 }, '%');
  }

  const eos = labs.eosinophil;
  if (eos) {
    pushSimple('Eosinofil', eos, { lo: 0.0, hi: 6.0 }, '%');
  }

  const glucose = labs.glucose;
  if (glucose) {
    // Broad default; actual depends on fasting/random.
    pushSimple('Glukosa (BG)', glucose, { lo: 70.0, hi: 140.0 }, 'mg/dL');
  }

  const hdl = labs.hdl;
  if (hdl) {
    pushSimple('HDL', hdl, { gt: 40.0 }, 'mg/dL');
  }

  const ldl = labs.ldl;
  if (ldl) {
    pushSimple('LDL', ldl, { lt: 100.0 }, 'mg/dL');
  }

  const chol = labs.cholesterol_total;
  if (chol) {
    pushSimple('Kolesterol Total', chol, { lt: 200.0 }, 'mg/dL');
  }

  const tg = labs.triglycerides;
  if (tg) {
    pushSimple('Trigliserida', tg, { lt: 150.0 }, 'mg/dL');
  }

  const urea = labs.urea;
  if (urea) {
    pushSimple('Urea/BUN', urea, { lo: 7.0, hi: 20.0 }, 'mg/dL');
  }

  const crea = labs.creatinine;
  if (crea) {
    pushSimple('Kreatinin', crea, { lo: 0.6, hi: 1.3 }, 'mg/dL');
  }

  const ua = labs.uric_acid;
  if (ua) {
    pushSimple('Asam Urat', ua, { lo: 2.5, hi: 7.0 }, 'mg/dL');
  }

  const ast = labs.ast;
  if (ast) {
    pushSimple('AST (SGOT)', ast, { lt: 40.0 }, 'U/L');
  }

  const alt = labs.alt;
  if (alt) {
    pushSimple('ALT (SGPT)', alt, { lt: 41.0 }, 'U/L');
  }

  const tbil = labs.bilirubin_total;
  if (tbil) {
    pushSimple('Bilirubin Total', tbil, { lo: 0.1, hi: 1.2 }, 'mg/dL');
  }

  const dbil = labs.bilirubin_direct;
  if (dbil) {
    pushSimple('Bilirubin Direct', dbil, { lo: 0.0, hi: 0.3 }, 'mg/dL');
  }

  const alb = labs.albumin;
  if (alb) {
    pushSimple('Albumin', alb, { lo: 3.5, hi: 5.2 }, 'g/dL');
  }

  const tp = labs.total_protein;
  if (tp) {
    pushSimple('Protein Total', tp, { lo: 6.0, hi: 8.3 }, 'g/dL');
  }

  const na = labs.sodium;
  if (na) {
    pushSimple('Natrium (Na)', na, { lo: 135.0, hi: 145.0 }, 'mmol/L');
  }

  const k = labs.potassium;
  if (k) {
    pushSimple('Kalium (K)', k, { lo: 3.5, hi: 5.1 }, 'mmol/L');
  }

  const cl = labs.chloride;
  if (cl) {
    pushSimple('Klorida (Cl)', cl, { lo: 98.0, hi: 107.0 }, 'mmol/L');
  }

  const crp = labs.crp;
  if (crp) {
    pushSimple('CRP', crp, { lt: 5.0 }, 'mg/L');
  }

  // Simple condition hints
  if (findings.some(f => f.name === 'Hemoglobin (Hb)' && (f.status === 'low' || f.status === 'critical_low')) ||
      findings.some(f => f.name === 'Hematocrit (Hct)' && f.status === 'low') ||
      findings.some(f => f.name === 'Erythrocyte (RBC)' && f.status === 'low')) {
    suspected.push('anemia');
  }

  const suspectedDedup = [];
  for (const s of suspected) if (!suspectedDedup.includes(s)) suspectedDedup.push(s);

  return { findings, abnormal, critical, suspected_conditions: suspectedDedup };
}

function formatDescription(interpretation) {
  if (!interpretation.findings.length) {
    return 'Saya belum menemukan angka lab (misalnya Hb, Leukosit, Trombosit) dari teks yang Anda kirim.';
  }
  if (!interpretation.abnormal.length) {
    return 'Hasil hematologi yang Anda kirim tampak dalam batas yang diharapkan.';
  }
  const parts = interpretation.abnormal.map(f => {
    const unit = f.unit ? ` ${f.unit}` : '';
    if (f.status === 'low' || f.status === 'critical_low') return `${f.name} menurun (${f.value}${unit})`;
    if (f.status === 'high' || f.status === 'critical_high') return `${f.name} meningkat (${f.value}${unit})`;
    return `${f.name} tidak normal (${f.value}${unit})`;
  });
  const normalCount = interpretation.findings.filter(f => f.status === 'normal').length;
  const normalSuffix = normalCount ? ` Parameter lain yang terbaca tampak dalam batas rujukan.` : '';
  return `Hasil pemeriksaan laboratorium Anda menunjukkan komponen yang tidak normal: ${parts.join(', ')}.${normalSuffix}`;
}

function buildDiagnosis(interpretation) {
  const findings = Array.isArray(interpretation?.findings) ? interpretation.findings : [];
  const abnormal = Array.isArray(interpretation?.abnormal) ? interpretation.abnormal : [];
  const suspected = Array.isArray(interpretation?.suspected_conditions) ? interpretation.suspected_conditions : [];

  const has = (name) => findings.find(f => f.name === name);
  const hb = has('Hemoglobin (Hb)');
  const plt = has('Trombosit');
  const wbc = has('Leukosit (WBC)');
  const rbc = has('Erythrocyte (RBC)');
  const hct = has('Hematocrit (Hct)');

  const items = [];

  const add = (label, basis, level = 'dugaan') => {
    items.push({ label, level, basis });
  };

  if (abnormal.length === 0) {
    add('Tidak ada kelainan hematologi yang jelas', ['Semua parameter yang terbaca berada dalam batas rujukan'], 'informasi');
    return { items };
  }

  // Anemia pattern
  const anemiaSignals = [];
  if (hb && (hb.status === 'low' || hb.status === 'critical_low')) anemiaSignals.push(`Hb ${hb.status.includes('critical') ? 'kritis rendah' : 'rendah'} (${hb.value}${hb.unit ? ` ${hb.unit}` : ''})`);
  if (rbc && rbc.status === 'low') anemiaSignals.push(`RBC rendah (${rbc.value}${rbc.unit ? ` ${rbc.unit}` : ''})`);
  if (hct && hct.status === 'low') anemiaSignals.push(`Hct rendah (${hct.value}${hct.unit ? ` ${hct.unit}` : ''})`);
  if (anemiaSignals.length) {
    add('Anemia (dugaan)', anemiaSignals);
  }

  // Thrombocytopenia / dengue hint
  if (plt && (plt.status === 'low' || plt.status === 'critical_low')) {
    const basis = [`Trombosit ${plt.status.includes('critical') ? 'kritis rendah' : 'rendah'} (${plt.value}${plt.unit ? ` ${plt.unit}` : ''})`];
    if (suspected.includes('dengue')) basis.push('Pola ini dapat sesuai dengan kemungkinan dengue, perlu korelasi klinis');
    add(suspected.includes('dengue') ? 'Curiga dengue (dugaan)' : 'Trombositopenia (dugaan)', basis);
  }

  // Leukocyte hints
  if (wbc && (wbc.status === 'high' || wbc.status === 'low')) {
    add(
      wbc.status === 'high' ? 'Leukositosis (dugaan)' : 'Leukopenia (dugaan)',
      [`Leukosit ${wbc.status === 'high' ? 'meningkat' : 'menurun'} (${wbc.value}${wbc.unit ? ` ${wbc.unit}` : ''})`]
    );
  }

  // If suspected list has items that weren't captured above, include as generic hints
  for (const s of suspected) {
    if (s === 'anemia' && items.some(it => it.label.toLowerCase().includes('anemia'))) continue;
    if (s === 'dengue' && items.some(it => it.label.toLowerCase().includes('dengue'))) continue;
    add(`Kemungkinan ${s} (dugaan)`, ['Berdasarkan pola temuan hematologi yang terbaca']);
  }

  return { items };
}

function buildSymptomBasedDiagnosis(symptomsText) {
  const s = String(symptomsText || '').toLowerCase();
  if (!s.trim()) return [];

  const hasAny = (arr) => arr.some(k => s.includes(k));
  const items = [];
  const add = (label, basis) => items.push({ label, level: 'dugaan', basis });

  // ISPA / influenza-like illness
  if (hasAny(['batuk', 'pilek', 'hidung tersumbat', 'bersin', 'nyeri tenggorokan', 'sakit tenggorokan', 'radang tenggorokan'])) {
    const basis = [];
    if (hasAny(['demam', 'panas'])) basis.push('Demam/panas disebutkan');
    if (hasAny(['batuk'])) basis.push('Batuk disebutkan');
    if (hasAny(['pilek', 'hidung tersumbat', 'bersin'])) basis.push('Gejala saluran napas atas disebutkan');
    if (hasAny(['nyeri tenggorokan', 'sakit tenggorokan', 'radang tenggorokan'])) basis.push('Nyeri tenggorokan disebutkan');
    add('ISPA/Flu (dugaan)', basis.length ? basis : ['Gejala saluran napas atas disebutkan']);
  }

  // Gastritis / dyspepsia
  if (hasAny(['nyeri ulu hati', 'perih ulu hati', 'maag', 'mual', 'muntah', 'kembung', 'asam lambung', 'heartburn'])) {
    const basis = [];
    if (hasAny(['nyeri ulu hati', 'perih ulu hati', 'maag'])) basis.push('Keluhan ulu hati/maag disebutkan');
    if (hasAny(['mual', 'muntah'])) basis.push('Mual/muntah disebutkan');
    if (hasAny(['asam lambung', 'heartburn'])) basis.push('Keluhan asam lambung/heartburn disebutkan');
    add('Gastritis/Dispepsia (dugaan)', basis.length ? basis : ['Keluhan pencernaan bagian atas disebutkan']);
  }

  // Gastroenteritis
  if (hasAny(['diare', 'mencret', 'bab cair', 'sakit perut', 'nyeri perut'])) {
    const basis = [];
    if (hasAny(['diare', 'mencret', 'bab cair'])) basis.push('Diare/BAB cair disebutkan');
    if (hasAny(['sakit perut', 'nyeri perut'])) basis.push('Nyeri perut disebutkan');
    add('Gastroenteritis (dugaan)', basis.length ? basis : ['Keluhan saluran cerna bawah disebutkan']);
  }

  // Varicella / chickenpox
  if (hasAny(['bintik', 'ruam', 'bentol', 'lepuh', 'vesikel', 'gatal']) && hasAny(['demam', 'panas'])) {
    add('Varisela/cacar air (dugaan)', ['Demam disertai ruam/bintik/lepuh disebutkan']);
  }

  // Dedup by label
  const out = [];
  const seen = new Set();
  for (const it of items) {
    const key = String(it?.label || '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function cfCombinePositive(a, b) {
  const aa = Math.max(0, Math.min(1, a));
  const bb = Math.max(0, Math.min(1, b));
  return aa + bb * (1 - aa);
}

function evalExprMinMax(expr, values) {
  if (typeof expr === 'string') return Number(values[expr] ?? 0.0);
  if (!expr || typeof expr !== 'object') return 0.0;
  if (Array.isArray(expr)) return 0.0;
  if (expr.and) {
    const items = expr.and;
    if (!items.length) return 0.0;
    return Math.min(...items.map(it => evalExprMinMax(it, values)));
  }
  if (expr.or) {
    const items = expr.or;
    if (!items.length) return 0.0;
    return Math.max(...items.map(it => evalExprMinMax(it, values)));
  }
  return 0.0;
}

function computeCF(db, answers) {
  const scale = db.scale || {};
  const qValues = {};
  for (const [qid, ans] of Object.entries(answers || {})) {
    const key = String(ans).trim().toUpperCase();
    if (key in scale) qValues[qid] = Number(scale[key]);
  }

  const computed = { ...qValues };
  const premiseOnly = {};
  const premiseTimesRule = {};

  const cfrule = (mb, md) => Number(mb) - Number(md);

  const evalRule = (id, rule) => {
    const prem = evalExprMinMax(rule.expr, computed);
    premiseOnly[id] = prem;
    const out = prem * cfrule(rule.mb ?? 0, rule.md ?? 0);
    premiseTimesRule[id] = out;
    computed[id] = out;
    return out;
  };

  const dengueOrder = ['RA1','RA2','RA3','RA4','RA5','RA6','RA7'];
  for (const id of dengueOrder) if (db.dengue_rules?.[id]) evalRule(id, db.dengue_rules[id]);

  const anaemiaOrder = ['RB1','RB2','RB3','RB4','RB5','RB6'];
  for (const id of anaemiaOrder) if (db.anaemia_rules?.[id]) evalRule(id, db.anaemia_rules[id]);

  const combineSeq = (ids) => ids.reduce((acc, id) => premiseTimesRule[id] != null ? cfCombinePositive(acc, premiseTimesRule[id]) : acc, 0.0);

  return {
    q_values: qValues,
    premise_only: premiseOnly,
    premise_times_rule: premiseTimesRule,
    final: {
      dengue: combineSeq(dengueOrder),
      anaemia: combineSeq(anaemiaOrder)
    }
  };
}

function pickNextQuestions(db, suspectedConditions, answers, maxQuestions = 3) {
  const qById = new Map((db.questions || []).map(q => [q.id, q]));
  const wantIds = [];
  if (suspectedConditions.includes('dengue')) for (let i = 1; i <= 16; i++) wantIds.push(`Q${i}`);
  if (suspectedConditions.includes('anemia')) for (let i = 17; i <= 27; i++) wantIds.push(`Q${i}`);
  if (wantIds.length === 0) wantIds.push('Q1','Q2','Q7','Q8','Q17','Q21');

  const picked = [];
  for (const id of wantIds) {
    if (picked.length >= maxQuestions) break;
    if (answers && id in answers) continue;
    const q = qById.get(id);
    if (q) picked.push(q);
  }
  return picked;
}

async function callOllama(prompt) {
  throw new Error('Ollama backend sudah dihapus. Gunakan OpenAI-compatible API.');
}

function resolveNlgProvider() {
  return 'openai';
}

async function callOpenAICompatible(prompt) {
  const apiKey = String(process.env.OPENAI_API_KEY || '').trim();
  if (!apiKey) throw new Error('OPENAI_API_KEY belum di-set.');

  const base = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').trim().replace(/\/$/, '');
  const model = String(process.env.OPENAI_MODEL || '').trim();
  if (!model) throw new Error('OPENAI_MODEL belum di-set (contoh: gpt-4o-mini).');

  const url = `${base}/chat/completions`;
  const payload = {
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: 'Anda adalah MEDIS-NLG ANALYST.' },
      { role: 'user', content: prompt }
    ]
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenAI-compatible error: ${res.status} ${text}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  return String(content || '');
}

async function callNlgProvider(prompt) {
  return callOpenAICompatible(prompt);
}

function safeString(x) {
  return String(x ?? '').trim();
}

function buildDoctorDraftPrompt({ facts, labText, nlgResponse }) {
  const disclaimer = 'Catatan: ini bukan diagnosis final dan tidak menggantikan dokter.';
  const answeredCount = facts?.anamnesis_answers && typeof facts.anamnesis_answers === 'object'
    ? Object.keys(facts.anamnesis_answers).length
    : 0;

  const requiredExecLines = [
    'Keluhan/Gejala: ...',
    'Temuan utama hematologi (ringkas): ...',
    'Dugaan berbasis hematologi: ...',
    'Narasi sistem: ...',
    'Kesimpulan awal: ...'
  ].join('\n');

  return [
    'Anda adalah asisten dokter untuk menyusun laporan dokter yang rapi.',
    'Gunakan hanya data yang diberikan (jangan mengarang angka lab baru).',
    '',
    'Tugas: hasilkan DRAFT untuk 3 section berikut dalam format JSON valid.',
    'Kunci JSON WAJIB persis: exec, corr, conclusion.',
    'Nilai setiap kunci WAJIB STRING (bukan object/array) dengan newline (\n) untuk baris baru.',
    'Output harus hanya JSON murni, tanpa teks lain, tanpa Markdown, tanpa ```.',
    '',
    'Aturan format untuk exec (WAJIB memuat semua baris ini, urutan sama):',
    requiredExecLines,
    '',
    'Aturan format untuk corr (minimal 3 baris):',
    `- Baris 1 harus: Integrasi anamnesis: ${answeredCount} jawaban anamnesis terisi.`,
    '- Baris berikutnya: korelasi klinis + tanda bahaya (rapih, 1 baris per poin).',
    '',
    'Aturan format untuk conclusion:',
    'Baris 1: Kesimpulan sementara:',
    'Baris 2: - (isi ringkas, boleh (tidak ada dugaan khusus) bila tidak ada).',
    '',
    `Jangan menambahkan disclaimer. Disclaimer sistem adalah: ${disclaimer}`,
    '',
    `TEKS LAB ASLI: ${safeString(labText)}`,
    '',
    'DATA TERSTRUKTUR (JSON):',
    JSON.stringify(facts ?? {}, null, 2),
    '',
    'NARASI SISTEM (bila ada; boleh diringkas di exec baris Narasi sistem):',
    safeString(nlgResponse).replaceAll(disclaimer, '').trim()
  ].join('\n');
}

function tryParseJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : null;
  } catch {
    // Try to extract first {...} block.
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      const obj2 = JSON.parse(m[0]);
      return (obj2 && typeof obj2 === 'object') ? obj2 : null;
    } catch {
      return null;
    }
  }
}

function normalizeToLines(value) {
  if (value == null) return '';
  if (typeof value === 'string') {
    return String(value)
      .replaceAll('\\r\\n', '\n')
      .replaceAll('\\n', '\n')
      .replaceAll('\\t', '\t')
      .trim();
  }
  if (Array.isArray(value)) {
    return value.map(v => (typeof v === 'string' ? v : JSON.stringify(v))).join('\n').trim();
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    return keys.map(k => {
      const v = value[k];
      const vv = (typeof v === 'string') ? v.trim() : (v == null ? '' : String(v));
      return vv ? `${k}: ${vv}` : `${k}:`;
    }).join('\n').trim();
  }
  return String(value).trim();
}

function normalizeDoctorDraft(draft) {
  const execRaw = draft?.exec;
  const corrRaw = draft?.corr;
  const conclRaw = draft?.conclusion;

  let exec = '';
  if (execRaw && typeof execRaw === 'object' && !Array.isArray(execRaw)) {
    const get = (...keys) => {
      for (const k of keys) {
        for (const kk of Object.keys(execRaw)) {
          if (kk.toLowerCase().trim() === k.toLowerCase().trim()) {
            return normalizeToLines(execRaw[kk]);
          }
        }
      }
      return '';
    };
    const keluhan = get('Keluhan/Gejala', 'Keluhan', 'Gejala');
    const temuan = get('Temuan utama hematologi (ringkas)', 'Temuan utama', 'Temuan');
    const dugaan = get('Dugaan berbasis hematologi', 'Dugaan');
    const narasi = get('Narasi sistem', 'Narasi');
    const kesAwal = get('Kesimpulan awal');
    exec = [
      `Keluhan/Gejala: ${safeString(keluhan) || '(tidak disebutkan)'}.`,
      `Temuan utama hematologi (ringkas): ${safeString(temuan) || '(tidak ada)'}.`,
      `Dugaan berbasis hematologi: ${safeString(dugaan) || '(tidak ada)'}.`,
      narasi ? `Narasi sistem: ${safeString(narasi)}` : 'Narasi sistem: (tidak ada).',
      `Kesimpulan awal: ${safeString(kesAwal) || '(tidak ada)'}.`
    ].join('\n');
  } else {
    exec = normalizeToLines(execRaw);
  }

  const corr = normalizeToLines(corrRaw);
  const conclusion = normalizeToLines(conclRaw);

  return { exec: exec.trim(), corr: corr.trim(), conclusion: conclusion.trim() };
}

function enforceDoctorDraftFormat({ exec, corr, conclusion, answeredCount, dxLabels, fallbacks }) {
  const safeAnswered = Number.isFinite(answeredCount) ? answeredCount : 0;
  const dxText = (Array.isArray(dxLabels) && dxLabels.length) ? dxLabels.join('; ') : '(tidak ada dugaan khusus)';

  const execText = normalizeToLines(exec);
  const lines = execText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const pick = (label) => {
    const want = `${String(label).toLowerCase().trim()}:`;
    for (const l of lines) {
      const ll = String(l).toLowerCase().trim();
      if (!ll.startsWith(want)) continue;
      return String(l).slice(want.length).trim();
    }
    return '';
  };

  const fb = (fallbacks && typeof fallbacks === 'object') ? fallbacks : {};

  const keluhanV = pick('Keluhan/Gejala') || safeString(fb.symptoms);
  const temuanV = pick('Temuan utama hematologi (ringkas)') || safeString(fb.labSummary);
  const dugaanV = pick('Dugaan berbasis hematologi') || safeString(fb.dxShort) || dxText;
  const narasiV = pick('Narasi sistem') || safeString(fb.narasi);
  const kesAwalV = pick('Kesimpulan awal') || safeString(fb.kesimpulanAwal);

  const ensureDot = (s) => {
    const t = safeString(s);
    if (!t) return t;
    return /[.!?ÔÇª]$/.test(t) ? t : `${t}.`;
  };

  exec = [
    `Keluhan/Gejala: ${ensureDot(keluhanV || '(tidak disebutkan)')}`,
    `Temuan utama hematologi (ringkas): ${ensureDot(temuanV || '(tidak ada)')}`,
    `Dugaan berbasis hematologi: ${ensureDot(dugaanV || '(tidak ada)')}`,
    `Narasi sistem: ${ensureDot(narasiV || '(tidak ada)')}`,
    `Kesimpulan awal: ${ensureDot(kesAwalV || '(tidak ada)')}`
  ].join('\n');

  const corrLines = String(corr || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const defaultCorr = [
    `Integrasi anamnesis: ${safeAnswered} jawaban anamnesis terisi.`,
    'Korelasi klinis perlu disesuaikan dengan pemeriksaan fisik, riwayat penyakit, obat, dan tren hasil lab serial.',
    'Bila ada tanda bahaya (perdarahan, penurunan kesadaran, sesak, hipotensi), pertimbangkan rujukan/penanganan segera.'
  ];
  if (corrLines.length < 3 || !/^Integrasi\s+anamnesis\s*:/i.test(corrLines[0] || '')) {
    corr = defaultCorr.join('\n');
  }

  const conclLines = String(conclusion || '').split(/\r?\n/).map(l => l.trim());
  let bullet = conclLines.find(l => /^-\s+/.test(l)) || `- ${dxText}.`;
  if (!bullet.endsWith('.')) bullet = `${bullet}.`;
  conclusion = ['Kesimpulan sementara:', bullet].join('\n');

  return {
    exec: String(exec || '').trim(),
    corr: String(corr || '').trim(),
    conclusion: String(conclusion || '').trim()
  };
}

app.get('/api/health', async (_req, res) => {
  const provider = 'openai';
  const base = String(process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').trim().replace(/\/$/, '');
  const model = String(process.env.OPENAI_MODEL || '').trim();
  const hasKey = Boolean(String(process.env.OPENAI_API_KEY || '').trim());
  res.json({ ok: hasKey && Boolean(model), provider, baseUrl: base, model, hasKey });
});

app.post('/api/analyze', async (req, res) => {
  const { patientName, patientAge, patientDob, labText, sex, symptomsText, answers, useOllama } = req.body || {};
  const rid = req?.requestId || '-';

  const db = JSON.parse(await fs.readFile(path.join(ROOT, 'anamnesis_q.json'), 'utf-8'));
  const labs = parseLabText(labText);
  const interpretation = interpretLabs(labs, sex);
  const diagnosis = buildDiagnosis(interpretation);
  // Add symptom-based suspected conditions (so conclusion can show disease-like labels).
  try {
    const extra = buildSymptomBasedDiagnosis(symptomsText);
    if (Array.isArray(extra) && extra.length) {
      const existing = new Set((Array.isArray(diagnosis?.items) ? diagnosis.items : []).map(it => String(it?.label || '').trim().toLowerCase()).filter(Boolean));
      diagnosis.items = Array.isArray(diagnosis?.items) ? diagnosis.items.slice() : [];
      for (const it of extra) {
        const k = String(it?.label || '').trim().toLowerCase();
        if (!k || existing.has(k)) continue;
        existing.add(k);
        diagnosis.items.push(it);
      }
    }
  } catch {
    // ignore symptom-based augmentation errors
  }

  const safeAnswers = (answers && typeof answers === 'object') ? answers : {};
  const cfDetail = Object.keys(safeAnswers).length ? computeCF(db, safeAnswers) : null;

  const cfScores = cfDetail ? {
    dengue: Number(cfDetail.final.dengue || 0),
    anemia: Number(cfDetail.final.anaemia || 0)
  } : {};

  const nextQuestions = pickNextQuestions(db, interpretation.suspected_conditions, safeAnswers, 3);

  const description = formatDescription(interpretation);
  const critical = interpretation.critical.length ? 'YA' : 'TIDAK';

  const facts = {
    patient: {
      name: String(patientName || '').trim() || '(tidak disebutkan)',
      age_years: (() => {
        const n = Number(String(patientAge ?? '').trim());
        return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
      })(),
      birth_date: String(patientDob || '').trim() || null
    },
    sex: sex || '(belum disebutkan)',
    critical,
    labs_parsed: interpretation.findings,
    description,
    anamnesis_questions: nextQuestions,
    anamnesis_answers: safeAnswers,
    symptoms: symptomsText || '',
    cf_scores: cfScores,
    cf_detail: cfDetail
  };

  const disclaimer = 'Catatan: ini bukan diagnosis final dan tidak menggantikan dokter.';

  const prompt = [
    'Gunakan data terstruktur berikut sebagai sumber utama (jangan mengarang angka baru).',
    'Tugas Anda: buat 1 paragraf Description yang natural, lalu ajukan 2-3 pertanyaan anamnesis (WAJIB pilih persis dari list anamnesis_questions; jangan membuat pertanyaan baru), lalu berikan kesimpulan ringkas.',
    'Format jawaban (WAJIB):',
    'Deskripsi: ...',
    'Pertanyaan:',
    '- Qx: (tulis ulang persis teks pertanyaan dari list)',
    '- Qy: (tulis ulang persis teks pertanyaan dari list)',
    'Kesimpulan: ...',
    `Catatan: ${disclaimer.replace(/^Catatan:\s*/,'')}`,
    '',
    `TEKS LAB ASLI: ${labText || ''}`,
    '',
    'DATA TERSTRUKTUR (JSON):',
    JSON.stringify(facts, null, 2),
    '',
    'Ketentuan: jika critical == YA, sarankan pertolongan medis segera. Jangan menyebut diagnosis final. Jangan menambah angka lab baru.'
  ].join('\n');

  let nlg = '';
  const wantOllama = useOllama === true;
  if (wantOllama) {
    try {
      nlg = await callNlgProvider(prompt);


      const hasDisclaimer = /\bCatatan\s*:/i.test(nlg) || /bukan diagnosis final/i.test(nlg);
      if (!hasDisclaimer) {
        nlg = `${nlg}\n\n${disclaimer}`;
      }

      const nextQuestionTexts = (nextQuestions || []).map(q => String(q?.text || '')).filter(Boolean);
      const mentionsAnyProvidedQuestion = nextQuestionTexts.some(t => t && nlg.includes(t));
      if (nextQuestionTexts.length && !mentionsAnyProvidedQuestion) {
        nlg = `${nlg}\n\nPertanyaan (dari sistem):\n${nextQuestionTexts.map(t => `- ${t}`).join('\n')}`;
      }
    } catch (e) {
      const provider = resolveNlgProvider();
      const providerLabel = provider === 'openai' ? 'API provider' : 'NLG Helper';
      nlg = `${description}\n\nCatatan: ${providerLabel} tidak dapat diakses. Detail: ${String(e)}`;
    }
  } else {
    nlg = description;
    if (nextQuestions.length) {
      nlg += ' ' + nextQuestions.map(q => q.text).join(' ');
    }
    const entries = Object.entries(cfScores);
    if (entries.length) {
      entries.sort((a,b) => b[1]-a[1]);
      const [k,v] = entries[0];
      nlg += `\n\nKesimpulan awal: kemungkinan ${k} (${Math.round(v*100)}%).`;
    }
    if (critical === 'YA') {
      nlg += '\n\nNilai kritis terdeteksi—sebaiknya cari pertolongan medis segera.';
    }
    nlg += `\n\n${disclaimer}`;
  }

  res.json({
    labs,
    interpretation,
    diagnosis,
    nextQuestions,
    cfScores,
    cfDetail,
    prompt,
    response: nlg
  });
});

app.post('/api/doctor-draft', async (req, res) => {
  const { payload, lastData } = req.body || {};
  const rid = req?.requestId || '-';
  const p = (payload && typeof payload === 'object') ? payload : {};
  const d = (lastData && typeof lastData === 'object') ? lastData : {};

  const labText = safeString(p.labText);
  const db = JSON.parse(await fs.readFile(path.join(ROOT, 'anamnesis_q.json'), 'utf-8'));
  const labs = parseLabText(labText);
  const interpretation = interpretLabs(labs, p.sex);
  const diagnosis = buildDiagnosis(interpretation);

  const safeAnswers = (p.answers && typeof p.answers === 'object') ? p.answers : {};
  const nextQuestions = pickNextQuestions(db, interpretation.suspected_conditions, safeAnswers, 3);

  const facts = {
    patient: {
      name: safeString(p.patientName) || '(tidak disebutkan)',
      age_years: (() => {
        const n = Number(String(p.patientAge ?? '').trim());
        return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
      })(),
      birth_date: safeString(p.patientDob) || null
    },
    sex: p.sex || '(belum disebutkan)',
    critical: interpretation.critical.length ? 'YA' : 'TIDAK',
    labs_parsed: interpretation.findings,
    description: formatDescription(interpretation),
    diagnosis,
    anamnesis_questions: nextQuestions,
    anamnesis_answers: safeAnswers,
    symptoms: safeString(p.symptomsText)
  };

  const dxLabels = Array.isArray(diagnosis?.items) ? diagnosis.items.map(it => safeString(it?.label)).filter(Boolean) : [];
  const answeredCount = safeAnswers && typeof safeAnswers === 'object' ? Object.keys(safeAnswers).length : 0;
  const labSummary = (() => {
    const defs = [
      { key: 'hb', label: 'Hb / Hemoglobin' },
      { key: 'leukosit', label: 'Leukosit / WBC' },
      { key: 'trombosit', label: 'Trombosit / PLT' },
      { key: 'rbc', label: 'RBC' },
      { key: 'hct', label: 'Hematokrit / Hct' },
      { key: 'mcv', label: 'MCV' },
      { key: 'mch', label: 'MCH' },
      { key: 'mchc', label: 'MCHC' },
      { key: 'rdw', label: 'RDW' },
      { key: 'mpv', label: 'MPV' },
      { key: 'neutrophil', label: 'Neutrofil (%)' },
      { key: 'lymphocyte', label: 'Limfosit (%)' },
      { key: 'monocyte', label: 'Monosit (%)' },
      { key: 'eosinophil', label: 'Eosinofil (%)' },
      { key: 'glucose', label: 'Glukosa' },
      { key: 'urea', label: 'Ureum / Urea' },
      { key: 'creatinine', label: 'Kreatinin / Creatinine' },
      { key: 'ast', label: 'AST / SGOT' },
      { key: 'alt', label: 'ALT / SGPT' },
      { key: 'crp', label: 'CRP' }
    ];
    const pairs = [];
    for (const d of defs) {
      const v = labs && labs[d.key] ? labs[d.key].value : null;
      if (v == null) continue;
      pairs.push(`${d.label}: ${v}`);
      if (pairs.length >= 8) break;
    }
    return pairs.join('; ');
  })();

  const narasiSystem = (() => {
    const raw = normalizeToLines(d.response || '');
    const withoutDisclaimer = raw
      .replace(/Catatan\s*:\s*ini bukan diagnosis final dan tidak menggantikan dokter\.?/ig, '')
      .trim();
    // Prefer the Deskripsi paragraph if present.
    const m = withoutDisclaimer.match(/Deskripsi\s*:\s*([\s\S]+?)(?:\n\s*Pertanyaan\s*:|\n\s*Kesimpulan\s*:|\n\s*Kesimpulan\s+awal\s*:|$)/i);
    const picked = String(m?.[1] || withoutDisclaimer);
    const removedKesAwal = picked.replace(/\n\s*Kesimpulan\s+awal\s*:[^\n\r]*/ig, '').trim();
    return removedKesAwal.replaceAll('\n\n', '\n').trim();
  })();

  const kesimpulanAwal = (() => {
    const raw = normalizeToLines(d.response || '');
    const m = raw.match(/Kesimpulan\s+awal\s*:\s*([^\n\r]+)\s*/i);
    return safeString(m?.[1] || '');
  })();

  const prompt = buildDoctorDraftPrompt({ facts, labText, nlgResponse: d.response || '' });

  try {
    const raw = await callNlgProvider(prompt);
    const obj = tryParseJsonObject(raw) || {};
    const norm = normalizeDoctorDraft(obj);
    const enforced = enforceDoctorDraftFormat({
      exec: norm.exec,
      corr: norm.corr,
      conclusion: norm.conclusion,
      answeredCount,
      dxLabels,
      fallbacks: {
        symptoms: safeString(p.symptomsText),
        labSummary,
        dxShort: dxLabels.length ? dxLabels.join(', ') : '',
        narasi: narasiSystem,
        kesimpulanAwal
      }
    });
    const exec = safeString(enforced.exec);
    const corr = safeString(enforced.corr);
    const conclusion = safeString(enforced.conclusion);

    if (!exec || !corr || !conclusion) {
      return res.status(502).json({ ok: false, error: 'Output Ollama tidak sesuai format JSON yang diminta.', raw });
    }
    return res.json({ ok: true, draft: { exec, corr, conclusion }, raw });
  } catch (e) {
    return res.status(502).json({ ok: false, error: String(e) });
  }
});

// Global error handler (must be after routes)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  const rid = req?.requestId || '-';
  console.error(`[${nowIso()}] [req:${rid}] UNHANDLED_ERROR ${req?.method} ${req?.originalUrl}:`, err);
  if (res.headersSent) return;
  res.status(500).json({ ok: false, error: 'Internal Server Error' });
});

function startServer() {
  if (HAS_EXPLICIT_PORT) {
    if (!Number.isFinite(PARSED_PORT) || PARSED_PORT <= 0) {
      console.error(`Invalid PORT: '${RAW_PORT}'. Please set PORT to a valid number (e.g. 3001).`);
      process.exitCode = 1;
      return;
    }
    const server = app.listen(PARSED_PORT, () => {
      console.log(`MEDIS NLG UI running on http://localhost:${PARSED_PORT}`);
    });
    server.on('error', (err) => {
      console.error('Failed to start server:', err);
      process.exitCode = 1;
    });
    return;
  }

  const portsToTry = DEFAULT_PORTS;
  const tryListen = (idx) => {
    const port = portsToTry[idx];
    const server = app.listen(port, () => {
      console.log(`MEDIS NLG UI running on http://localhost:${port}`);
    });
    server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE' && idx + 1 < portsToTry.length) {
        console.warn(`Port ${port} is in use; trying ${portsToTry[idx + 1]}...`);
        tryListen(idx + 1);
        return;
      }
      console.error('Failed to start server:', err);
      process.exitCode = 1;
    });
  };

  tryListen(0);
}

startServer();
