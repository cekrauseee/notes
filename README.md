# notes

A place for thoughts, questions, and things I am still figuring out, written in
English, Brazilian Portuguese, and Japanese. The Markdown lives here independently
of the portfolio that presents it.

Each note has one Markdown source per language. Eleven v3 audio tags remain in
that source for generation; the portfolio parses recognized tags at render time
so they are not visible or highlighted as spoken text.

Published notes include an AI narration and timed text for synchronized reading.
Audio is prepared during publication and stored in Vercel Blob; opening a note
never generates new audio.

The current collection contains one note, marked for publication:

- **The gap between starting and shipping** — [English](content/notes/between-starting-and-shipping/note.md),
  [Português](content/notes/between-starting-and-shipping/note.pt.md),
  [日本語](content/notes/between-starting-and-shipping/note.ja.md)

Draft status controls inclusion in the published manifest. It does not make a
committed Markdown file private in a public repository.

## Local setup

Use the Node.js version in [`.nvmrc`](.nvmrc) (22.23.2) and npm 10.9.8.
ElevenLabs supplies MP3 and timestamps together. No ffmpeg or separate
transcription service is needed.

```sh
npm ci
cp .env.example .env
npm run check
```

Run the copy command only on first setup; keep an existing `.env` intact.
The `notes:*` commands load `.env` from the repository root. Exported environment
variables take precedence. An absent `.env` is allowed, so CI can use secrets
injected by GitHub Actions. Credentials are not needed for `npm run check`.

[`.env.example`](.env.example) lists the settings. An ElevenLabs API key and a separate Voice ID for each language are needed
for new narration; a Blob token is needed for upload and remote
asset recovery. The optional portfolio notification is disabled by default.

GitHub audio publication starts disabled. Configure the service credentials and
set the Actions variable `NOTES_PUBLICATION_ENABLED=true` only when ready for
paid narration and upload. The committed empty manifest lets consumers sync the
repository before any audio is published.

## Write and publish

Each folder under `content/notes/` contains `note.md`, `note.pt.md`, and
`note.ja.md`. These are the localized source files for one note, sharing an ID
and publication metadata.

- [Writing, local audio review, and publication](docs/publishing.md)
- [Manifest, alignment, and consumer contract](docs/content-contract.md)

Useful commands, run from the repository root:

| Command                                                                      | Purpose                                                                                    |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `npm run notes:validate`                                                     | Validate all Markdown and translations without contacting services.                        |
| `npm run check`                                                              | Run TypeScript, mocked tests, and content validation.                                      |
| `npm run notes:generate -- --note between-starting-and-shipping --no-upload` | Prepare local audio for this note **after** its three files are marked published.          |
| `npm run notes:generate -- --upload`                                         | Publish assets and reconcile the local public manifest. May incur API and storage charges. |
| `npm run notes:dispatch`                                                     | Trigger the configured Portfolio Vercel deploy hook; does not generate audio.              |

Generation processes only published notes. Eleven v3 is the default model, uses
the audio tags in the source, and accepts up to 5,000 normalized characters per
block. Longer notes are split at semantic boundaries, assembled from validated
MP3 frames, and aligned on the real assembled timeline. Uploading locally does
not commit or push files.

## Repository contents

- `content/notes/`: editorial Markdown, including drafts.
- `.notes/manifest.json`: versioned public catalog; empty until a note is published.
- `src/`: validation, narration, alignment, publication, and notification tools.
- `tests/`: offline regression tests with synthetic data created in temporary directories.
- `.portfolio/`: translated project description for the portfolio integration.
- `.github/workflows/`: publication automation.

Tests and the lockfile belong in version control. Dependencies, `.env`, generated
media, temporary working files, and logs are ignored by Git. Generated local
media is kept under `.notes/generated/` for listening and recovery; it is
not source content and is not committed. The portfolio's development sync reads
these files and serves them locally after `npm run notes:sync -- --mode=development`.

## Verification before the first public run

Local checks use mocked providers. They do not establish real voice quality,
word alignment quality, Blob permissions, or GitHub workflow permissions.
Before the first public release, generate and listen to one note in all three
languages, verify the uploaded assets, and check synchronized playback in the
consumer. No live service validation is implied by a passing test suite.
