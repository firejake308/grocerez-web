#!/usr/bin/env python3
"""Benchmark several OpenRouter vision models against GrocerEZ price/item photo pairs.

Reproduces the exact prompt used in src/parsePriceImage.ts and runs it against
each candidate model for every (price image, item image) pair, saving raw
responses and a parsed CSV.
"""
import base64
import concurrent.futures
import json
import os
import re
import sys
import time
from pathlib import Path

import requests

BASE_DIR = Path(__file__).resolve().parent.parent
IMG_DIR = BASE_DIR / "data"
RESULTS_DIR = BASE_DIR / "results"
RAW_DIR = RESULTS_DIR / "raw_responses"
RESULTS_DIR.mkdir(exist_ok=True)
RAW_DIR.mkdir(exist_ok=True)

API_URL = "https://openrouter.ai/api/v1/chat/completions"


def _load_api_key() -> str:
    # Read lazily (not at import time) so other scripts can import this
    # module (e.g. for its constants/helpers) without needing an API key,
    # e.g. retry_failed.py, or scoring, which never call the API.
    key_path = BASE_DIR / "or_key.txt"
    if not key_path.exists():
        raise FileNotFoundError(
            f"{key_path} not found. Create it with your OpenRouter API key "
            "(one line, no quotes) before running this script. It's gitignored."
        )
    return key_path.read_text().strip()


API_KEY = None  # populated on first use via get_api_key()


def get_api_key() -> str:
    global API_KEY
    if API_KEY is None:
        API_KEY = _load_api_key()
    return API_KEY

MODELS = [
    "google/gemini-2.5-flash-lite",
    "xiaomi/mimo-v2.5",
    "google/gemma-4-26b-a4b-it",
    "openai/gpt-5-nano",
    "meta-llama/llama-4-scout",
]

PROMPT_TEXT = (
    "I will show you two images. The first is a price tag and the second is the product itself. "
    "Please extract the price, itemName, brand, quantity, and quantityUnits. "
    "Use both images to improve accuracy. The product image may help identify the brand and item name. "
    "Expand all abbreviations in itemName and brand (e.g. 'Org' → 'Organic', 'Chkn' → 'Chicken', 'Stk' → 'Steak', 'Whl' → 'Whole', 'Veg' → 'Vegetable'). "
    "For quantityUnits, always use the full singular unit name (e.g. 'oz' → 'ounce', 'lb' → 'pound', 'fl oz' → 'fluid ounce', 'ct' → 'count', 'pkg' → 'package', 'gal' → 'gallon', 'qt' → 'quart', 'pt' → 'pint'). "
    "For products sold as a multipack of individually-used disposable items (e.g. tissues, wipes, paper towels, diapers, napkins), report quantity as the total count of individual units across the whole package, not the number of boxes/rolls/packs — for example, 4 boxes of tissues at 65 tissues per box is quantity 260 with quantityUnits 'tissue'. Use the count printed per box/roll together with the number of boxes/rolls to compute this total when both are visible; otherwise fall back to the box/roll/pack count. "
    "The price is normally just the single dollar amount shown as the main price on the tag — report that number as-is. Only divide it when the tag is explicitly advertising a multi-buy deal for multiple separate purchases, phrased like '10/10.00', '3 for $11.11', 'buy 3 get 1 free', or a discount tier — in that case only, compute and report price as the price of a single unit, as a plain decimal number, never a slash, fraction, or the word 'for' (e.g. '10/10.00' becomes 1.00). Do NOT divide the price just because the package itself contains multiple items (e.g. a '4 count' box, a '12 pack', a '4/160 ct' multi-box case) — that count describes the package contents, not a multi-buy price deal, so the full tag price is the answer as long as only one item of that package is being purchased. If the tag lists two prices, such as a regular price and a members-only/loyalty price, pick one of them and use it consistently rather than reporting both. "
    "In addition to price, itemName, brand, quantity, and quantityUnits, infer 2-4 tags: lowercase "
    "generic grocery search terms a shopper might type to find this product, based on what kind of "
    "product it is — not text printed on the packaging or price tag. Favor broader category words that "
    "don't already appear in itemName. For example, a package showing 'Buldak Spicy Ramen' should get "
    "tags like 'noodles' and 'instant noodles' even though neither word is printed on it; 'Frozen Greek "
    "Yogurt Bars' should get 'yogurt' and 'frozen dessert'. Return tags as a JSON array of strings. "
    "Return the data as a JSON object. Skip any fields not clearly visible in either image."
)


def build_pairs():
    pairs = []
    for n in range(4, 77, 2):  # 4,6,...,76 -> item images (even)
        item_num = n
        price_num = n + 1
        item_file = IMG_DIR / f"download ({item_num}).jpeg"
        price_file = IMG_DIR / f"download ({price_num}).jpeg"
        assert item_file.exists(), item_file
        assert price_file.exists(), price_file
        pairs.append({"pair_id": f"item_{item_num:02d}", "item_file": item_file, "price_file": price_file})
    return pairs


def to_data_url(path: Path) -> str:
    b64 = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"data:image/jpeg;base64,{b64}"


