from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple, Union

import requests

try:
    from dotenv import load_dotenv  # type: ignore
except Exception:  # pragma: no cover
    load_dotenv = None

ollama = None  # kept for backward compatibility; Ollama backend removed


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
    # Default ranges can be adjusted to match your journal/clinical reference.
    "leukosit": (3.2, 10.0),
    "wbc": (3.2, 10.0),
    "trombosit": (150.0, 450.0),
    "plt": (150.0, 450.0),
}


def _to_float(s: str) -> Optional[float]:
    s = s.strip().replace(",", ".")
    try:
        return float(s)
    except ValueError:
        return None


def parse_lab_text(text: str) -> Dict[str, Tuple[float, Optional[str]]]:
    """Parse common hematology values from free text.

    Supported keys (synonyms): hb, hemoglobin, leukosit/wbc, trombosit/plt.

    Returns dict: canonical_key -> (value, unit)
    """
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

    def _pick_best(canonical: str, nums: List[str]) -> Optional[float]:
        values = [v for v in (_to_float(n) for n in nums) if v is not None]
        if not values:
            return None

        def _in_range(v: float, lo: float, hi: float) -> bool:
            return lo <= v <= hi

        if canonical == "hb":
            # Hb g/dL commonly ~3..25
            candidates = [v for v in values if _in_range(v, 3.0, 25.0)]
            return (candidates or values)[0]

        if canonical == "leukosit":
            # WBC commonly ~0.1..200; avoid unit exponents like 10^9
            candidates = [v for v in values if _in_range(v, 0.1, 200.0) and v not in {9.0, 10.0, 12.0}]
            chosen_pool = candidates or values
            # Prefer decimals (typical for WBC like 13.14)
            for v in chosen_pool:
                if abs(v - round(v)) > 1e-9:
                    return v
            return chosen_pool[0]

        if canonical == "trombosit":
            # Platelets commonly ~10..2000; prefer larger value over unit exponents
            candidates = [v for v in values if _in_range(v, 10.0, 2000.0) and v not in {3.0, 10.0}]
            chosen_pool = candidates or values
            # In compact single-line text, multiple numbers can be present; platelets are typically the largest.
            return max(chosen_pool)

        return values[0]

    out: Dict[str, Tuple[float, Optional[str]]] = {}

    # 1) OCR tables: scan line by line, pick plausible number from the row.
    lines = [ln.strip() for ln in re.split(r"\r?\n", raw) if ln.strip()]
    for canonical in ("hb", "leukosit", "trombosit"):
        syns = synonyms[canonical]
        for ln in lines:
            ll = ln.lower()
            if not any(s in ll for s in syns):
                continue

            # Prefer the number that appears immediately after the matched token.
            # This fixes compact inputs like: "Hb 8.8, Leukosit 13.14, Trombosit 370".
            picked_value: Optional[float] = None
            for syn in syns:
                token = syn.strip().lower()
                if not token:
                    continue
                pattern = rf"\b{re.escape(token)}\b\s*[:=\-]?\s*(-?\d+(?:[\.,]\d+)?)"
                m = re.search(pattern, ll, flags=re.IGNORECASE)
                if m:
                    picked_value = _to_float(m.group(1))
                    if picked_value is not None:
                        break

            if picked_value is not None:
                out[canonical] = (picked_value, None)
                break

            nums = re.findall(r"-?\d+(?:[\.,]\d+)?", ll)
            best = _pick_best(canonical, nums)
            if best is not None:
                out[canonical] = (best, None)
                break

    # 2) Compact free-text forms like: "Hb 8.8, Leukosit 13.14, Trombosit 370"
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


def interpret_labs(
    labs: Dict[str, Tuple[float, Optional[str]]],
    sex: Optional[str] = None,
) -> InterpretationResult:
    """Interpret labs using simplified rules aligned to the MEDIS-NLG journal prompt."""

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
        if is_male:
            low_thr = 13.0
        elif is_female:
            low_thr = 12.0
        else:
            low_thr = 12.0
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

    # De-duplicate suspected list while preserving order
    dedup: List[str] = []
    for s in suspected:
        if s not in dedup:
            dedup.append(s)

    return InterpretationResult(
        findings=findings,
        abnormal=abnormal,
        critical=critical,
        suspected_conditions=dedup,
    )


