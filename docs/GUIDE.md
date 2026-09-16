# How to use Daraja Studio

The manual lives in one place, `web/src/copy/guide.ts`, and is published two ways:

- inside the app at `/guide` (menu › How to use; also linked from Login and the setup wizard);
- as Markdown at `/guide.md` with no login, for AI agents and scripts, plus `/llms.txt` pointing to it.

After editing `guide.ts`, run `pnpm -C web guide:md` to rewrite `web/public/guide.md` and
`web/public/llms.txt`; `web/src/test/guide.test.tsx` fails when they are stale.

Live: https://darajastudio.com/guide and https://darajastudio.com/guide.md
