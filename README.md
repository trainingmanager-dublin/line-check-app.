# Hard Rock Cafe Dublin – Line Check

A tablet app for the daily **line check** and **temperature checklist**. It replaces the paper sheets
(`NEW LINE CHECK – 2026.xlsx`, sheet *Horizontal*, and the FSS *Temperature Checklist*), and it can
still print the same sheets or download them as the original Excel files, filled in and signed.

## How it works for managers

**The top bar** has the day, **AM shift / PM shift**, and the three screens: **Line check**,
**Temperatures** (each showing how much is done) and **Print & history**.
**The bottom bar** always shows the shift's progress, problems, **Next** (jump to the next thing still
to do) and **Sign off**.

### Line check

- Every section is on one scrolling page, laid out like the paper sheet: item and quality
  identifiers, temp, shelf life, utensil, then the check. The chips at the top jump to a section.
- **Tap ✓** when an item is right, **tap !** when there's a problem (the N, BU, X, P, F tags and a
  comment box open). Tap an item's name to add a comment to any item.
- **Temperatures:** tap the box and type the reading on the big number pad (it has a minus key for
  freezers). An in-range reading ticks the item by itself; **Next** goes to the next temperature still
  to take. An out-of-range reading turns red and goes straight to the comment box for the corrective
  action. Typing a reading and then tapping ✓ is fine: the item stays ticked.
- **Rest OK** ticks every item in a section that doesn't need a temperature (with Undo), then puts the
  cursor in the first temperature still to take.
- **Still to do** hides everything that's finished, so the list shrinks as you go; finished sections
  fold down to one line.
- **Photos** (switch at the top): adds a camera button to every item. Photos show as thumbnails on
  the item and print on a photo page.

### Temperatures

- A row per fridge / station and a column per time of day, like the paper sheet. Each shift sees its
  own times (AM: opening and 12:00; PM: 16:00, 20:00 and closing); the column due now is highlighted.
- Out-of-range readings turn red and the row's **corrective action** box asks to be filled.
- Fryers (once a day, with the AM check), grill and flat top (AM and PM), dish washer (wash and
  rinse). The spare rows take a name for any other fridge or station. Photos work here too.

### Signing off (AM and PM)

- **Sign off** shows a summary: line check and temperatures done, problems, and anything not done
  yet (you can still sign with things not done).
- A problem **without a corrective action blocks signing**; each one has an **Add** button that
  takes you to it.
- Pick or type your **name**, **sign with your finger**, and tap **Sign off**. The shift is then locked.
- **Reopen** asks who is reopening, unlocks the shift and keeps everything filled in, so the PM manager
  can reopen AM and finish it. Who signed, who reopened and when is kept and printed.
- In the PM shift, a reminder shows if AM was never signed off.

### Print & history

- **Print**: A4 landscape, laid out like the paper sheets, with each shift's name, time and signature;
  the temperature checklist fits on one page. Choose *Save as PDF* to keep a PDF.
- **Excel file**: your original Excel template with the day filled in – ✓/✗, comments, temperatures,
  manager initials and names, the signatures as pictures, the date.
- **Saved days**: every day on the tablet, by month. Open one to finish it, print it or download it.
- **Backup**: download one now and then (with photos), and restore it on a new tablet if needed.
- **Settings**: number pad on/off, storage used, delete photos older than 3 months.

## Nothing gets lost

- **Every tap is saved on the tablet before anything else happens.** Closing the browser, a crash, a
  flat battery or no Wi-Fi lose nothing; the app reopens on the same day, shift and place.
- **Two tabs open at once can't wipe each other out**: every save merges what's stored box by box.
- **History has room for years.** Each day is also archived in the tablet's database (IndexedDB);
  only the last 3 weeks stay in the quick storage, and older days leave it only once the archive holds
  every box of them.
- The app opens without Wi-Fi once it has been opened once (offline copy).
- If storage were ever completely full, the app shows a red **NOT saved** warning rather than staying
  quiet.
- Each day keeps a copy of the checklist it was started with, so changing items later never changes a
  day already filled in.

## Setting up the tablet (important)

1. Open the Netlify address in Safari (iPad) or Chrome (Android).
2. **Add to Home Screen** and always open the line check from there. On an iPad this matters: Safari
   can clear a website's saved data if it isn't opened for 7 days; the Home Screen app is exempt.
   (The app shows a reminder in Safari.)
3. Don't use private/incognito browsing.
4. Always use the same tablet – the days are stored on it. **Download a backup every week or so**
   (Print & history → Backup); the app shows when the last one was.

## Deploying on Netlify

1. Netlify → *Add new site* → *Import an existing project* → pick this GitHub repo.
2. Settings come from `netlify.toml`: build command `npm test`, publish directory `public`.
   The tests must pass or the deploy is cancelled.
3. No login or environment variables are needed. The site sends `noindex` headers and a
   `robots.txt` so search engines don't list it.

## Changing the checklist

- Line check items: `public/js/line-template.mjs` (one line per item:
  `["Item", "Temp", "Shelf life", "Utensil", "Quality identifiers"]`).
- Temperature checklist rows: the bottom of the same file.
- The Excel download writes into `public/templates/line-check.xlsx` and
  `public/templates/temperature-checklist.xlsx`. Rows are matched by name, then by position, and the
  app's wording is written in – so fixing a spelling or renaming an item needs no Excel change. Adding
  items does: each section needs as many rows in the Excel sheet as it has items, and `npm test`
  blocks the deploy if one doesn't.

## Files

| Path | What it is |
| --- | --- |
| `public/index.html` | The page |
| `public/js/app.mjs` | Start-up, top bar, bottom bar, screens |
| `public/js/view-line.mjs` | Line check screen |
| `public/js/view-temps.mjs` | Temperature checklist screen |
| `public/js/view-print.mjs` | Print & history, backup, settings |
| `public/js/signoff.mjs` | Sign off / reopen |
| `public/js/signature.mjs` | Signature pad and drawing |
| `public/js/photos.mjs` | Photos (camera, storage, viewer) |
| `public/js/keypad.mjs` | On-screen number pad |
| `public/js/core.mjs` | Shared rules: items, limits, progress, what blocks signing, merging |
| `public/js/store.mjs` | Saving on the tablet, archive, backup/restore |
| `public/js/db.mjs` | The tablet database (IndexedDB) |
| `public/js/print.mjs` | The printed sheets |
| `public/js/xlsx.mjs` | Fills in the Excel templates |
| `public/js/line-template.mjs` | The checklist items |
| `public/templates/` | The original Excel templates |
| `public/sw.js` | Offline copy |
| `public/vendor/fflate.mjs` | Zip library (MIT) used to read/write the Excel files |
| `tests/` | `npm test` (rules, saving, Excel template, offline file list) |
| `tests/e2e/` | `npm run e2e` – the whole app in a real browser (needs Playwright) |

## Working on it

```sh
npm start      # http://localhost:8888
npm test       # what Netlify runs before every deploy
npm run e2e    # optional browser test (npm i -D playwright first)
```
