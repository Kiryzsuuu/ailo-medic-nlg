from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple, Union

import requests


@dataclass(frozen=True)
class LabFinding:
    name: str
    value: float
    unit: Optional[str]
    status: str  # normal|high|low|critical_low|critical_high|unknown
    note: str


@dataclass(frozen=True)
class InterpretationResult:
    findings: List[LabFinding]
    abnormal: List[LabFinding]
    critical: List[LabFinding]
    suspected_conditions: List[str]


NORMAL_RANGES = {
    "leukosit": (3.2, 10.0),
}


def _to_float(s: str) -> Optional[float]:
    s = s.strip().replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def parse_lab_text(text: str) -> Dict[str, Tuple[float, Optional[str]]]:
    raw = text or ""
    lowered = raw.lower()

    synonyms: Dict[str, List[str]] = {
        "hb": ["hb", "hemoglobin", "haemoglobin"],
        "leukosit": ["leukosit", "leukocyte", "leukocytes", "leucocyte", "leucocytes", "wbc"],
        "trombosit": [
            "trombosit",
            "trombosiyt",
            "trombosyt",
            "thrombocyte",
            "thrombocytes",
            "platelet",
            "platelets",
            "plt",
        ],
    }

    def pick_best(canonical: str, nums: List[str]) -> Optional[float]:
        values = [v for v in (_to_float(n) for n in nums) if v is not None]
        if not values:
            return None

        def in_range(v: float, lo: float, hi: float) -> bool:
            return lo <= v <= hi

        if canonical == "hb":
            candidates = [v for v in values if in_range(v, 3.0, 25.0)]
            return (candidates or values)[0]

        if canonical == "leukosit":
            candidates = [v for v in values if in_range(v, 0.1, 200.0) and v not in {9.0, 10.0, 12.0}]
            pool = candidates or values
            for v in pool:
                if abs(v - round(v)) > 1e-9:
                    return v
            return pool[0]

        if canonical == "trombosit":
            candidates = [v for v in values if in_range(v, 10.0, 2000.0) and v not in {3.0, 10.0}]
            pool = candidates or values
            return max(pool)

        return values[0]

    out: Dict[str, Tuple[float, Optional[str]]] = {}

    lines = [ln.strip() for ln in re.split(r"\r?\n", raw) if ln.strip()]
    for canonical in ("hb", "leukosit", "trombosit"):
        syns = synonyms[canonical]
        for ln in lines:
            ll = ln.lower()
            if not any(s in ll for s in syns):
                continue

            picked: Optional[float] = None
            for syn in syns:
                token = syn.strip().lower()
                pattern = rf"\b{re.escape(token)}\b\s*[:=\-]?\s*(-?\d+(?:[\.,]\d+)?)"
                m = re.search(pattern, ll, flags=re.IGNORECASE)
                if m:
                    picked = _to_float(m.group(1))
                    if picked is not None:
                        break
            if picked is not None:
                out[canonical] = (picked, None)
                break

            nums = re.findall(r"-?\d+(?:[\.,]\d+)?", ll)
            best = pick_best(canonical, nums)
            if best is not None:
                out[canonical] = (best, None)
                break

    if not out:
        compact = re.findall(
            r"\b(hb|hemoglobin|haemoglobin|leukosit|leukocyte|leucocyte|wbc|trombosit|platelet|plt)\b\s*[:=\-]?\s*(-?\d+(?:[\.,]\d+)?)\b",
            lowered,
        )
        for k, v in compact:
            value = _to_float(v)
            if value is None:
                continue
            kk = k.lower()
            canonical = (
                "hb"
                if kk in {"hb", "hemoglobin", "haemoglobin"}
                else "leukosit"
                if kk in {"leukosit", "leukocyte", "leucocyte", "wbc"}
                else "trombosit"
            )
            out[canonical] = (value, None)

    return out