def load_anamnesis_questions(path: str) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def pick_anamnesis_questions(
    suspected_conditions: List[str],
    questions_db: Dict[str, Any],
    answers: Optional[Dict[str, str]] = None,
    max_questions: int = 3,
) -> List[Dict[str, str]]:
    """Pick next anamnesis questions.

    Based on Table VII-VIII rule coverage:
    - Dengue rules reference Q1..Q16
    - Anaemia rules reference Q17..Q27
    """

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


def compute_cf_from_anamnesis(
    questions_db: Dict[str, Any],
    answers: Dict[str, str],
) -> Dict[str, Any]:
    """Compute CF for dengue and anaemia using Table V-VIII.

    answers maps Q1..Q27 to N/R/S/O/F/A.
    """

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
    premise_only: Dict[str, float] = {}
    premise_times_rule: Dict[str, float] = {}

    def eval_rule(rule_id: str, rule: Dict[str, Any]) -> float:
        prem = _eval_expr_minmax(rule.get("expr"), computed)
        premise_only[rule_id] = prem
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
        "premise_only": premise_only,
        "premise_times_rule": premise_times_rule,
        "final": {
            "dengue": combine_sequence(dengue_order),
            "anaemia": combine_sequence(anaemia_order),
        },
    }


def cf_from_signals(
    interpretation: InterpretationResult,
    symptoms_text: str,
) -> Dict[str, float]:
    """Very lightweight CF-style scoring.

    This is NOT the full CF expert system from the paper.
    It provides a deterministic confidence estimate based on:
    - lab abnormality strength
    - symptom keyword matches
    """

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

    parts = []
    for f in interpretation.abnormal:
        unit = f" {f.unit}" if f.unit else ""
        if f.status in {"low", "critical_low"}:
            parts.append(f"{f.name} menurun ({f.value}{unit})")
        elif f.status in {"high", "critical_high"}:
            parts.append(f"{f.name} meningkat ({f.value}{unit})")
        else:
            parts.append(f"{f.name} tidak normal ({f.value}{unit})")

    joined = ", ".join(parts)
    return f"Hasil pemeriksaan hematologi Anda menunjukkan komponen yang tidak normal: {joined}."


