# Hard Rock Cafe Dublin – Line Check

A tablet app for the daily **line check** and **temperature checklist**. It replaces the paper sheets
(`NEW LINE CHECK – 2026.xlsx`, sheet *Horizontal*, and the FSS *Temperature Checklist*), and it can
still print the same sheets or download them as the original Excel files, filled in.

## How it works for managers

- **One page, no "Next" buttons.** Each section of the line check is a card on one scrolling page.
  The chips at the top jump to a section and show how many items are done.
- **Tap ✓** when an item is right, **tap !** when there's a problem. The problem tags (N, BU, X, P, F)
  and a comment box open when you tap !.
- **Temperatures:** type the reading. An in-range reading ticks the item for you. Enter jumps to the
  next temperature. An out-of-range reading turns red and asks for the corrective action.
- **Rest OK** on a section ticks every item that hasn't been done yet. There's an Undo.
- **"… left – next"** (bottom right) jumps to the next item that isn't checked.
- **AM / PM:** each shift fills its own column of the same day. The other shift's result shows under
  each item. The PM manager opens the day (it's already open: it's *today*) and carries on.
- **Sign off** with your initials at the bottom. That locks the shift. **Reopen** unlocks it and keeps
  everything already filled in, so the PM manager can reopen AM and finish it.
- **Temperatures tab:** fridges and freezers (opening, 12:00, 16:00, 20:00, closing), hot holding,
  cooking, dish washer, fryers, grill and flat top. Each shift sees its own times.
- **Print & history tab:**
  - **Print** – A4 landscape, laid out like the paper sheets (choose *Save as PDF* to keep a PDF).
  - **Excel file** – downloads the original Excel template with the day filled in (✓/✗, comments,
    temperatures, manager initials, date).
  - **Saved days** – every day kept on the tablet. Open one to finish it, print it or download it.
  - **Backup** – download a backup file now and then, and restore it on a new tablet if needed.

## Nothing gets lost mid-check

- Every tap is saved on the tablet before anything else happens. Closing the browser, a crash, a
  flat battery or no Wi-Fi don't lose anything. Open the app again and it's exactly where it was,
  same day, same shift, same place on the page.
- The app opens without Wi-Fi once it has been opened once (it keeps an offline copy).
- If the tablet's storage is ever full, the oldest saved day is removed (with a message). If even that
  doesn't free enough space, the app shows a red **NOT saved** warning and doesn't stay quiet about it.
- Each day keeps a copy of the checklist it was started with, so changing the item list later never
  changes a day that was already filled in.

## Setting up the tablet

1. Open the Netlify address in Safari (iPad) or Chrome (Android).
2. **Add to Home Screen** – it then opens full-screen like an app.
3. Don't use private/incognito browsing: nothing can be kept there.
4. Always use the same tablet and browser – the days are stored in that browser on that tablet.

## Deploying on Netlify

1. Netlify → *Add new site* → *Import an existing project* → pick this GitHub repo.
2. The settings come from `netlify.toml`: build command `npm test`, publish directory `public`.
   The tests must pass or the deploy is cancelled.
3. No login or environment variables are needed. The site sends `noindex` headers and a
   `robots.txt` so search engines don't list it.

## Changing the checklist

- Line check items: `public/js/line-template.mjs` (one line per item:
  `["Item", "Temp", "Shelf life", "Utensil", "Quality identifiers"]`).
- Temperature checklist rows: the bottom of the same file.
- The Excel download writes into `public/templates/line-check.xlsx` and
  `public/templates/temperature-checklist.xlsx`. If you add, rename or remove an item, make the same
  change in the Excel template. `npm test` checks they match, so a mismatch blocks the deploy rather
  than giving you a wrong sheet.

## Files

| Path | What it is |
| --- | --- |
| `public/index.html` | The page |
| `public/js/app.mjs` | Screens: line check, temperatures, print & history |
| `public/js/core.mjs` | Shared rules: items, temperature limits, progress, merging |
| `public/js/store.mjs` | Saving on the tablet, backup/restore |
| `public/js/print.mjs` | The printed sheets |
| `public/js/xlsx.mjs` | Fills in the Excel templates |
| `public/js/line-template.mjs` | The checklist items |
| `public/templates/` | The original Excel templates |
| `public/sw.js` | Offline copy |
| `public/vendor/fflate.mjs` | Zip library (MIT) used to read/write the Excel files |
| `tests/` | `npm test` |

## Working on it

```sh
npm start   # http://localhost:8888
npm test
```

No packages need installing.
