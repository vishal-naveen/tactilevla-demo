import { THEMES, DEFAULT_THEME, themeFromURL } from '../themes.js';

// Applies a theme's palette to :root and derives every secondary token from it (scrims, shadows, text-safe
// accents, glow strengths), so no stylesheet needs to know which theme is active.

const hexToRgb = (h) => {
  const v = h.replace('#', '');
  const n = v.length === 3 ? v.split('').map((c) => c + c).join('') : v;
  return [0, 2, 4].map((i) => parseInt(n.slice(i, i + 2), 16));
};
const toHex = (rgb) => `#${rgb.map((c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, '0')).join('')}`;
const lin = (c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
const mix = (a, b, t) => a.map((c, i) => c + (b[i] - c) * t);

// Nudge `fg` toward `toward` until it reads on `bg` (used for accents that appear as text).
function readable(fg, bg, toward, min = 4.5) {
  let out = fg;
  for (let t = 0; t <= 1 && contrast(out, bg) < min; t += 0.04) out = mix(fg, toward, t);
  return out;
}

const list = (rgb) => rgb.map(Math.round).join(', ');

export function deriveTokens(css) {
  const c = Object.fromEntries(Object.entries(css).map(([k, v]) => [k, hexToRgb(v)]));
  const wall = c['--wall'], wall2 = c['--wall-2'], ivory = c['--ivory'];
  const light = lum(ivory) < lum(wall); // dark ink on a light page
  const ink = light ? ivory : wall2;    // the darkest end of the palette
  const paper = light ? wall : ivory;   // the lightest end
  const onAccent = contrast(c['--noodle'], wall2) >= contrast(c['--noodle'], ivory) ? wall2 : ivory;
  const t = {};
  Object.entries(c).forEach(([k, v]) => { t[`${k}-rgb`] = list(v); });
  t['--veil-rgb'] = list(light ? wall : wall2);
  t['--shadow-rgb'] = light ? '38, 50, 64' : '0, 0, 0';
  t['--shadow-a'] = light ? '0.24' : '0.9';
  t['--on-accent'] = toHex(onAccent);
  t['--accent-text'] = toHex(readable(c['--noodle'], wall, ink));
  t['--held-text'] = toHex(readable(c['--held'], wall, ink));
  t['--trained-text'] = toHex(readable(c['--trained'], wall, ink));
  t['--glow-a'] = light ? '0.28' : '0.5';
  t['--grain-a'] = light ? '0.05' : '0.055';
  t['--caption'] = `rgba(${list(ivory)}, ${light ? 0.82 : 0.74})`;
  t['--seg-idle'] = `rgba(${list(ivory)}, ${light ? 0.82 : 0.78})`;
  t['--paper-rgb'] = list(paper);
  return { tokens: t, light };
}

let current = DEFAULT_THEME;
export const currentTheme = () => current;

export function applyTheme(name, { updateURL = false } = {}) {
  const key = THEMES[name] ? name : DEFAULT_THEME;
  const theme = THEMES[key];
  const root = document.documentElement;
  const { tokens, light } = deriveTokens(theme.css);
  Object.entries(theme.css).forEach(([k, v]) => root.style.setProperty(k, v));
  Object.entries(tokens).forEach(([k, v]) => root.style.setProperty(k, v));
  // The loader ring keeps the stage's ring colour unless that would vanish against the loader background.
  const ring = hexToRgb(theme.stage.ring), bg = hexToRgb(theme.css['--wall-2']);
  const ringUse = contrast(ring, bg) >= 1.8 ? ring : hexToRgb(theme.css['--noodle']);
  root.style.setProperty('--ring-color', toHex(ringUse));
  root.style.setProperty('--ring-rgb', list(ringUse));
  root.dataset.theme = key;
  root.dataset.mode = light ? 'light' : 'dark';
  root.style.colorScheme = light ? 'light' : 'dark';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.css['--wall-2']);
  if (updateURL) {
    const url = new URL(location.href);
    url.searchParams.set('theme', key);
    history.replaceState(null, '', url);
  }
  current = key;
  return key;
}

export { THEMES, themeFromURL };

// Review-only switcher (?themes): four swatch dots with names, bottom-left. Switches page and stage live.
export function initThemeSwitcher(onChange) {
  const bar = document.createElement('div');
  bar.className = 'theme-switcher';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Theme');
  Object.entries(THEMES).forEach(([key, t]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.theme = key;
    b.setAttribute('aria-pressed', String(key === current));
    b.innerHTML = `<i style="background:linear-gradient(135deg, ${t.css['--wall']} 45%, ${t.css['--noodle']} 45% 70%, ${t.css['--held']} 70%)"></i><span>${t.label}</span>`;
    b.addEventListener('click', () => {
      applyTheme(key, { updateURL: true });
      bar.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      onChange?.(key);
    });
    bar.append(b);
  });
  document.body.append(bar);
}