def call_model(model: str, pair: dict, price_data_url: str, item_data_url: str, max_retries=3):
    payload = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": PROMPT_TEXT},
                    {"type": "image_url", "image_url": {"url": price_data_url}},
                    {"type": "image_url", "image_url": {"url": item_data_url}},
                ],
            }
        ],
        "max_tokens": 4000,
        "usage": {"include": True},
    }
    headers = {
        "Authorization": f"Bearer {get_api_key()}",
        "Content-Type": "application/json",
    }
    last_err = None
    for attempt in range(max_retries):
        try:
            resp = requests.post(API_URL, headers=headers, json=payload, timeout=90)
            raw_text = resp.text
            out_path = RAW_DIR / f"{pair['pair_id']}__{model.replace('/', '_')}.json"
            out_path.write_text(raw_text)
            if resp.status_code == 429:
                wait = 2 ** attempt * 3
                time.sleep(wait)
                last_err = f"429 rate limited"
                continue
            data = json.loads(raw_text)
            usage = data.get("usage") or {}
            cost = usage.get("cost")
            prompt_tokens = usage.get("prompt_tokens")
            completion_tokens = usage.get("completion_tokens")
            base = {
                "pair_id": pair["pair_id"],
                "model": model,
                "cost_usd": cost,
                "prompt_tokens": prompt_tokens,
                "completion_tokens": completion_tokens,
            }
            if "error" in data:
                return {**base, "error": json.dumps(data["error"])}
            content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
            if not content:
                return {**base, "error": "empty content"}
            start = content.find("{")
            end = content.rfind("}")
            if start == -1 or end == -1:
                return {**base, "error": f"no JSON in content: {content[:200]}"}
            parsed = json.loads(content[start:end + 1])
            tags = parsed.get("tags", [])
            if isinstance(tags, str):
                tags = [t.strip() for t in tags.split(",") if t.strip()]
            elif not isinstance(tags, list):
                tags = []
            return {
                **base,
                "itemName": parsed.get("itemName", ""),
                "brand": parsed.get("brand", ""),
                "tags": "; ".join(str(t) for t in tags),
                "price": parsed.get("price", ""),
                "quantity": parsed.get("quantity", ""),
                "quantityUnits": parsed.get("quantityUnits", ""),
                "error": "",
            }
        except requests.exceptions.RequestException as e:
            last_err = str(e)
            time.sleep(2 ** attempt)
        except json.JSONDecodeError as e:
            last_err = f"JSON decode error: {e}; raw={raw_text[:300]}"
            break
    return {"pair_id": pair["pair_id"], "model": model, "cost_usd": None, "error": last_err or "unknown error"}


def main():
    pairs = build_pairs()
    print(f"Loaded {len(pairs)} image pairs", file=sys.stderr)

    # Pre-encode all images once
    encoded = {}
    for p in pairs:
        encoded[p["pair_id"]] = (to_data_url(p["price_file"]), to_data_url(p["item_file"]))

    jobs = []
    for model in MODELS:
        for pair in pairs:
            price_url, item_url = encoded[pair["pair_id"]]
            jobs.append((model, pair, price_url, item_url))

    results = []
    print(f"Running {len(jobs)} requests across {len(MODELS)} models...", file=sys.stderr)
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
        futures = {ex.submit(call_model, m, p, pu, iu): (m, p["pair_id"]) for (m, p, pu, iu) in jobs}
        done_count = 0
        for fut in concurrent.futures.as_completed(futures):
            m, pid = futures[fut]
            try:
                res = fut.result()
            except Exception as e:
                res = {"pair_id": pid, "model": m, "error": f"exception: {e}"}
            results.append(res)
            done_count += 1
            status = "OK" if not res.get("error") else f"ERR: {res.get('error')[:80]}"
            print(f"[{done_count}/{len(jobs)}] {m} / {pid}: {status}", file=sys.stderr)

    out_path = RESULTS_DIR / "results_long.json"
    out_path.write_text(json.dumps(results, indent=2))
    print(f"Wrote {out_path}", file=sys.stderr)

    # ---- Cost summary ----
    per_model_cost = {m: 0.0 for m in MODELS}
    per_model_count = {m: 0 for m in MODELS}
    missing_cost = 0
    for r in results:
        c = r.get("cost_usd")
        per_model_count[r["model"]] = per_model_count.get(r["model"], 0) + 1
        if c is None:
            missing_cost += 1
        else:
            per_model_cost[r["model"]] = per_model_cost.get(r["model"], 0.0) + c

    total_cost = sum(per_model_cost.values())
    summary = {
        "total_cost_usd": round(total_cost, 6),
        "per_model_cost_usd": {m: round(v, 6) for m, v in per_model_cost.items()},
        "per_model_avg_cost_usd": {
            m: round(per_model_cost[m] / per_model_count[m], 6) if per_model_count[m] else 0
            for m in MODELS
        },
        "requests_missing_cost": missing_cost,
    }
    cost_path = RESULTS_DIR / "cost_summary.json"
    cost_path.write_text(json.dumps(summary, indent=2))

    print("\n=== Cost summary ===", file=sys.stderr)
    for m in MODELS:
        print(f"  {m}: ${per_model_cost[m]:.4f} total, ${summary['per_model_avg_cost_usd'][m]:.5f}/req ({per_model_count[m]} reqs)", file=sys.stderr)
    print(f"  TOTAL: ${total_cost:.4f}", file=sys.stderr)
    if missing_cost:
        print(f"  ({missing_cost} requests had no cost data, e.g. failed calls)", file=sys.stderr)
    print(f"Wrote {cost_path}", file=sys.stderr)


if __name__ == "__main__":
    main()
