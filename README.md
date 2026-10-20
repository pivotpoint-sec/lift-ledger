# Lift Ledger

A workout log that turns your sets into weekly volume per muscle group, flags what is under-trained, suggests exercises to fill the gaps and keeps weekly progress photos. It is a progressive web app (PWA): plain HTML, CSS and JavaScript with no build step and no server. All data stays on the user's device.

## Run it on your computer

Service workers need `localhost` or HTTPS, so open it through a local server rather than double-clicking the file:

```
cd lift-ledger-pwa
python3 -m http.server 8080
```

Then visit http://localhost:8080.

## Put it online for free

Any static host works. The two simplest:

**GitHub Pages**
1. Create a GitHub repository and upload the contents of this folder to it.
2. In the repository, open Settings, then Pages. Set the source to the main branch, root folder.
3. After a minute the site is live at `https://<your-username>.github.io/<repository>/`.

**Cloudflare Pages**
1. Create a free Cloudflare account and choose Workers & Pages, then Create, then Pages, then Upload assets.
2. Drag in this folder. You get a `*.pages.dev` address straight away.

All links in the app are relative, so it works from a sub-folder such as the GitHub Pages address.

## Share it with testers

Send the link. Testers install it like this:

- **iPhone:** open the link in Safari, tap Share, then Add to Home Screen.
- **Android:** open the link in Chrome and tap Install app (or use the browser menu, then Add to Home screen).

Once installed it opens full screen and works without a signal.

## Running the focus group

- **Feedback:** make a free Google Form (three questions a week is plenty) and paste its link into `config.js` as `feedbackUrl`. A Send feedback button then appears under More.
- **What to measure:** whether each person is still logging in week two and week four. Ask in the form, because the app deliberately collects no analytics.
- **Backups:** browser storage can be cleared, and iPhones are the less forgiving platform. The app reminds testers to download a backup after a week or two. Ask them to do it when they fill in the weekly form.
- **Photos:** tell testers photos never leave their phone and they can delete them or stop at any time.

## Updating the app

Edit the files and re-upload them (or push to GitHub). The service worker fetches files network first, so testers get the new version the next time they open the app with a connection. If you add or remove files, update the `SHELL` list in `sw.js`. If you change the shape of stored data, raise `DB_VERSION` in `storage.js` and add an upgrade step.

## Where the data lives

IndexedDB in the browser, in three stores: `days` (sessions and sets), `photos` (one JPEG per week and pose, shrunk to 1280px) and `meta` (targets, last backup date). The app asks the browser to protect that storage from automatic clean-up, and More shows whether it was granted.

Backups are one JSON file: `{ app, version, exportedAt, days, targets, photos }`. Photos are included only if the tester ticks the box. Restoring replaces sessions on the same dates and adds the rest.

## Files

| File | Purpose |
| --- | --- |
| `index.html`, `styles.css`, `app.js` | The screens: Log, Week, Photos, More |
| `logic.js` | Volume maths, suggestions, example data, backup validation (no DOM, tested in Node) |
| `storage.js` | IndexedDB wrapper with an in-memory fallback, backup export and import |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and installability |
| `config.js` | Settings you edit before sharing |
| `docs/schema.sql` | Reference SQLite data model for a future native app |
| `tests/` | `node tests/logic.test.js` (logic), and `node tests/smoke.js` (whole app in a simulated browser; first run `npm install --no-save jsdom fake-indexeddb`) |

## How sets are counted

A working set counts 1 set for each primary muscle and 0.5 for each secondary muscle. Warm-ups are left out. Weeks run Monday to Sunday. The default weekly ranges (for example 10 to 20 sets for chest) are starting points and can be changed under More, then Weekly targets.

## Not built yet

Photo analysis (pose landmarks and proportion tracking), sync between devices, accounts, and a rest timer. The schema in `docs/schema.sql` already has tables for photo measurements when you get there.
