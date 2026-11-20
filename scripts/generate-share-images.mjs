// Renders the PNGs that link previews and "Add to Home Screen" need, from
// public/ez-logo.svg, using Playwright's Chromium:
//
//   node scripts/generate-share-images.mjs
//
// Writes into public/: og-image.png (1200x630 link preview), icon-192.png,
// icon-512.png, icon-maskable-512.png and apple-touch-icon.png. The preview
// card's text uses the Inter font if it is installed, else a system sans-serif.
// Re-run after changing the logo or the card copy below, and commit the PNGs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

// require() rather than import so a global Playwright (on NODE_PATH) works too;
// otherwise `npm i --no-save playwright && npx playwright install chromium` first.
const { chromium } = createRequire(import.meta.url)('playwright');

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = join(root, 'public');
const logoSvg = readFileSync(join(publicDir, 'ez-logo.svg'), 'utf8');
const GREEN = '#16A34A';

// The "EZ" letter paths, without the logo's rounded green tile.
const letters = [...logoSvg.matchAll(/<path[^>]*\/>/g)].map((m) => m[0]).join('');

/** A full-bleed square icon: no transparent corners (iOS shows those black), letters scaled into the middle `scale` of the tile. */
const squareIcon = (scale) => `
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 480" width="100%" height="100%">
    <rect width="480" height="480" fill="${GREEN}"/>
    <g transform="translate(240 240) scale(${scale}) translate(-240 -240)">${letters}</g>
  </svg>`;

const page = (body, w, h) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:transparent}
  body{font-family:Inter,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif}
  svg{display:block}
</style></head><body>${body}</body></html>`;

const ogCard = `
<div style="width:1200px;height:630px;box-sizing:border-box;padding:72px 80px;display:flex;align-items:center;gap:64px;
            background:linear-gradient(135deg,#f0fdf4 0%,#ffffff 60%);">
  <div style="flex:1;min-width:0">
    <div style="display:flex;align-items:center;gap:24px;margin-bottom:40px">
      <div style="width:104px;height:104px">${logoSvg.replace('<svg ', '<svg style="width:100%;height:100%" ')}</div>
      <div style="font-size:64px;font-weight:800;color:#111827;letter-spacing:-1px">GrocerEZ</div>
    </div>
    <div style="font-size:58px;line-height:1.1;font-weight:800;color:#111827;letter-spacing:-1.5px">
      See what groceries cost at the stores near you.
    </div>
    <div style="margin-top:28px;font-size:30px;line-height:1.35;color:#4b5563">
      Snap a price tag, share it, and compare prices other shoppers found.
    </div>
    <div style="margin-top:36px;display:inline-block;padding:12px 24px;border-radius:999px;background:${GREEN};
                color:#fff;font-size:26px;font-weight:700">Now in Dallas–Fort Worth</div>
  </div>
  <!-- A price tag in a camera viewfinder: "snap a price tag". -->
  <div style="position:relative;width:340px;height:340px;flex:none">
    ${['top:0;left:0;border-top-width:10px;border-left-width:10px;border-top-left-radius:28px',
       'top:0;right:0;border-top-width:10px;border-right-width:10px;border-top-right-radius:28px',
       'bottom:0;left:0;border-bottom-width:10px;border-left-width:10px;border-bottom-left-radius:28px',
       'bottom:0;right:0;border-bottom-width:10px;border-right-width:10px;border-bottom-right-radius:28px']
      .map((pos) => `<div style="position:absolute;width:72px;height:72px;border:0 solid ${GREEN};${pos}"></div>`).join('')}
    <div style="position:absolute;inset:58px;background:#fef08a;border-radius:18px;box-shadow:0 18px 40px rgba(0,0,0,.14);
                transform:rotate(-4deg);display:flex;flex-direction:column;justify-content:center;padding:0 30px">
      <div style="height:16px;width:70%;background:#a16207;opacity:.35;border-radius:8px;margin-bottom:14px"></div>
      <div style="height:16px;width:45%;background:#a16207;opacity:.25;border-radius:8px;margin-bottom:22px"></div>
      <div style="font-size:68px;font-weight:900;color:#111827;letter-spacing:-2px;line-height:1">$2.89</div>
    </div>
  </div>
</div>`;

const shots = [
  { file: 'og-image.png', w: 1200, h: 630, html: ogCard },
  { file: 'icon-192.png', w: 192, h: 192, html: logoSvg },
  { file: 'icon-512.png', w: 512, h: 512, html: logoSvg },
  // Maskable: launchers crop to a circle/squircle of ~80% of the tile, so keep the letters well inside it.
  { file: 'icon-maskable-512.png', w: 512, h: 512, html: squareIcon(0.7) },
  { file: 'apple-touch-icon.png', w: 180, h: 180, html: squareIcon(0.85) },
];

const browser = await chromium.launch();
try {
  for (const { file, w, h, html } of shots) {
    const p = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    const body = html.startsWith('<svg') ? html.replace('<svg ', '<svg style="width:100%;height:100%" ') : html;
    await p.setContent(page(body, w, h));
    await p.screenshot({ path: join(publicDir, file), omitBackground: true });
    await p.close();
    console.log(`wrote public/${file}`);
  }
} finally {
  await browser.close();
}
