# How to use Daraja Studio

The manual lives in one place, `web/src/copy/guide.ts`, and is published two ways:

- for people: inside the app at `/guide` (menu › How to use; also linked from Login and the setup
  wizard). Tasks and steps only. No API calls, no permission keys, no agent rules, no mention of
  the machine copy.
- for AI agents and scripts: `/guide.md` (and `/llms.txt` pointing to it). The server answers
  these only to a client that does not ask for HTML; a browser gets the app and lands on Home.

After editing `guide.ts`, run `pnpm -C web guide:md` to rewrite `web/public/guide.md` and
`web/public/llms.txt`; `web/src/test/guide.test.tsx` fails when they are stale.

```
curl -H 'Accept: text/markdown' https://darajastudio.com/guide.md
```
