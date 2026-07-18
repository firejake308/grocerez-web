#!/usr/bin/env python3
"""Score each model's benchmark output against the adjudicated ground truth.

Grading policy (from ground_truth.json._policy, set by the user over several
rounds of review):
  - "findability" check: required_terms must all appear (forbidden_terms must
    none appear) somewhere in the pool of itemName + brand + tags, matched
    case/punctuation-insensitively as substrings.
  - brand check (when brand_allowed given): model brand must contain one of
    the allowed brand strings.
  - price check (when price/price_allowed given): numeric match within a
    small tolerance.
  - quantity check (when quantity/quantity_allowed given): numeric match
    within a small tolerance, with quantityUnits matched either exactly or
    via same-family unit conversion (volume<->volume, weight<->weight).
    quantityUnits: null means the unit is intentionally left ungraded.
  - Blank/missing model output for a check is scored as ABSTAIN (0.5),
    better than a wrong answer (FAIL = 0) but worse than a match (PASS = 1),
    per the user's explicit "blank beats wrong" policy.
Items marked "_skipped": true in ground truth are excluded entirely.
"""
import csv
import json
import re
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
RESULTS_DIR = BASE_DIR / "results"

MODELS = [
    "google/gemini-2.5-flash-lite",
    "xiaomi/mimo-v2.5",
    "google/gemma-4-26b-a4b-it",
    "openai/gpt-5-nano",
    "meta-llama/llama-4-scout",
]
MODEL_SHORT = {
    "google/gemini-2.5-flash-lite": "gemini-2.5-flash-lite",
    "xiaomi/mimo-v2.5": "mimo-v2.5",
    "google/gemma-4-26b-a4b-it": "gemma-4-26b",
    "openai/gpt-5-nano": "gpt-5-nano",
    "meta-llama/llama-4-scout": "llama-4-scout",
}

VOLUME = {"fluid ounce": 1, "cup": 8, "pint": 16, "quart": 32, "gallon": 128,
          "liter": 33.814, "milliliter": 0.033814}
WEIGHT = {"ounce": 1, "pound": 16, "gram": 0.0352739619, "kilogram": 35.2739619}

UNIT_ALIASES = {
    "fl oz": "fluid ounce", "floz": "fluid ounce", "fluid ounces": "fluid ounce",
    "oz": "ounce", "ounces": "ounce",
    "lb": "pound", "lbs": "pound", "pounds": "pound",
    "gal": "gallon", "gallons": "gallon",
    "qt": "quart", "quarts": "quart",
    "pt": "pint", "pints": "pint",
    "l": "liter", "liters": "liter", "litre": "liter", "litres": "liter",
    "ml": "milliliter", "milliliters": "milliliter",
    "g": "gram", "grams": "gram",
    "kg": "kilogram", "kilograms": "kilogram",
    "ct": "count", "cts": "count", "counts": "count",
    "pkg": "package", "packages": "package",
    "pack": "package", "packs": "package",
    "cans": "can", "boxes": "box", "units": "unit",
    "eaches": "each", "cups": "cup",
}


def normalize_unit(u):
    if not u:
        return ""
    u = str(u).strip().lower().replace(".", "")
    return UNIT_ALIASES.get(u, u)


def normalize_text(s):
    if not s:
        return ""
    s = str(s).lower()
    s = re.sub(r"[.'\-]", "", s)
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def parse_number(v):
    if v is None or v == "":
        return None
    if isinstance(v, (int, float)):
        return float(v)
    s = str(v).strip().replace("$", "").replace(",", "")
    try:
        return float(s)
    except ValueError:
        return None


