#!/usr/bin/env python3
"""Build an HTML review artifact: one section per item, images + a table of
model outputs per field, with disagreeing fields highlighted."""
import base64
import io
import json
from pathlib import Path

from PIL import Image

BASE_DIR = Path(__file__).resolve().parent.parent
IMG_DIR = BASE_DIR / "data"
RESULTS_DIR = BASE_DIR / "results"
OUT_PATH = RESULTS_DIR / "grocerez_ai_parsing_benchmark.html"

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
FIELDS = ["itemName", "brand", "tags", "price", "quantity", "quantityUnits"]
FIELD_LABEL = {
    "itemName": "Item Name",
    "brand": "Brand",
    "tags": "Tags",
    "price": "Price",
    "quantity": "Quantity",
    "quantityUnits": "Quantity Units",
}

summary = json.load(open(RESULTS_DIR / "summary.json"))
rows = summary["rows"]
field_stats = summary["field_stats"]

thumb_cache = {}


def thumb_data_uri(filename, max_dim=340):
    if filename in thumb_cache:
        return thumb_cache[filename]
    path = IMG_DIR / filename
    im = Image.open(path)
    im.thumbnail((max_dim, max_dim))
    buf = io.BytesIO()
    im.convert("RGB").save(buf, format="JPEG", quality=78)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")
    uri = f"data:image/jpeg;base64,{b64}"
    thumb_cache[filename] = uri
    return uri


