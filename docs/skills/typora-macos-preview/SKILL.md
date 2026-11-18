---
name: typora-macos-preview
description: "Verify this plugin in the macOS Typora editor with real window screenshots and a synthetic translation cache, without calling a translation service."
---

# Verify the macOS Preview

For installation and behavior criteria, start with [VERIFICATION.md](../../../VERIFICATION.md). Run `npm run check` from the repository root before installing. Hold the host's `gui-desktop` lock during app actions and screenshots. Quit Typora normally before running `bash ./scripts/install-plugin-macos.sh`; after reopening, compare the timestamp of `initial refresh complete` with the pre-install marker.

To test stale previews, create a unique temporary directory under `/private/tmp`. From the repository root, run:

```sh
node docs/skills/typora-macos-preview/scripts/seed-stale-cache.cjs \
  "$fixture_dir/alignment-fixture.md" "$translation_cache_root"
```

Use the installed plugin's `settings/data/eleef.typora-side-by-side-translator/translations` directory as the second argument. The script prints the new per-document cache directory. It calls the real cache writer with an in-process fake provider that returns fixed Simplified Chinese text. Use the matching target language in Typora; do not click Translate. Confirm that the inserted English paragraph appears as English on both sides, while its neighbors show the intended translations. The status should count one untranslated block, not the number of cache entries affected by position changes. Compare the cache pair's checksums before and after opening or resizing. Close the fixture and remove only the fixture and its unique cache pair.

For toolbar-only checks, pass `--body-only` to omit the editable YAML header. Confirm that the fixture is the foreground window immediately before sending pointer events. Use coordinates from the window bounds and scale screenshot pixels to screen points; do not use OCR to identify the center of a compact button. Compare the same body heading before and after hovering, and verify that the cache checksums are unchanged without clicking a translation action.

For a window screenshot, verify the active document title and enumerate on-screen Typora windows with CoreGraphics. Select the editor-sized window, not the small community settings window. Capture its current ID with `screencapture -x -o -l`. Check YAML, headings, paragraphs, the first list item, and the table's top edge; list items and table rows are not separate alignment anchors. Prefer a real screenshot over layout assertions in jsdom.
