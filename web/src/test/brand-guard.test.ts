import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every colour in the app comes from the ten tokens in src/index.css. This reads every source file
// and refuses a dark: variant, a Tailwind default-palette class, or a hex colour anywhere else.
// The CSS is read from disk: Vite would hand the glob Tailwind's compiled output, not the source.
const files = import.meta.glob<string>(['../**/*.{ts,tsx}', '!../test/**', '!../icons/**'], { query: '?raw', import: 'default', eager: true });
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
const TOKENS = ['#35a839', '#186738', '#f7fdf7', '#da222a', '#fdf2f2', '#242623', '#727272', '#e0e0e0', '#ffffff', '#f5f5f5'];
const DEFAULT_PALETTE = /\b(?:bg|text|border|ring|outline|accent|from|to|via|fill|stroke|divide|placeholder|shadow|decoration|caret)-(?:gray|zinc|slate|neutral|stone|emerald|green|red|amber|yellow|blue|sky|indigo|orange|lime|teal|cyan|violet|purple|fuchsia|pink|rose|white|black)(?:-\d{2,3})?(?:\/\d+)?\b/g;

describe('brand guard', () => {
  const entries = Object.entries(files);
  it('sees the source tree', () => { expect(entries.length).toBeGreaterThan(30); });
  it('index.css holds exactly the ten brand tokens', () => {
    const found = [...new Set((css.match(/#[0-9a-f]{6}\b/gi) ?? []).map((h) => h.toLowerCase()))].sort();
    expect(found).toEqual([...TOKENS].sort());
  });
  it('no file uses a dark: variant', () => {
    expect(entries.filter(([, src]) => /\bdark:/.test(src)).map(([f]) => f)).toEqual([]);
  });
  it('no file uses a Tailwind default-palette colour class', () => {
    const bad = entries.flatMap(([f, src]) => { const hits = src.match(DEFAULT_PALETTE); return hits ? [`${f}: ${[...new Set(hits)].join(' ')}`] : []; });
    expect(bad).toEqual([]);
  });
  it('no file outside index.css carries a hex colour', () => {
    const bad = entries.filter(([, src]) => /#[0-9a-f]{3,8}\b/i.test(src.replace(/\/\/.*$/gm, ''))).map(([f]) => f);
    expect(bad).toEqual([]);
  });
});