def quantity_matches(gt_qty, gt_unit, model_qty, model_unit, tol_rel=0.03, tol_abs=0.05):
    if gt_unit is None:
        return abs(gt_qty - model_qty) <= max(tol_abs, abs(gt_qty) * tol_rel)
    gtu, mu = normalize_unit(gt_unit), normalize_unit(model_unit)
    if gtu == mu:
        return abs(gt_qty - model_qty) <= max(tol_abs, abs(gt_qty) * tol_rel)
    if gtu in VOLUME and mu in VOLUME:
        gb, mb = gt_qty * VOLUME[gtu], model_qty * VOLUME[mu]
        return abs(gb - mb) <= max(0.5, gb * tol_rel)
    if gtu in WEIGHT and mu in WEIGHT:
        gb, mb = gt_qty * WEIGHT[gtu], model_qty * WEIGHT[mu]
        return abs(gb - mb) <= max(0.5, gb * tol_rel)
    # "count"/"package" ground truth means "total number of individual
    # real-world units" - accept any descriptive noun unit (e.g. 'tissue',
    # 'box') as long as it's not itself a volume/weight unit, since that's
    # just a more specific label for the same count (per the tissue-counting
    # prompt: models are told to report the singular item name, not the
    # literal word "count").
    if gtu in ("count", "package") and mu not in VOLUME and mu not in WEIGHT:
        return abs(gt_qty - model_qty) <= max(tol_abs, abs(gt_qty) * tol_rel)
    return False


PASS, FAIL, ABSTAIN, NA = "PASS", "FAIL", "ABSTAIN", "N/A"
POINTS = {PASS: 1.0, ABSTAIN: 0.5, FAIL: 0.0}


def grade_findability(gt, r):
    required = gt.get("required_terms", [])
    forbidden = gt.get("forbidden_terms", [])
    if not required and not forbidden:
        return NA, ""
    pool = normalize_text(f"{r.get('itemName','')} {r.get('brand','')} {r.get('tags','')}")
    if not pool.strip():
        return ABSTAIN, "no itemName/brand/tags extracted"
    missing = [t for t in required if normalize_text(t) not in pool]
    hit_forbidden = [t for t in forbidden if normalize_text(t) in pool]
    if not missing and not hit_forbidden:
        return PASS, ""
    reasons = []
    if missing:
        reasons.append(f"missing: {missing}")
    if hit_forbidden:
        reasons.append(f"forbidden present: {hit_forbidden}")
    return FAIL, "; ".join(reasons)


def grade_brand(gt, r):
    allowed = gt.get("brand_allowed")
    if not allowed:
        return NA, ""
    model_brand = normalize_text(r.get("brand", ""))
    if not model_brand:
        return ABSTAIN, "no brand extracted"
    if any(normalize_text(a) in model_brand for a in allowed):
        return PASS, ""
    return FAIL, f"brand '{r.get('brand')}' not in {allowed}"


def grade_price(gt, r):
    candidates = gt.get("price_allowed")
    if candidates is None and "price" in gt:
        candidates = [gt["price"]]
    if not candidates:
        return NA, ""
    model_price = parse_number(r.get("price"))
    if model_price is None:
        return ABSTAIN, "no price extracted"
    for c in candidates:
        if abs(model_price - c) <= 0.02:
            return PASS, ""
    return FAIL, f"price {model_price} not in {candidates}"


def grade_quantity(gt, r):
    allowed = gt.get("quantity_allowed")
    if allowed is None and "quantity" in gt:
        allowed = [{"quantity": gt["quantity"], "quantityUnits": gt.get("quantityUnits")}]
    if not allowed:
        return NA, ""
    model_qty = parse_number(r.get("quantity"))
    if model_qty is None:
        return ABSTAIN, "no quantity extracted"
    for cand in allowed:
        if quantity_matches(cand["quantity"], cand.get("quantityUnits"), model_qty, r.get("quantityUnits")):
            return PASS, ""
    return FAIL, f"quantity {model_qty} {r.get('quantityUnits')} not in {allowed}"


