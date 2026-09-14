# Writing and publication

The repository is both an editable Markdown collection and the publisher of its
narration assets. The portfolio is an optional consumer, not a prerequisite.

## Note structure

Create a directory with a stable lowercase, hyphenated ID:

```text
content/notes/a-new-thought/
  note.md
  note.pt.md
  note.ja.md
```

Every file must contain exactly these front-matter fields:

```yaml
---
id: a-new-thought
status: draft
date: '2026-09-10'
title: 'A new thought'
summary: 'A short introduction to the note.'
locale: en
publishedAt: null
---
The Markdown body goes here.
```

Use `locale: pt` and `locale: ja` in the corresponding translations. The directory
name and every `id` must match. All three files are required, even for drafts.
`id`, `status`, `date`, and `publishedAt` must agree across languages. Dates are
calendar dates; use quoted ISO timestamps with a timezone for `publishedAt`.

Keep titles in front matter rather than repeating them as a level-one body
heading. The narration reads the body, not the front-matter title or summary.
Use Markdown headings, emphasis, lists, and links normally. Link labels are read;
link destinations are not. Code is read literally and image alt text is narrated.
Raw HTML is rejected. The text and its translations should be reviewed before
preparing narration.

`draft` requires `publishedAt: null`. To publish, set all three files to
`status: published` and the same non-null `publishedAt`, for example
`"2026-09-10T12:00:00.000Z"`. A future timestamp is not a publication schedule:
status determines eligibility, and published notes are processed immediately.

## Prepare and listen locally

