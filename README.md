# Webtakt

A browser-based step sequencer and synthesizer — vanilla JavaScript, no build
step. Open `index.html` over a local HTTP server (e.g. `python3 -m http.server`)
and play.

See [DESIGN.md](DESIGN.md) for the architecture overview.

To curate the built-in sample list, run `python3 tools/curate_server.py` instead
of the plain static server — it serves the app and lets the sample browser's
★ ADD / ✕ buttons edit `samples/curated.json` directly (then commit). See
[design/sample-browser.md](design/sample-browser.md).

## License

Webtakt is licensed under the
[Creative Commons Attribution-NonCommercial 4.0 International License](https://creativecommons.org/licenses/by-nc/4.0/)
(CC BY-NC 4.0).

You're free to share and adapt it, with attribution, for non-commercial
purposes. See [LICENSE](LICENSE) for the full terms.

© 2026 Andre Johansson

[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc/4.0/)
