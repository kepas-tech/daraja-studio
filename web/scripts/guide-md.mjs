// Writes public/guide.md and public/llms.txt from src/copy/guide.ts, so the manual an AI agent or a
// script fetches at /guide.md is the same text the How to use page shows. Run after editing guide.ts:
//   node scripts/guide-md.mjs
// (Node 22.18+ strips the types in guide.ts on its own; older 22.x needs --experimental-strip-types.)
// guide.test.tsx fails when the written files are older than the source.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { agentSection, guide, guideIntro, guideMachineLine, guideTitle } from '../src/copy/guide.ts';

export function renderGuide() {
  const out = [`# ${guideTitle}`, '', guideIntro, '', `${guideMachineLine} · This file is that copy.`, ''];
  out.push('## Contents', '');
  for (const s of guide) out.push(`- ${s.title}`);
  out.push(`- ${agentSection.title}`, '');
  for (const s of guide) {
    out.push(`## ${s.title}`, '');
    if (s.intro) out.push(s.intro, '');
    for (const t of s.tasks) {
      out.push(`### ${t.title}`, '');
      const meta = [t.safaricom && `Safaricom calls this: ${t.safaricom}`, t.path && `Page: ${t.path}`, t.who && `Who: ${t.who}`].filter(Boolean);
      if (meta.length) out.push(meta.join(' · '), '');
      t.steps.forEach((step, i) => out.push(`${i + 1}. ${step}`));
      out.push('');
      if (t.notes?.length) { for (const n of t.notes) out.push(`- ${n}`); out.push(''); }
      if (t.api?.length) {
        out.push('| Method | Path | Who |', '|---|---|---|');
        for (const a of t.api) out.push(`| ${a.method} | \`${a.path}\` | ${a.who} |`);
        out.push('');
      }
    }
  }
  out.push(`## ${agentSection.title}`, '', agentSection.intro, '', '### Session and errors', '');
  agentSection.session.forEach((s, i) => out.push(`${i + 1}. ${s}`));
  out.push('', '### Rules', '');
  agentSection.rules.forEach((s, i) => out.push(`${i + 1}. ${s}`));
  out.push('');
  return out.join('\n');
}

export function renderLlms() {
  return ['# Daraja Studio', '', '> A plain-English console for one M-Pesa paybill or till, self-hosted, over the Safaricom Daraja API.', '', '- [How to use Daraja Studio](/guide.md): every page and every API call, plus the rules for AI agents.', ''].join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const pub = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
  writeFileSync(join(pub, 'guide.md'), renderGuide());
  writeFileSync(join(pub, 'llms.txt'), renderLlms());
  console.log('wrote public/guide.md and public/llms.txt');
}
