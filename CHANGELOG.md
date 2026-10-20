# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-10-20

First release.

### Added

- **Voice training:** singers and song uploads (resumable), vocal separation and
  clean-up presets (studio, cassette), dataset review, RVC v2 training through Applio
  with live loss charts, ETA, audio samples every 5 epochs, pause/resume, early stop
  and checkpoint picking.
- **Covers:** convert any song into a trained voice, with automatic octave matching,
  a guard that keeps the lead vocal if clean-up would remove it, a stereo mix and
  loudness matched to the original.
- **Analyse tab:** lyrics with timestamps via Whisper large-v3-turbo (Urdu, Persian,
  English; Balochi as an editable draft), tempo, key and scale, instrument share and
  tags, genre and mood (CLAP), and a section timeline; edit and export lyrics as
  .txt or the full result as JSON.
- Live job view over Server-Sent Events, one-GPU-job worker with leases and crash
  recovery, out-of-memory retries sized for 6 GB VRAM.
- System screen with environment checks, model pre-download (`fetch_models`),
  GPU benchmark tool and one-click `start.bat`.
