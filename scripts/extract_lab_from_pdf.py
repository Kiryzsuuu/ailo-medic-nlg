from __future__ import annotations

import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from pypdf import PdfReader


@dataclass(frozen=True)
class LabHit:
    key: str
    label: str
    value: str
    unit: str | None = None


def normalize_text(s: str) -> str:
    s = s.replace("\u00a0", " ")
    s = re.sub(r"[\t\r]+", " ", s)
    s = re.sub(r" +", " ", s)
    return s


def extract_pdf_text(pdf_path: Path) -> str:
    reader = PdfReader(str(pdf_path))
    parts: list[str] = []
    for page in reader.pages:
        parts.append(page.extract_text() or "")
    return "\n".join(parts)


def to_float_str(raw: str) -> str:
    raw = raw.strip()
    # Convert comma decimals to dot.
    raw = raw.replace(",", ".")
    # Remove trailing punctuation.
    raw = raw.rstrip(".;")
    return raw


def find_first(patterns: Iterable[re.Pattern[str]], text: str) -> str | None:
    for pat in patterns:
        m = pat.search(text)
        if m:
            return to_float_str(m.group(1))
    return None


def parse_labs(text: str) -> list[LabHit]:
    # We keep parsing heuristics simple: look for label then a number.
    t = normalize_text(text)

    def pats(*names: str) -> list[re.Pattern[str]]:
        out: list[re.Pattern[str]] = []
        for name in names:
            out.append(re.compile(rf"(?:^|\b){name}\b\s*[:=]?\s*([0-9]+(?:[\.,][0-9]+)?)", re.IGNORECASE))
            # also allow 'name .... number'
            out.append(re.compile(rf"(?:^|\b){name}\b[^0-9]{{0,20}}([0-9]+(?:[\.,][0-9]+)?)", re.IGNORECASE))
        return out

    fields: list[tuple[str, str, list[re.Pattern[str]], str | None]] = [
        ("hb", "Hb / Hemoglobin", pats("hb", "hemoglobin", "haemoglobin"), "g/dL"),
        ("wbc", "Leukosit / WBC", pats("wbc", "leukosit", "leukocyte", "leucocyte"), "10^3/µL"),
        ("plt", "Trombosit / PLT", pats("plt", "trombosit", "trombocyte", "platelet"), "10^3/µL"),
        ("rbc", "RBC", pats("rbc"), "10^6/µL"),
        ("hct", "Hematokrit / Hct", pats("hct", "hematokrit", "haematocrit"), "%"),
        ("mcv", "MCV", pats("mcv"), "fL"),
        ("mch", "MCH", pats("mch"), "pg"),
        ("mchc", "MCHC", pats("mchc"), "g/dL"),
        ("rdw", "RDW", pats("rdw"), "%"),
        ("neut_pct", "Neutrofil (%)", pats("neutrofil", "neutrophil"), "%"),
        ("lym_pct", "Limfosit (%)", pats("limfosit", "lymphocyte"), "%"),
        ("mono_pct", "Monosit (%)", pats("monosit", "monocyte"), "%"),
        ("eos_pct", "Eosinofil (%)", pats("eosinofil", "eosinophil"), "%"),
        ("glu", "Glukosa", pats("glukosa", "glucose"), "mg/dL"),
        ("urea", "Ureum / Urea", pats("ureum", "urea"), "mg/dL"),
        ("creat", "Kreatinin / Creatinine", pats("kreatinin", "creatinine"), "mg/dL"),
        ("ast", "AST / SGOT", pats("ast", "sgot"), "U/L"),
        ("alt", "ALT / SGPT", pats("alt", "sgpt"), "U/L"),
        ("crp", "CRP", pats("crp"), "mg/L"),
    ]

    hits: list[LabHit] = []
    for key, label, patterns, unit in fields:
        val = find_first(patterns, t)
        if val is not None:
            hits.append(LabHit(key=key, label=label, value=val, unit=unit))
    return hits


def main(argv: list[str]) -> int:
    if len(argv) < 2:
        print("Usage: extract_lab_from_pdf.py <path-to-pdf>")
        return 2

    pdf_path = Path(argv[1]).expanduser().resolve()
    if not pdf_path.exists():
        print(f"File not found: {pdf_path}")
        return 2

    text = extract_pdf_text(pdf_path)
    print(f"pages={len(PdfReader(str(pdf_path)).pages)} chars={len(text)}")

    labs = parse_labs(text)
    if not labs:
        print("No lab values detected via text extraction.")
        # print a small preview for troubleshooting
        preview = normalize_text(text)[:2000]
        print("--- preview ---")
        print(preview)
        return 0

    print("\nDetected values:")
    for h in labs:
        unit = f" {h.unit}" if h.unit else ""
        print(f"- {h.label}: {h.value}{unit}")

    print("\nPaste-ready (Hasil Lab teks):")
    for h in labs:
        print(f"{h.label}: {h.value}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
