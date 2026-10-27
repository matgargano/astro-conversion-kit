# Applying a suggestion: --apply <id>

`convert-site --apply <id>` turns one suggestion from `suggestions.json` into a proposal: it
ships only in a `PROPOSALS=on` build until a person approves it. It never runs as part of a
conversion, and it never changes the default build. Proposals and exceptions follow SKILL.md,
"Decisions, exceptions, proposals".

## Before you start

- Run from `SITE`, with `suggestions.json`, `baseline/` and `capture/` present.
- `<id>` is a check id from `suggestions.json` (for example `http-links`, `render-blocking-scripts`).
  Collect every item with that id; with `--path <path>` only the item for that page.
- An item with `applyable: false` is not applied mechanically: say so, and offer to write the
  proposal by hand with the person's wording (alt text, copy, which duplicate page to keep).
- The working branch: `astro-rebuild` while its PR is open, otherwise `main`'s latest. Create
  `apply/<id>` from it. Never commit to `main`.

## The flow

1. **Read the item.** From `suggestions.json` take each matching item's `path`, `element`,
   `evidence`, `why`, `effort`, `risk` and `pages[]` (grouped items list every page they apply
   to; use `pages[]`, not the short evidence, for the full set).
2. **Record the decision.** `S decision '{"topic":"apply <id>","choice":"proposed","default":"reproduce live","reason":"<why>","costIfWrong":"<risk>"}'`
   prints its id (say `d12`); add its row to the Decisions table in `docs/plan.md`.
3. **Write the proposal records.** One per page and field it changes, in `proposals.json`, all
   carrying that decision id:

       { "id": "d12", "path": "/about/", "field": "link", "from": "http://partner.example.com/",
         "to": "https://partner.example.com/", "reason": "suggestion http-links: <why>",
         "approvedBy": "proposed", "date": "<today>" }

   `field` is one of the gates' fields (`title`, `description`, `canonical`, `robots`, `lang`,
   `h1`, `h2`, `text`, `og`, `jsonLd`, `link`, `redirect`, `media`, `formField`, `markup`). A change no gate
   field covers (`async` on a script tag, a header) needs no record of its own, but the decision
   id still switches it; record it with `field: "markup"` (checked by no gate, `from` and `to`
   describing the change) when the reviewer should see it in the records, as for rewritten hrefs.
4. **Make the change behind the switch.** In the layout or route that renders it, wrap the change
   in `proposalOn('d12')` from `src/lib/exceptions.mjs`, so the default build renders exactly
   what it did before and a `PROPOSALS=on` build renders the improvement. Never edit `baseline/`
   or `src/content/` text directly.
5. **One commit** on `apply/<id>`: `feat(proposal): <id>`, with the records and the change.
6. **Gates, both ways**, with the form flags on the command line (`forms.md`):
   `npm run build` then `npm run verify -- <flags>` must pass unchanged (the default build did
   not move); then `PROPOSALS=on npm run build` and `npm run verify:proposals -- <flags>` must
   pass. Any failure is fixed on the branch.
7. **The sheet.** Serve the `PROPOSALS=on` build and shoot only the affected pages:

       npm run review:shoot -- --base http://localhost:4321 --routes <pages> --widths 390,1440 --out review/new-<id> --delay 0

   `review:diff` fails a route present on one side only, so build a live folder holding just
   those routes from `capture/screens/live-all` (folder names are the path slugs, `/` is `home`,
   `/a/b/` is `a__b`):

       node -e "const fs=require('fs');const [src,dst,...r]=process.argv.slice(1);const keep=new Set(r);fs.mkdirSync(dst,{recursive:true});for(const x of keep)fs.cpSync(src+'/'+x,dst+'/'+x,{recursive:true});const m=JSON.parse(fs.readFileSync(src+'/manifest.json','utf8')).filter(e=>keep.has(e.route));fs.writeFileSync(dst+'/manifest.json',JSON.stringify(m,null,2)+'\n')" capture/screens/live-all review/live-<id> <slug> <slug>

   then `npm run review:diff -- --a review/live-<id> --b review/new-<id> --out review/diff-<id>`
   and `npm run review:sheet -- --live review/live-<id> --new review/new-<id> --diff review/diff-<id>/diff.json --out review/<id>.html`.
   Look: the visible change must be the intended one and nothing else (the diff will fail where
   the change is; that is the point).
8. **Hand it over.** Push `apply/<id>` and open a PR into the working branch (`gh pr create`),
   with the item's evidence, the records, both gate outputs and the sheet's result.

## When the person approves

The approved records move from `proposals.json` to `exceptions.json` with the person's name in
`approvedBy` (the `id` field can go), and the `proposalOn` switch in the code is replaced by the
change itself, in one commit `feat: apply <id>`. The default build now carries it, and `npm run
verify` passes because the exceptions say so.
