#!/usr/bin/env python3
import sys, json
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import run_benchmark as rb
import requests as _r

RESULTS_DIR = rb.RESULTS_DIR
pairs = {p['pair_id']: p for p in rb.build_pairs()}
results_path = RESULTS_DIR / "results_long.json"

def call_with_budget(model, pair_id, max_tokens):
    p = pairs[pair_id]
    price_url = rb.to_data_url(p['price_file'])
    item_url = rb.to_data_url(p['item_file'])
    payload = {
        "model": model,
        "messages": [
            {"role": "user", "content": [
                {"type": "text", "text": rb.PROMPT_TEXT},
                {"type": "image_url", "image_url": {"url": price_url}},
                {"type": "image_url", "image_url": {"url": item_url}},
            ]}
        ],
        "max_tokens": max_tokens,
        "usage": {"include": True},
    }
    headers = {"Authorization": f"Bearer {rb.get_api_key()}", "Content-Type": "application/json"}
    resp = _r.post(rb.API_URL, headers=headers, json=payload, timeout=150)
    raw_text = resp.text
    out_path = rb.RAW_DIR / f"{pair_id}__{model.replace('/', '_')}.json"
    out_path.write_text(raw_text)
    data = json.loads(raw_text)
    usage = data.get("usage") or {}
    content = data.get("choices", [{}])[0].get("message", {}).get("content", "")
    print(model, pair_id, "finish_reason:", data.get("choices", [{}])[0].get("finish_reason"), "content_len:", len(content or ""), "cost:", usage.get("cost"), flush=True)
    base = {"pair_id": pair_id, "model": model, "cost_usd": usage.get("cost"),
            "prompt_tokens": usage.get("prompt_tokens"), "completion_tokens": usage.get("completion_tokens")}
    if not content:
        return {**base, "error": "empty content (retry)"}
    start = content.find("{")
    end = content.rfind("}")
    parsed = json.loads(content[start:end + 1])
    tags = parsed.get("tags", [])
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",") if t.strip()]
    elif not isinstance(tags, list):
        tags = []
    return {
        **base,
        "itemName": parsed.get("itemName", ""), "brand": parsed.get("brand", ""),
        "tags": "; ".join(str(t) for t in tags),
        "price": parsed.get("price", ""), "quantity": parsed.get("quantity", ""),
        "quantityUnits": parsed.get("quantityUnits", ""), "error": "",
    }


def main():
    results = json.load(open(results_path))
    to_retry = [(r["model"], r["pair_id"]) for r in results if r.get("error")]
    print(f"Retrying {len(to_retry)} failed cells", flush=True)
    for model, pair_id in to_retry:
        try:
            new_res = call_with_budget(model, pair_id, 8000)
        except Exception as e:
            print(f"RETRY FAILED {model} {pair_id}: {e}", flush=True)
            continue
        for i, r in enumerate(results):
            if r["model"] == model and r["pair_id"] == pair_id:
                results[i] = new_res
                break
        json.dump(results, open(results_path, "w"), indent=2)
    remaining = [r for r in results if r.get("error")]
    print(f"Done. Errors remaining: {len(remaining)}", flush=True)
    for r in remaining:
        print(" ", r["model"], r["pair_id"], r.get("error"))


if __name__ == "__main__":
    main()