def main():
    gt_all = json.load(open(BASE_DIR / "ground_truth.json"))
    results = json.load(open(RESULTS_DIR / "results_long.json"))
    cost_summary = json.load(open(RESULTS_DIR / "cost_summary.json")) if (RESULTS_DIR / "cost_summary.json").exists() else None

    by_pair_model = {}
    for r in results:
        by_pair_model[(r["pair_id"], r["model"])] = r

    items = {k: v for k, v in gt_all.items() if not k.startswith("_") and not v.get("_skipped")}
    checks = ["findability", "brand", "price", "quantity"]
    grader = {"findability": grade_findability, "brand": grade_brand, "price": grade_price, "quantity": grade_quantity}

    detail_rows = []
    per_model = {m: {c: {PASS: 0, FAIL: 0, ABSTAIN: 0} for c in checks} for m in MODELS}

    for pair_id, gt in sorted(items.items(), key=lambda x: int(x[0].split("_")[1])):
        for m in MODELS:
            r = by_pair_model.get((pair_id, m), {})
            row = {"pair_id": pair_id, "model": m}
            for c in checks:
                outcome, reason = grader[c](gt, r)
                row[f"{c}_outcome"] = outcome
                row[f"{c}_reason"] = reason
                if outcome != NA:
                    per_model[m][c][outcome] += 1
            detail_rows.append(row)

    # ---- per-model scores ----
    model_scores = {}
    for m in MODELS:
        total_pts, total_n = 0.0, 0
        per_check_score = {}
        for c in checks:
            counts = per_model[m][c]
            n = sum(counts.values())
            pts = counts[PASS] * 1.0 + counts[ABSTAIN] * 0.5
            per_check_score[c] = {"score": round(pts / n, 3) if n else None, "n": n, **counts}
            total_pts += pts
            total_n += n
        model_scores[m] = {
            "overall_score": round(total_pts / total_n, 4) if total_n else None,
            "n_checks": total_n,
            "per_check": per_check_score,
        }

    # ---- cost ----
    cost_by_model = {}
    if cost_summary:
        for m in MODELS:
            cost_by_model[m] = {
                "total_cost_usd": cost_summary["per_model_cost_usd"].get(m, 0),
                "avg_cost_usd": cost_summary["per_model_avg_cost_usd"].get(m, 0),
            }

    # ---- report ----
    print(f"Graded {len(items)} items x {len(MODELS)} models\n")
    ranked = sorted(MODELS, key=lambda m: (model_scores[m]["overall_score"] or 0), reverse=True)
    print(f"{'Model':<26}{'Score':>8}{'Findab.':>9}{'Brand':>8}{'Price':>8}{'Qty':>8}{'Cost($)':>10}{'$/pt':>10}")
    for m in ranked:
        ms = model_scores[m]
        pc = ms["per_check"]

        def fmt(c):
            s = pc[c]["score"]
            return f"{s:.2f}" if s is not None else " n/a"

        cost = cost_by_model.get(m, {}).get("total_cost_usd", 0)
        score = ms["overall_score"] or 0
        cost_per_point = cost / score if score else float("inf")
        print(f"{MODEL_SHORT[m]:<26}{score:>8.3f}{fmt('findability'):>9}{fmt('brand'):>8}{fmt('price'):>8}{fmt('quantity'):>8}{cost:>10.4f}{cost_per_point:>10.5f}")

    # write detailed CSV
    detail_path = RESULTS_DIR / "scoring_detail.csv"
    fieldnames = ["pair_id", "model"] + [f"{c}_{suffix}" for c in checks for suffix in ("outcome", "reason")]
    with open(detail_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fieldnames)
        w.writeheader()
        w.writerows(detail_rows)
    print(f"\nWrote {detail_path}")

    out = {
        "graded_items": len(items),
        "model_scores": model_scores,
        "cost_by_model": cost_by_model,
        "ranked_models": ranked,
    }
    json.dump(out, open(RESULTS_DIR / "scoring_summary.json", "w"), indent=2)
    print(f"Wrote {RESULTS_DIR / 'scoring_summary.json'}")


if __name__ == "__main__":
    main()
