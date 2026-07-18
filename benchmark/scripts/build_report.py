#!/usr/bin/env python3
"""Combine per-model results into a wide CSV and an HTML review artifact
that highlights fields where models disagree."""
import csv
import difflib
import json
import re
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
IMG_DIR = BASE_DIR / "data"
RESULTS_DIR = BASE_DIR / "results"

MODELS = [
    "google/gemini-2.5-flash-lite",
    "xiaomi/mimo-v2.5",
    "google/gemma-4-26b-a4b-it",
    "openai/gpt-5-nano",
    "meta-llama/llama-4-scout",
]
FIELDS = ["itemName", "brand", "tags", "price", "quantity", "quantityUnits"]

results = json.load(open(RESULTS_DIR / "results_long.json"))

# index by (pair_id, model)
by_pair = {}
for r in results:
    by_pair.setdefault(r["pair_id"], {})[r["model"]] = r

pair_ids = sorted(by_pair.keys(), key=lambda x: int(x.split("_")[1]))


def norm_text(s):
    if s is None:
        return ""
    s = str(s).strip().lower()
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


def norm_num(s):
    if s is None or s == "":
        return None
    try:
        s2 = re.sub(r"[^0-9.\-]", "", str(s))
        return float(s2) if s2 not in ("", "-", ".") else None
    except ValueError:
        return None


def norm_unit(s):
    t = norm_text(s)
    t = re.sub(r"s$", "", t)  # crude singularize
    return t


def tag_set(s):
    if not s:
        return set()
    return set(norm_text(t) for t in str(s).split(";") if norm_text(t))


def text_agreement(values):
    """values: list of raw strings (non-empty). Returns avg pairwise similarity 0..1."""
    norms = [norm_text(v) for v in values if v]
    if len(norms) <= 1:
        return 1.0
    ratios = []
    for i in range(len(norms)):
        for j in range(i + 1, len(norms)):
            ratios.append(difflib.SequenceMatcher(None, norms[i], norms[j]).ratio())
    return sum(ratios) / len(ratios) if ratios else 1.0


def tags_agreement(values):
    sets = [tag_set(v) for v in values if v]
    if len(sets) <= 1:
        return 1.0
    ratios = []
    for i in range(len(sets)):
        for j in range(i + 1, len(sets)):
            a, b = sets[i], sets[j]
            union = a | b
            ratios.append(len(a & b) / len(union) if union else 1.0)
    return sum(ratios) / len(ratios) if ratios else 1.0


def numeric_agreement(values):
    nums = [norm_num(v) for v in values]
    nums = [n for n in nums if n is not None]
    if len(nums) <= 1:
        return 1.0
    return 1.0 if max(nums) - min(nums) < 1e-6 else 0.0


def unit_agreement(values):
    norms = [norm_unit(v) for v in values if v]
    if len(norms) <= 1:
        return 1.0
    return 1.0 if len(set(norms)) == 1 else 0.0


THRESH_TEXT = 0.55
THRESH_TAGS = 0.30

field_stats = {f: {"disagree": 0, "total": 0} for f in FIELDS}

rows_for_csv = []
row_meta = []  # for html: (pair_id, item_file, price_file, field_values, field_scores)

for pid in pair_ids:
    n = int(pid.split("_")[1])
    item_file = f"download ({n}).jpeg"
    price_file = f"download ({n+1}).jpeg"
    model_results = by_pair[pid]

    row = {"pair_id": pid, "item_image": item_file, "price_image": price_file}
    for m in MODELS:
        row[f"cost_usd__{m}"] = model_results.get(m, {}).get("cost_usd", "")
    field_values = {}
    field_scores = {}
    for field in FIELDS:
        values = []
        for m in MODELS:
            r = model_results.get(m, {})
            v = r.get(field, "")
            values.append(v)
            row[f"{field}__{m}"] = v
        field_values[field] = values

        if field == "tags":
            score = tags_agreement(values)
            disagree = score < THRESH_TAGS
        elif field in ("price", "quantity"):
            score = numeric_agreement(values)
            disagree = score < 1.0
        elif field == "quantityUnits":
            score = unit_agreement(values)
            disagree = score < 1.0
        else:  # itemName, brand
            score = text_agreement(values)
            disagree = score < THRESH_TEXT

        field_scores[field] = (score, disagree)
        row[f"{field}__agreement_score"] = round(score, 2)
        row[f"{field}__disagreement"] = "YES" if disagree else ""
        field_stats[field]["total"] += 1
        if disagree:
            field_stats[field]["disagree"] += 1

    rows_for_csv.append(row)
    row_meta.append((pid, item_file, price_file, field_values, field_scores))

# ---- Write wide CSV ----
csv_path = RESULTS_DIR / "grocerez_ai_parsing_benchmark.csv"
fieldnames = ["pair_id", "item_image", "price_image"] + [f"cost_usd__{m}" for m in MODELS]
for field in FIELDS:
    for m in MODELS:
        fieldnames.append(f"{field}__{m}")
    fieldnames.append(f"{field}__agreement_score")
    fieldnames.append(f"{field}__disagreement")

with open(csv_path, "w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=fieldnames)
    writer.writeheader()
    writer.writerows(rows_for_csv)

print(f"Wrote {csv_path}")

# ---- Summary ----
print("\nDisagreement summary (rows flagged / total 36):")
for field in FIELDS:
    d = field_stats[field]
    print(f"  {field}: {d['disagree']}/{d['total']}")

cost_summary_path = RESULTS_DIR / "cost_summary.json"
cost_summary = json.load(open(cost_summary_path)) if cost_summary_path.exists() else None

json.dump(
    {"field_stats": field_stats, "rows": rows_for_csv, "cost_summary": cost_summary},
    open(RESULTS_DIR / "summary.json", "w"),
    indent=2,
)
print(f"\nWrote {RESULTS_DIR / 'summary.json'}")
