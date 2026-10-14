# Landing site

Static, no build step, no third-party requests. Fonts (Archivo, JetBrains Mono, both SIL OFL) are self-hosted in `assets/fonts/`. The hero demo lives in `demo.js`. Published from the public repo `Munsterberg/slack-export-site` (GitHub Pages, branch `main`, root), which contains only this folder. This repo stays private.

Publish changes:

```sh
git subtree push --prefix site site main
```

(`site` is the git remote for `git@github.com:Munsterberg/slack-export-site.git`.)

Preview locally:

```sh
python3 -m http.server -d site 8000
```

## Placeholders to fill before launch

- **Chrome Web Store URL:** every link marked `data-cws-link` (currently `href="#install"`) in `index.html` and `privacy.html`.
- **Screenshots:** the five `.shot-frame.is-placeholder` slots in `index.html`. Drop 1280x800 PNGs into `assets/screenshots/` and swap each placeholder for an `<img>` (the comment above the grid has the markup).
- **Contact email:** `CONTACT_EMAIL` in `privacy.html`.

## Commitments the privacy policy makes

Keep the extension in line with these, or update `privacy.html`:

- Analytics events are exactly the list in the policy, with no names, IDs, or domains, and they respect the opt-out toggle.
- PostHog is configured to discard IP addresses (project setting "Discard client IP data").
- The Slack token lives only in `chrome.storage.session`.
- Any new kind of off-device data requires in-extension consent first.
