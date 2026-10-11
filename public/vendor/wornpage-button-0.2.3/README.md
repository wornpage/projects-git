# Wornpage button 0.2.3

This folder vendors the published MIT browser bundle from
[components-2026.09.26](https://github.com/wornpage/components/releases/tag/components-2026.09.26).
`provenance.json` records the exact source commit, archive URL, verified archive
SHA-512, and the SHA-256 digests of the served JavaScript and CSS.

`worn-button.js` is byte-for-byte `package/dist/worn-button.js` from the release
archive. It includes Svelte 5.56.8; both MIT notices are retained alongside it.
The consuming app requires no Svelte compiler, package install, CDN or build step.

## Styles and security

`worn-button.css` is the bundle's compiled `code` stylesheet string, decoded and
written with one trailing newline. No CSS rules or generated JavaScript were
rewritten. `index.html` links that file with the matching `svelte-1a7eo45` ID.
The bundle's CSS loader checks for that ID before inserting styles, so the app
can retain its existing `style-src 'self'` policy without inline style permission.
App-specific colors, typography and phone touch-target sizing live in `styles.css`.

## Updating

1. Select a published Components browser-bundle release and its manifest.
2. Verify the downloaded archive against the manifest's integrity before extraction.
3. Copy its published JavaScript unchanged and retain all bundled license notices.
4. Extract its compiled stylesheet, update the stylesheet ID in `index.html`, and
   record the new version, source identity and asset hashes in `provenance.json`.
5. Run `node --test tests/browser-assets.test.mjs` and browser QA under the real
   CSP: phone and desktop layouts, click/keyboard navigation, export, and console errors.

Do not rebuild or republish Components as part of an app update. A changed loader
or component API requires reviewing the integration before adopting the release.