def interpret_labs(labs: Dict[str, Tuple[float, Optional[str]]], sex: Optional[str] = None) -> InterpretationResult:
    findings: List[LabFinding] = []
    abnormal: List[LabFinding] = []
    critical: List[LabFinding] = []
    suspected: List[str] = []

    sex_norm = (sex or "").strip().lower()
    is_male = sex_norm in {"m", "male", "pria", "laki", "laki-laki"}
    is_female = sex_norm in {"f", "female", "wanita", "perempuan"}

    hb = labs.get("hb")
    if hb:
        value, unit = hb
        low_thr = 13.0 if is_male else 12.0
        if value <= 7.0:
            status = "critical_low"
            note = "Hb termasuk nilai kritis (<= 7.0)."
        elif value < low_thr:
            status = "low"
            note = f"Hb lebih rendah dari batas normal ({low_thr})."
        else:
            status = "normal"
            note = "Hb dalam batas yang diharapkan."

        f = LabFinding("Hemoglobin (Hb)", value, unit, status, note)
        findings.append(f)
        if status in {"low", "critical_low"}:
            abnormal.append(f)
            suspected.append("anemia")
        if status.startswith("critical"):
            critical.append(f)

    plt = labs.get("trombosit")
    if plt:
        value, unit = plt
        if value <= 20.0:
            status = "critical_low"
            note = "Trombosit termasuk nilai kritis (<= 20)."
        elif value < 150.0:
            status = "low"
            note = "Trombosit lebih rendah dari 150 (abnormal menurun)."
        else:
            status = "normal"
            note = "Trombosit dalam batas yang diharapkan."

        f = LabFinding("Trombosit", value, unit, status, note)
        findings.append(f)
        if status in {"low", "critical_low"}:
            abnormal.append(f)
            suspected.append("dengue")
        if status.startswith("critical"):
            critical.append(f)

    wbc = labs.get("leukosit")
    if wbc:
        value, unit = wbc
        lo, hi = NORMAL_RANGES["leukosit"]
        if value > hi:
            status = "high"
            note = f"Leukosit meningkat di atas {hi}."
        elif value < lo:
            status = "low"
            note = f"Leukosit menurun di bawah {lo}."
        else:
            status = "normal"
            note = "Leukosit dalam batas yang diharapkan."

        f = LabFinding("Leukosit (WBC)", value, unit, status, note)
        findings.append(f)
        if status in {"high", "low"}:
            abnormal.append(f)
            suspected.append("leukocytosis" if status == "high" else "leukopenia")

    dedup: List[str] = []
    for s in suspected:
        if s not in dedup:
            dedup.append(s)

    return InterpretationResult(findings=findings, abnormal=abnormal, critical=critical, suspected_conditions=dedup)


def load_anamnesis_questions(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def pick_anamnesis_questions(
    suspected_conditions: List[str],
    questions_db: Dict[str, Any],
    answers: Optional[Dict[str, str]] = None,
    max_questions: int = 3,
) -> List[Dict[str, str]]:
    answers = answers or {}
    all_questions: List[Dict[str, str]] = list(questions_db.get("questions", []))
    q_by_id = {q.get("id"): q for q in all_questions if q.get("id")}

    want_ids: List[str] = []
    if any(c in {"dengue", "dbd"} for c in suspected_conditions):
        want_ids.extend([f"Q{i}" for i in range(1, 17)])
    if any(c in {"anemia", "anaemia"} for c in suspected_conditions):
        want_ids.extend([f"Q{i}" for i in range(17, 28)])

    if not want_ids:
        want_ids = ["Q1", "Q2", "Q7", "Q8", "Q17", "Q21"]

    picked: List[Dict[str, str]] = []
    for qid in want_ids:
        if len(picked) >= max_questions:
            break
        if qid in answers:
            continue
        q = q_by_id.get(qid)
        if q:
            picked.append(q)

    return picked


AnswerExpr = Union[str, Dict[str, Any]]


def _cf_combine_positive(a: float, b: float) -> float:
    a = max(0.0, min(1.0, a))
    b = max(0.0, min(1.0, b))
    return a + b * (1.0 - a)


def _eval_expr_minmax(expr: AnswerExpr, values: Dict[str, float]) -> float:
    if isinstance(expr, str):
        return float(values.get(expr, 0.0))
    if not isinstance(expr, dict):
        return 0.0

    if "and" in expr:
        items = expr["and"]
        if not items:
            return 0.0
        return min(_eval_expr_minmax(it, values) for it in items)
    if "or" in expr:
        items = expr["or"]
        if not items:
            return 0.0
        return max(_eval_expr_minmax(it, values) for it in items)

    return 0.0


def compute_cf_from_anamnesis(questions_db: Dict[str, Any], answers: Dict[str, str]) -> Dict[str, Any]:
    scale: Dict[str, float] = questions_db.get("scale", {})
    q_values: Dict[str, float] = {}
    for qid, ans in (answers or {}).items():
        if not isinstance(ans, str):
            continue
        key = ans.strip().upper()
        if key in scale:
            q_values[qid] = float(scale[key])

    def cfrule(mb: float, md: float) -> float:
        return float(mb) - float(md)

    computed: Dict[str, float] = dict(q_values)
    premise_times_rule: Dict[str, float] = {}

    def eval_rule(rule_id: str, rule: Dict[str, Any]) -> float:
        prem = _eval_expr_minmax(rule.get("expr"), computed)
        out = prem * cfrule(rule.get("mb", 0.0), rule.get("md", 0.0))
        premise_times_rule[rule_id] = out
        computed[rule_id] = out
        return out

    dengue_rules: Dict[str, Any] = questions_db.get("dengue_rules", {})
    anaemia_rules: Dict[str, Any] = questions_db.get("anaemia_rules", {})

    dengue_order = ["RA1", "RA2", "RA3", "RA4", "RA5", "RA6", "RA7"]
    for rid in dengue_order:
        if rid in dengue_rules:
            eval_rule(rid, dengue_rules[rid])

    anaemia_order = ["RB1", "RB2", "RB3", "RB4", "RB5", "RB6"]
    for rid in anaemia_order:
        if rid in anaemia_rules:
            eval_rule(rid, anaemia_rules[rid])

    def combine_sequence(rule_ids: List[str]) -> float:
        c = 0.0
        for rid in rule_ids:
            if rid not in premise_times_rule:
                continue
            c = _cf_combine_positive(c, premise_times_rule[rid])
        return c

    return {
        "q_values": q_values,
        "final": {"dengue": combine_sequence(dengue_order), "anaemia": combine_sequence(anaemia_order)},
    }


def cf_from_signals(interpretation: InterpretationResult, symptoms_text: str) -> Dict[str, float]:
    s = (symptoms_text or "").lower()

    def has_any(*keywords: str) -> bool:
        return any(k in s for k in keywords)

    scores: Dict[str, float] = {}

    if "anemia" in interpretation.suspected_conditions:
        base = 0.6
        if any(f.name.startswith("Hemoglobin") and f.status == "critical_low" for f in interpretation.findings):
            base = 0.85
        if has_any("pusing", "lemas", "mudah lelah", "pucat", "berkunang"):
            base = min(0.95, base + 0.1)
        scores["anemia"] = base

    if "dengue" in interpretation.suspected_conditions:
        base = 0.6
        if any(f.name == "Trombosit" and f.status == "critical_low" for f in interpretation.findings):
            base = 0.9
        if has_any("demam", "bintik", "ruam", "mimisan", "gusi", "perdarahan"):
            base = min(0.95, base + 0.1)
        scores["dengue"] = base

    if "leukocytosis" in interpretation.suspected_conditions:
        base = 0.55
        if has_any("batuk", "pilek", "nyeri tenggorokan", "infeksi", "demam"):
            base = min(0.85, base + 0.1)
        scores["leukocytosis"] = base

    return scores


def format_description(interpretation: InterpretationResult) -> str:
    if not interpretation.findings:
        return "Saya belum menemukan angka lab (misalnya Hb, Leukosit, Trombosit) dari teks yang Anda kirim."

    if not interpretation.abnormal:
        return "Hasil hematologi yang Anda kirim tampak dalam batas yang diharapkan."

    parts: List[str] = []
    for f in interpretation.abnormal:
        unit = f" {f.unit}" if f.unit else ""
        if f.status in {"low", "critical_low"}:
            parts.append(f"{f.name} menurun ({f.value}{unit})")
        elif f.status in {"high", "critical_high"}:
            parts.append(f"{f.name} meningkat ({f.value}{unit})")
        else:
            parts.append(f"{f.name} tidak normal ({f.value}{unit})")

    return "Hasil pemeriksaan hematologi Anda menunjukkan komponen yang tidak normal: " + ", ".join(parts) + "."


def call_openai_compatible_chat(
    prompt: str,
    *,
    model: str,
    base_url: str = "https://api.openai.com/v1",
    api_key: Optional[str] = None,
    timeout_s: int = 60,
) -> str:
    key = (api_key or os.getenv("OPENAI_API_KEY") or "").strip()
    if not key:
        raise RuntimeError("OPENAI_API_KEY belum di-set.")

    base = (base_url or "https://api.openai.com/v1").strip().rstrip("/")
    if not model:
        raise RuntimeError("OPENAI_MODEL belum di-set.")

    url = f"{base}/chat/completions"
    payload = {
        "model": model,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": "Anda adalah MEDIS-NLG ANALYST."},
            {"role": "user", "content": prompt},
        ],
    }

    r = requests.post(
        url,
        json=payload,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {key}"},
        timeout=timeout_s,
    )
    r.raise_for_status()
    data = r.json()
    return str((((data.get("choices") or [{}])[0]).get("message") or {}).get("content") or "")


