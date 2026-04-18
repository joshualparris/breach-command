# Breach Command

A tactical turn-based roguelike for the browser.

## Included files

- `index.html`
- `style.css`
- `content.js`
- `game.js`
- `manifest.webmanifest`
- `sw.js`
- `icons/`
- `tests/`
- `LICENSE`

## Local test

Open directly:

- Double-click `index.html`

Or serve locally for more reliable service worker behaviour:

```bash
python -m http.server 8000
```

Then open:

```text
http://localhost:8000
```

## GitHub Pages publish

1. Create a new GitHub repository.
2. Upload the contents of this folder to the repo root.
3. Commit and push to `main`.
4. In GitHub, go to **Settings → Pages**.
5. Under **Build and deployment**, choose:
   - **Source:** Deploy from a branch
   - **Branch:** `main`
   - **Folder:** `/ (root)`
6. Save.
7. Wait for Pages to publish.
8. Open the Pages URL GitHub gives you.

Because all asset paths are relative, the game is suitable for GitHub Pages repo-subpath hosting.

## Android notes

- Best played in landscape during battles.
- Touch controls are built into the UI.
- The service worker enables basic offline caching after the first successful load.
- Installability depends on browser support and how aggressively the browser accepts the manifest and service worker.

## What I tested here

The included `tests/` scripts were run successfully with Node in this environment:

- content sanity checks
- integration smoke test
- passive battle completion test

## Caveats

This package is based on the files generated in your Claude session.
The core code appears substantial and testable, but real device playtesting is still needed for:

- touch feel
- Android browser UX
- GitHub Pages runtime behaviour
- balance and usability polish

## License

MIT