def call_ollama_generate(*_args: Any, **_kwargs: Any) -> str:
    raise RuntimeError("Backend Ollama sudah dihapus. Gunakan OpenAI-compatible API.")


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
        raise RuntimeError("OPENAI_MODEL belum di-set (contoh: gpt-4o-mini).")

    url = f"{base}/chat/completions"
    payload = {
        "model": model,
        "temperature": 0.2,
        "messages": [
            {"role": "system", "content": "Anda adalah MEDIS-NLG ANALYST."},
            {"role": "user", "content": prompt},
        ],
    }

    try:
        r = requests.post(
            url,
            json=payload,
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {key}",
            },
            timeout=timeout_s,
        )
        r.raise_for_status()
        data = r.json()
        return str((((data.get("choices") or [{}])[0]).get("message") or {}).get("content") or "")
    except requests.RequestException as e:
        raise RuntimeError(f"Gagal memanggil OpenAI-compatible endpoint. Detail: {e}") from e


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
    sex_hint = sex or "(belum disebutkan)"

    critical_flag = "YA" if interpretation.critical else "TIDAK"

    # Provide the model with structured facts so it stays consistent.
    facts = {
        "sex": sex_hint,
        "critical": critical_flag,
        "labs_parsed": [
            {
                "name": f.name,
                "value": f.value,
                "unit": f.unit,
                "status": f.status,
                "note": f.note,
            }
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
        "Ketentuan: jika critical == YA, sarankan pertolongan medis segera. "
        "Selalu sertakan penafian: ini bukan diagnosis final."
    )


def medis_analyst(
    lab_text: str,
    symptoms_text: str = "",
    sex: Optional[str] = None,
    model: str = "medis-nlg",
    questions_path: str = "anamnesis_q.json",
    use_ollama: bool = True,
    anamnesis_answers: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    labs = parse_lab_text(lab_text)
    interpretation = interpret_labs(labs, sex=sex)

    questions_db = load_anamnesis_questions(questions_path)
    anamnesis_answers = anamnesis_answers or {}
    anamnesis_questions = pick_anamnesis_questions(
        interpretation.suspected_conditions,
        questions_db,
        answers=anamnesis_answers,
        max_questions=3,
    )

    cf_detail = compute_cf_from_anamnesis(questions_db, anamnesis_answers) if anamnesis_answers else None

    cf_scores = cf_from_signals(interpretation, symptoms_text)
    if cf_detail and isinstance(cf_detail.get("final"), dict):
        cf_scores = {
            "dengue": float(cf_detail["final"].get("dengue", 0.0)),
            "anemia": float(cf_detail["final"].get("anaemia", 0.0)),
        }

    if not sex and labs.get("hb"):
        # Hb threshold depends on sex; ask proactively if missing.
        extra_question = {
            "id": "SEX",
            "text": "Sebelum saya menilai Hb lebih akurat, boleh sebutkan jenis kelamin Anda (pria/wanita)?",
        }
        anamnesis_questions = [extra_question] + anamnesis_questions
        anamnesis_questions = anamnesis_questions[:3]

    prompt = build_prompt(
        lab_text=lab_text,
        sex=sex,
        symptoms_text=symptoms_text,
        interpretation=interpretation,
        anamnesis_questions=anamnesis_questions,
        cf_scores=cf_scores,
        cf_detail=cf_detail,
        anamnesis_answers=anamnesis_answers,
    )

    response_text = ""
    if use_ollama:
        openai_model = (os.getenv("OPENAI_MODEL") or "").strip() or model
        openai_base = (os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1").strip()
        response_text = call_openai_compatible_chat(prompt, model=openai_model, base_url=openai_base)
    else:
        # Fallback: deterministic text without LLM.
        response_text = format_description(interpretation)
        if anamnesis_questions:
            qs = " ".join([q.get("text", "") for q in anamnesis_questions if q.get("text")])
            response_text += " " + qs
        if cf_scores:
            top = max(cf_scores.items(), key=lambda x: x[1])
            response_text += f"\n\nKesimpulan awal: kemungkinan {top[0]} ({round(top[1]*100)}%)."
        if interpretation.critical:
            response_text += "\n\nNilai kritis terdeteksi—sebaiknya cari pertolongan medis segera."
        response_text += "\n\nCatatan: ini bukan diagnosis final dan tidak menggantikan dokter."

    return {
        "labs": labs,
        "interpretation": interpretation,
        "anamnesis_questions": anamnesis_questions,
        "cf_scores": cf_scores,
        "cf_detail": cf_detail,
        "prompt": prompt,
        "response": response_text,
    }


if __name__ == "__main__":
    if load_dotenv is not None:
        # Load local secrets/config from .env if present.
        load_dotenv()
    # Quick manual test
    example_lab = "Hb 8.8, Leukosit 13.14, Trombosit 370"
    example_symptoms = "pusing dan lemas"
    try:
        result = medis_analyst(
            lab_text=example_lab,
            symptoms_text=example_symptoms,
            sex=None,
            model="medis-nlg",
            questions_path="anamnesis_q.json",
            use_ollama=True,
        )
        print(result["response"].strip())
    except Exception as e:
        # If Ollama isn't running, show an offline (non-LLM) version.
        result = medis_analyst(
            lab_text=example_lab,
            symptoms_text=example_symptoms,
            sex=None,
            model="medis-nlg",
            questions_path="anamnesis_q.json",
            use_ollama=False,
        )
        print(result["response"].strip())
        print("\n---\n")
        print(
            "Catatan: mode offline aktif karena LLM (OpenAI-compatible) tidak dapat diakses. "
            "Pastikan OPENAI_API_KEY/OPENAI_MODEL sudah di-set. "
            f"Detail error: {e}"
        )