After following the [local setup](../README.md#local-setup), set
`ELEVENLABS_API_KEY` and the three voice variables `ELEVENLABS_VOICE_ID_EN`,
`ELEVENLABS_VOICE_ID_PT`, and `ELEVENLABS_VOICE_ID_JA` in `.env`. Choose a female
native voice for each language and copy each Voice ID. There is no shared default.
Do not commit `.env`. No ffmpeg installation is needed.

For a local preview, change the selected note's three files to published in your
working tree, then run:

```sh
npm run notes:validate
npm run notes:generate -- --note between-starting-and-shipping --no-upload
```

Replace `between-starting-and-shipping` with the note's ID. This command makes one paid ElevenLabs request per missing note/language. It neither uploads media nor changes the public manifest.
Completed files appear at:

```text
.notes/generated/<id>/<locale>/<generation-hash>/audio.mp3
.notes/generated/<id>/<locale>/<generation-hash>/alignment.json
```

Listen to every language. Audio and character timestamps come from the same ElevenLabs response; validation rejects mismatched text and invalid times,
but listening is still necessary to assess pronunciation and pacing. The
consumer should clearly identify the voice as AI-generated.

When working on the local portfolio, rerun `npm run notes:sync -- --mode=development`
from the portfolio repository after generation. It detects the ignored files
under `.notes/generated/` and serves their audio and alignment through the
development-only `/api/notes-assets/` route. No upload or public manifest
change is involved.

To publish the exact local results you reviewed, configure the public store's
`BLOB_READ_WRITE_TOKEN`, then run:

```sh
npm run notes:generate -- --upload
```

The full run reuses completed local results, uploads required assets, and updates
`.notes/manifest.json` only after all eligible notes succeed. Review and commit
the Markdown and manifest together when ready. This document describes the
publication procedure; the commands do not perform Git commits for you.

If you instead push only the published Markdown, CI generates its own audio.
Ignored local previews are not automatically transferred to GitHub Actions, so
that path does not guarantee the same recording you reviewed locally.

## GitHub Actions setup

Use `main` as the publication branch. The audio workflow is disabled until the
repository variable `NOTES_PUBLICATION_ENABLED` is set to `true`. Leave it unset
when publishing only the GitHub repository. Enabling it authorizes the workflow
to make paid generation and storage requests with the configured services.
Once enabled, the audio workflow runs for relevant pushes
to `main` and can be started manually on `main`; it does not publish from other
branches. A manual run is useful after changing repository variables, since
variable changes do not create a Git push event.

Configure these settings in the **notes** repository under Settings → Secrets
and variables → Actions. The portfolio runtime does not need the ElevenLabs key.

| Kind      | Name                                   | Purpose                                                                 |
| --------- | -------------------------------------- | ----------------------------------------------------------------------- |
| Variable  | `NOTES_PUBLICATION_ENABLED`            | Set to `true` only when ready to enable paid publication.               |
| Secret    | `ELEVENLABS_API_KEY`                   | ElevenLabs API key with Text to Speech access and available credits.    |
| Secret    | `BLOB_READ_WRITE_TOKEN`                | Read/write access to the public Vercel Blob store.                      |
| Variable  | `ELEVENLABS_MODEL_ID`                  | Optional; defaults to `eleven_multilingual_v2`.                         |
| Variable  | `ELEVENLABS_SPEED`                     | Optional; defaults to `0.95`, allowed range `0.7`–`1.2`.                |
| Variables | `ELEVENLABS_VOICE_ID_EN`, `_PT`, `_JA` | Required native voices for English, Brazilian Portuguese, and Japanese. |
| Variable  | `NOTES_BLOB_PREFIX`                    | Optional asset prefix, default `notes`.                                 |
| Secret    | `PORTFOLIO_DISPATCH_TOKEN`             | Optional existing portfolio notification token.                         |
| Variable  | `PORTFOLIO_REPOSITORY`                 | Optional notification target, paired with that token.                   |

The implementation calls the current documented
[`POST /v1/text-to-speech/{voice_id}/with-timestamps`](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)
endpoint with `mp3_44100_128`. The `/v1/` path is the current version of this
endpoint; it is independent of the model's version. No deprecated latency
parameters or extra transcription/LLM calls are used. No new SDK is required.

### Model and delivery

`eleven_multilingual_v2` is the default for consistent, natural long-form reading
in English, Brazilian Portuguese and Japanese. It accepts up to 10,000
characters per request. `eleven_flash_v2_5` is a cheaper alternative with a
40,000-character limit; `eleven_turbo_v2_5` supports the same limit. Flash can be
less suitable when number/date normalization matters. Eleven v3 is newer and
more expressive; it is not part of this deliberately small narration configuration.
See the official [models guide](https://elevenlabs.io/docs/overview/models).

The initial voice settings are speed `0.95`, stability `0.5`, similarity boost
`0.75`, style `0`, and speaker boost enabled. These are a starting point, not a
listening-verified voice. Select a female voice with a natural conversational
or narrative sample. A native voice must be configured explicitly for each language. Voice identity is independent of the model ID.

Keep original capitalization and paragraph breaks. Delivery comes from the voice,
settings and punctuation. Do not insert prose instructions into the narration:
these models would read them aloud. The portfolio applies lowercase using CSS.

The workflow declares `contents: write` so its GitHub token can commit the
manifest. Repository and organization rules must permit that write; if branch
protection rejects the bot, publication stops at push. Configure an allowed
publication path under your repository policy rather than force-pushing.

Runs are serialized. Each run checks out the latest `main`, validates content,
generates or recovers assets, commits a changed manifest, and pushes normally.
It does not rebase generated output onto different source text. If `main`
advances while the job is running, push fails; start or rerun the workflow so
it reconciles against the new source revision. There is no force push.

Manifest-only commits are excluded from the push path filters, preventing a
generation loop. An unchanged manifest does not create another commit.

## Optional portfolio notification

Configure both `PORTFOLIO_DISPATCH_TOKEN` (secret) and `PORTFOLIO_REPOSITORY`
(variable, for example `cekrauseee/portfolio`), or leave both absent. A fine-grained
GitHub token needs access to the target repository with `Contents: write` for
repository dispatch. Keep the token separate from the Blob token.

After a successful push, the workflow sends `notes-published` with
`client_payload.notes_commit` containing the pushed HEAD's 40-character lowercase
SHA. The consumer's workflow must already exist on its default branch. The
current portfolio validates this event and invokes its existing delivery path;
its build resolves the configured `NOTES_REF` to a commit. The notification SHA
is not currently forwarded as a Vercel build override.

In the portfolio build environment, configure:

```dotenv
NOTES_REPOSITORY=cekrauseee/notes
NOTES_REF=main
```

The portfolio does not need a Blob write token to read public assets. Its existing
deploy-hook and database configuration still applies. With notification disabled,
this repository remains usable and consumers can synchronize independently.

To retry only a failed notification, from a checkout of the already-pushed
revision with the integration configured:

```sh
NOTES_COMMIT="$(git rev-parse HEAD)" npm run notes:dispatch
```

This makes a GitHub request but does not generate or upload audio.

## Reuse, failure, and withdrawal

Generation identity includes the spoken text, language, model, voice and voice
settings. Metadata-only edits reuse the audio. Changing delivery settings creates
a new generation. Old OpenAI output is left on disk but is not reused as ElevenLabs
output. Existing published legacy artifacts remain readable by the portfolio.

Each note/language uses one request, without chunking or ffmpeg. Text over the
model limit fails before that request; shorten it or choose a supported model
with a larger limit. A successful response is saved as `response.json` alongside
`audio.mp3` and `alignment.json`. This single recovery file avoids repeating a
paid call if local writing or publication fails. Invalid responses are removed;
failures stop immediately without an automatic retry. Run the command again to
resume missing generations. Completed languages are retained.

The workflow saves/restores generated files through GitHub Actions cache, even
when a later language or upload fails. Cache eviction or a lost API response may
still require regeneration. A partial remote upload with no local recovery files
stops with an error: it must not mix a new recording with older timestamps.
The public manifest advances only after every selected note succeeds.

`alignment` supplies original-text character timestamps. The mapper groups them
into source words using the first and last character times. It does not infer
word durations or use `normalized_alignment`, which may contain expanded numbers.
Artifact `durationMs` is the timestamp extent; the browser uses the actual MP3
metadata for playback duration. Pronunciation, pauses and timing still need a
listening check once credentials are available.

If dispatch fails after publication, rerun the notification independently.

To withdraw a note, set all translations back to draft with `publishedAt: null`,
or remove its source directory, then run full publication. The full run removes
that entry from the catalog; a scoped `--note` run preserves unrelated entries.
Withdrawal does not delete old Git history or Blob files, and existing deployed
consumers retain their previous snapshot until they rebuild.