def esc(s):
    return (
        str(s)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def row_disagreement_count(row):
    return sum(1 for f in FIELDS if row.get(f"{f}__disagreement") == "YES")


rows_sorted = sorted(rows, key=lambda r: (-row_disagreement_count(r), r["pair_id"]))

total_flags = sum(field_stats[f]["disagree"] for f in FIELDS)

parts = []
parts.append("""<!doctype html>
<title>GrocerEZ &mdash; AI Parsing Benchmark</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #f5f4ee;
  --surface: #ffffff;
  --surface-sunk: #edece4;
  --border: #ddd9c9;
  --text: #23261f;
  --text-muted: #6d7062;
  --accent: #2f6f5e;
  --accent-soft: #e2efe9;
  --accent-text: #1c4a3d;
  --warn-bg: #fbe7cd;
  --warn-text: #7a4308;
  --warn-strip: #d97a24;
  --chip-bg: #edece4;
  --shadow: 0 1px 2px rgba(30, 32, 26, 0.06);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #14160f;
    --surface: #1c1f16;
    --surface-sunk: #23261c;
    --border: #363a2c;
    --text: #eae8dd;
    --text-muted: #9a9d8c;
    --accent: #63b39c;
    --accent-soft: #1e3630;
    --accent-text: #8fd4bd;
    --warn-bg: #3d2a10;
    --warn-text: #f0b169;
    --warn-strip: #d9822e;
    --chip-bg: #23261c;
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
  }
}
:root[data-theme="dark"] {
  --bg: #14160f; --surface: #1c1f16; --surface-sunk: #23261c; --border: #363a2c;
  --text: #eae8dd; --text-muted: #9a9d8c; --accent: #63b39c; --accent-soft: #1e3630;
  --accent-text: #8fd4bd; --warn-bg: #3d2a10; --warn-text: #f0b169; --warn-strip: #d9822e;
  --chip-bg: #23261c; --shadow: 0 1px 2px rgba(0,0,0,0.3);
}
:root[data-theme="light"] {
  --bg: #f5f4ee; --surface: #ffffff; --surface-sunk: #edece4; --border: #ddd9c9;
  --text: #23261f; --text-muted: #6d7062; --accent: #2f6f5e; --accent-soft: #e2efe9;
  --accent-text: #1c4a3d; --warn-bg: #fbe7cd; --warn-text: #7a4308; --warn-strip: #d97a24;
  --chip-bg: #edece4; --shadow: 0 1px 2px rgba(30,32,26,0.06);
}
* { box-sizing: border-box; }
body {
  font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
  margin: 0; padding: 32px 28px 60px;
  background: var(--bg); color: var(--text);
  max-width: 980px; margin-inline: auto;
}
.masthead { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; margin-bottom: 4px; }
h1 {
  font-size: 1.55rem; font-weight: 700; margin: 0;
  letter-spacing: -0.01em; text-wrap: balance;
}
.masthead .tag {
  font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.08em;
  color: var(--accent-text); background: var(--accent-soft); border-radius: 999px; padding: 3px 10px;
}
.subtitle { color: var(--text-muted); margin: 6px 0 22px; font-size: 0.9rem; max-width: 62ch; line-height: 1.5; }
.subtitle code { font-family: ui-monospace, 'SFMono-Regular', Menlo, monospace; font-size: 0.85em; background: var(--surface-sunk); padding: 1px 5px; border-radius: 4px; }

.summary-bar { display: grid; grid-template-columns: repeat(6, 1fr); gap: 1px; background: var(--border); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; margin-bottom: 22px; box-shadow: var(--shadow); }
@media (max-width: 700px) { .summary-bar { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 420px) { .summary-bar { grid-template-columns: repeat(2, 1fr); } }
.summary-chip { background: var(--surface); padding: 12px 14px; }
.summary-chip .lbl { display: block; font-size: 0.65rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted); margin-bottom: 6px; }
.summary-chip .val { font-variant-numeric: tabular-nums; font-size: 1.3rem; font-weight: 700; }
.summary-chip .val .of { font-size: 0.72rem; font-weight: 500; color: var(--text-muted); }
.summary-chip.hot .val { color: var(--warn-strip); }

.controls { margin-bottom: 18px; display: flex; gap: 8px; }
.controls button {
  font-size: 0.78rem; font-weight: 600; padding: 7px 13px; border-radius: 7px;
  border: 1px solid var(--border); background: var(--surface); color: var(--text); cursor: pointer;
}
.controls button:hover { border-color: var(--accent); color: var(--accent-text); }
.controls button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

.item-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; margin-bottom: 12px; overflow: hidden; box-shadow: var(--shadow); }
.item-header {
  display: flex; align-items: center; gap: 13px; padding: 10px 14px; cursor: pointer;
  border-left: 4px solid transparent;
}
.item-header:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.item-card.flagged .item-header { border-left-color: var(--warn-strip); }
.item-header img { width: 50px; height: 50px; object-fit: cover; border-radius: 6px; border: 1px solid var(--border); flex-shrink: 0; }
.item-header .pid { font-weight: 600; font-size: 0.88rem; font-variant-numeric: tabular-nums; color: var(--text-muted); width: 5.5em; flex-shrink: 0; }
.item-header .headline { font-size: 0.92rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item-header .flagcount {
  margin-left: auto; font-size: 0.72rem; font-weight: 700; padding: 4px 10px; border-radius: 999px;
  background: var(--chip-bg); color: var(--text-muted); flex-shrink: 0;
}
.flagcount.has-flags { background: var(--warn-bg); color: var(--warn-text); }
.chevron { color: var(--text-muted); transition: transform 0.15s ease; flex-shrink: 0; }
.item-card.open .chevron { transform: rotate(90deg); }
@media (prefers-reduced-motion: reduce) { .chevron { transition: none; } }

.item-body { display: none; padding: 4px 16px 18px; }
.item-card.open .item-body { display: block; }
.images { display: flex; gap: 10px; margin-bottom: 14px; }
.images figure { margin: 0; text-align: center; }
.images img { max-width: 220px; max-height: 220px; border-radius: 7px; border: 1px solid var(--border); display: block; }
.images figcaption { font-size: 0.68rem; color: var(--text-muted); margin-top: 4px; font-family: ui-monospace, monospace; }

.tablewrap { overflow-x: auto; }
table.fields { width: 100%; border-collapse: collapse; font-size: 0.82rem; }
table.fields th, table.fields td { border: 1px solid var(--border); padding: 7px 9px; text-align: left; vertical-align: top; }
table.fields th { background: var(--surface-sunk); font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.03em; color: var(--text-muted); white-space: nowrap; }
tr.disagree td.fieldname { background: var(--warn-bg); color: var(--warn-text); }
td.fieldname { font-weight: 600; white-space: nowrap; }
.score { color: var(--text-muted); font-size: 0.68rem; font-weight: 400; font-variant-numeric: tabular-nums; }
td.numeric { font-variant-numeric: tabular-nums; }

.cost-bar { display: flex; gap: 1px; background: var(--border); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; margin-bottom: 14px; box-shadow: var(--shadow); flex-wrap: wrap; }
.cost-chip { background: var(--surface); padding: 10px 14px; flex: 1 1 120px; }
.cost-chip .lbl { display: block; font-size: 0.63rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cost-chip .val { font-variant-numeric: tabular-nums; font-size: 1.05rem; font-weight: 700; }
.cost-chip.total { background: var(--accent-soft); }
.cost-chip.total .lbl { color: var(--accent-text); }
.cost-chip.total .val { color: var(--accent-text); }
</style>
<div class="masthead">
<h1>GrocerEZ AI Parsing Benchmark</h1>
<span class="tag">36 items &times; {n_models} models</span>
</div>
<p class="subtitle">Each item was parsed by every model using the production prompt from <code>parsePriceImage.ts</code>, given the price-tag photo and the product photo together. Fields are flagged when models materially disagree &mdash; text fields by phrasing similarity, tags by overlap, price/quantity/units by exact match after normalizing. Cards with flags are sorted first and start expanded; click any card to toggle.</p>
""".replace("{n_models}", str(len(MODELS))))

cost_summary = summary.get("cost_summary")
if cost_summary:
    parts.append('<div class="cost-bar">')
    parts.append(
        f'<div class="cost-chip total"><span class="lbl">Total run cost</span>'
        f'<span class="val">${cost_summary["total_cost_usd"]:.4f}</span></div>'
    )
    for m in MODELS:
        c = cost_summary["per_model_cost_usd"].get(m, 0)
        parts.append(
            f'<div class="cost-chip"><span class="lbl">{esc(MODEL_SHORT.get(m, m))}</span>'
            f'<span class="val">${c:.4f}</span></div>'
        )
    parts.append("</div>")

parts.append('<div class="summary-bar">')
for f in FIELDS:
    d = field_stats[f]
    hot = " hot" if d["disagree"] >= 15 else ""
    parts.append(
        f'<div class="summary-chip{hot}"><span class="lbl">{FIELD_LABEL[f]}</span>'
        f'<span class="val">{d["disagree"]}<span class="of">/{d["total"]}</span></span></div>'
    )
parts.append("</div>")

parts.append(
    '<div class="controls">'
    '<button onclick="document.querySelectorAll(\'.item-card\').forEach(c=>c.classList.add(\'open\'))">Expand all</button>'
    '<button onclick="document.querySelectorAll(\'.item-card\').forEach(c=>c.classList.remove(\'open\'))">Collapse all</button>'
    '</div>'
)

CHEVRON = '<svg class="chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3l5 5-5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'

for row in rows_sorted:
    pid = row["pair_id"]
    item_img = row["item_image"]
    price_img = row["price_image"]
    flags = row_disagreement_count(row)
    flag_class = "has-flags" if flags else ""
    card_class = "item-card" + (" flagged open" if flags else "")
    item_uri = thumb_data_uri(item_img)
    price_uri = thumb_data_uri(price_img)
    # pick the shortest non-empty itemName as a rough headline for the collapsed row
    names = [row.get(f"itemName__{m}", "") for m in MODELS]
    names = [n for n in names if n]
    headline = min(names, key=len) if names else "(no name extracted)"

    parts.append(f'<div class="{card_class}">')
    parts.append(
        f'<div class="item-header" role="button" tabindex="0" '
        f'onclick="this.closest(\'.item-card\').classList.toggle(\'open\')" '
        f'onkeydown="if(event.key===\'Enter\'||event.key===\' \'){{event.preventDefault();this.click();}}">'
        f'{CHEVRON}<img src="{item_uri}" alt=""><span class="pid">{esc(pid)}</span>'
        f'<span class="headline">{esc(headline)}</span>'
        f'<span class="flagcount {flag_class}">{flags} field{"s" if flags != 1 else ""} disagree</span></div>'
    )
    parts.append('<div class="item-body">')
    parts.append('<div class="images">')
    parts.append(f'<figure><img src="{item_uri}"><figcaption>{esc(item_img)} &middot; item</figcaption></figure>')
    parts.append(f'<figure><img src="{price_uri}"><figcaption>{esc(price_img)} &middot; price tag</figcaption></figure>')
    parts.append("</div>")

    parts.append('<div class="tablewrap"><table class="fields"><tr><th>Field</th>')
    for m in MODELS:
        parts.append(f"<th>{esc(MODEL_SHORT[m])}</th>")
    parts.append("</tr>")

    for field in FIELDS:
        disagree = row.get(f"{field}__disagreement") == "YES"
        score = row.get(f"{field}__agreement_score", "")
        tr_class = "disagree" if disagree else ""
        td_class = "numeric" if field in ("price", "quantity") else ""
        parts.append(f'<tr class="{tr_class}">')
        parts.append(f'<td class="fieldname">{FIELD_LABEL[field]}<div class="score">agree {score}</div></td>')
        for m in MODELS:
            v = row.get(f"{field}__{m}", "")
            parts.append(f'<td class="{td_class}">{esc(v)}</td>')
        parts.append("</tr>")
    parts.append("</table></div>")
    parts.append("</div></div>")

OUT_PATH.write_text("\n".join(parts))
print(f"Wrote {OUT_PATH} ({OUT_PATH.stat().st_size/1024:.0f} KB)")
