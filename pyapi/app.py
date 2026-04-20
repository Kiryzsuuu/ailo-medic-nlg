from __future__ import annotations

import os
from typing import Any, Dict, Optional

from fastapi import FastAPI
from pydantic import BaseModel, Field

from medis_nlg import (
    build_prompt,
    call_openai_compatible_chat,
    cf_from_signals,
    compute_cf_from_anamnesis,
    format_description,
    interpret_labs,
    load_anamnesis_questions,
    parse_lab_text,
    pick_anamnesis_questions,
)


class AnalyzeRequest(BaseModel):
    labText: str = Field(default="")
    sex: Optional[str] = Field(default=None)
    symptomsText: str = Field(default="")
    answers: Dict[str, str] = Field(default_factory=dict)


app = FastAPI(title="MEDIS NLG API", version="0.1.0")


@app.get("/health")
def health() -> Dict[str, Any]:
    base = (os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1").rstrip("/")
    model = (os.getenv("OPENAI_MODEL") or "").strip()
    has_key = bool((os.getenv("OPENAI_API_KEY") or "").strip())
    return {"ok": bool(model) and has_key, "provider": "openai", "baseUrl": base, "model": model, "hasKey": has_key}


@app.post("/analyze")
def analyze(body: AnalyzeRequest) -> Dict[str, Any]:
    db = load_anamnesis_questions("anamnesis_q.json")

    labs = parse_lab_text(body.labText)
    interpretation = interpret_labs(labs, sex=body.sex)

    # Anamnesis: pick questions and compute CF if answers provided.
    next_questions = pick_anamnesis_questions(
        suspected_conditions=interpretation.suspected_conditions,
        questions_db=db,
        answers=body.answers,
        max_questions=3,
    )

    cf_detail = compute_cf_from_anamnesis(db, body.answers) if body.answers else None
    cf_scores = cf_detail["final"] if cf_detail else cf_from_signals(interpretation, body.symptomsText)

    prompt = build_prompt(
        lab_text=body.labText,
        sex=body.sex,
        symptoms_text=body.symptomsText,
        interpretation=interpretation,
        anamnesis_questions=next_questions,
        cf_scores=cf_scores,
        cf_detail=cf_detail,
        anamnesis_answers=body.answers,
    )

    description = format_description(interpretation)

    nlg = call_openai_compatible_chat(
        prompt,
        model=os.getenv("OPENAI_MODEL") or "",
        base_url=os.getenv("OPENAI_BASE_URL") or "https://api.openai.com/v1",
        api_key=os.getenv("OPENAI_API_KEY"),
        timeout_s=int(os.getenv("OPENAI_TIMEOUT_S") or "60"),
    )

    return {
        "description": description,
        "labs": labs,
        "interpretation": {
            "findings": [f.__dict__ for f in interpretation.findings],
            "abnormal": [f.__dict__ for f in interpretation.abnormal],
            "critical": [f.__dict__ for f in interpretation.critical],
            "suspected_conditions": interpretation.suspected_conditions,
        },
        "nextQuestions": next_questions,
        "cfScores": cf_scores,
        "cfDetail": cf_detail,
        "prompt": prompt,
        "response": nlg,
    }