def build_prompt(
    lab_text: str,
    sex: Optional[str],
    symptoms_text: str,
    interpretation: InterpretationResult,
    anamnesis_questions: List[Dict[str, str]],
    cf_scores: Dict[str, float],
    cf_detail: Optional[Dict[str, Any]] = None,
    anamnesis_answers: Optional[Dict[str, str]] = None,
) -> str:
    critical_flag = "YA" if interpretation.critical else "TIDAK"

    facts = {
        "sex": sex or "(belum disebutkan)",
        "critical": critical_flag,
        "labs_parsed": [
            {"name": f.name, "value": f.value, "unit": f.unit, "status": f.status, "note": f.note}
            for f in interpretation.findings
        ],
        "description": format_description(interpretation),
        "anamnesis_questions": anamnesis_questions,
        "anamnesis_answers": anamnesis_answers or {},
        "symptoms": symptoms_text,
        "cf_scores": cf_scores,
        "cf_detail": cf_detail,
    }

    return (
        "Gunakan data terstruktur berikut sebagai sumber utama (jangan mengarang angka baru).\n"
        "Tugas Anda: buat 1 paragraf Description yang natural, lalu ajukan 2-3 pertanyaan anamnesis (pilih dari list), "
        "lalu berikan kesimpulan dengan CF (persen) berdasarkan cf_scores.\n\n"
        f"TEKS LAB ASLI: {lab_text}\n\n"
        "DATA TERSTRUKTUR (JSON):\n"
        f"{json.dumps(facts, ensure_ascii=False, indent=2)}\n\n"
        "Ketentuan: jika critical == YA, sarankan pertolongan medis segera. Selalu sertakan penafian: ini bukan diagnosis final."
    )
