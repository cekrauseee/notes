# Content and audio contract

The versioned catalog is [`.notes/manifest.json`](../.notes/manifest.json).
[`src/types.ts`](../src/types.ts) defines the fields and
[`src/manifest.ts`](../src/manifest.ts) validates them. Consumers should validate
input instead of assuming that a successful HTTP response contains usable data.

## Published catalog

The root contains `schemaVersion: 1`, `generatedAt`, and `notes`. Each entry has
`id`, `slug`, `status: published`, `date`, `publishedAt`, and `locales`. The slug
currently equals the stable ID. Published entries contain all of `en`, `fr`, `es`,
`pt`, and `ja`; drafts are absent.

Each locale records:

| Field                      | Meaning                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------- |
| `title`, `summary`         | Localized editorial metadata.                                                         |
| `markdownPath`             | Repository-relative source file path.                                                 |
| `markdownSha256`           | SHA-256 of the exact UTF-8 Markdown file, including front matter.                     |
| `spokenTextSha256`         | SHA-256 of the canonical narrated body after recognized audio tags are projected out. |
| `generationConfigHash`     | Content-addressed key for narrated text and effective audio settings.                 |
| `audioUrl`, `alignmentUrl` | Public, immutable asset URLs.                                                         |
| `durationMs`               | Duration of the assembled source audio in milliseconds.                               |

`generatedAt` is a catalog generation timestamp, not a note publication date.
Consumers should sort explicitly for their interface rather than relying on the
catalog's ascending date/ID order.

Fetch the manifest and its Markdown files from one resolved Git commit, verify
the exact Markdown hashes, and validate paths and asset URLs before producing a
consumer snapshot. A metadata-only edit can change `markdownSha256` while keeping
the same audio key and URLs. Do not require an audio regeneration for that case.

## Narrated text and timing

[`src/markdown.ts`](../src/markdown.ts) projects the Markdown AST into canonical
spoken text. Front matter is excluded. Visible text from headings, emphasis,
links, code, and image alternatives is retained; raw HTML is rejected. The
recognized ElevenLabs v3 audio tags remain in the single Markdown source sent to
the provider, but are projected out of `spokenText` and the rendered Markdown.
This is a transient projection: the repository does not maintain a second clean
article or narration source. A consumer that highlights Markdown must use the
same tag allowlist, projection, and whitespace rules.

Each ElevenLabs text-to-speech block request returns MP3 and original-text
character timestamps. The producer groups characters into `Intl.Segmenter` word
units, converts seconds to milliseconds, and preserves UTF-16 offsets into the
canonical source. It uses `alignment`, not `normalized_alignment`, so text
normalization such as expanded numbers does not replace the display text. When
the source exceeds the model limit, semantic blocks are assembled from validated
MP3 frames without re-encoding; v3 request stitching is not used. See
[publishing](publishing.md#reuse-failure-and-withdrawal) for recovery behavior.

An alignment artifact includes:

- `schemaVersion: 1` and `offsetConvention: utf-16-code-units`.
- `alignmentMethod: elevenlabs-character-timestamps`.
- `noteId`, `locale`, canonical `spokenText`, and `durationMs`.
- `units`: text with `startChar`, `endChar`, `startMs`, and `endMs`.
- `chunks`: an empty array retained for the consumer contract.
- `durationMs`: the real assembled MP3 frame timeline; playback uses MP3 metadata.

Character ranges are half-open JavaScript UTF-16 offsets into the clean
`spokenText`; times are milliseconds on the assembled audio timeline. They are
not Markdown byte offsets. Characters are grouped into words, including
Japanese without whitespace. When the provider returns timestamps against the
tagged source, the producer maps only spoken characters into these ranges and
discards tag timing; a clean provider alignment is accepted when it matches the
same projection. The mapper retains actual API boundaries. Consumers must not
invent separate timings for tags or for other units.

Validate identity, canonical text, duration bounds, ordering, and complete
significant-text coverage. Punctuation and whitespace gaps are allowed; missing
spoken words are not. Generated timestamps still need a listening check for
quality even when structural validation succeeds.

## Storage and playback

Default asset paths are `notes/<id>/<locale>/<generation-hash>.mp3` and `.json`.
The publisher uses public Blob storage without random suffixes or overwrites.
The catalog carries URLs, not duplicated alignment units or embedded audio.

A consumer can render Markdown from its build snapshot, then fetch alignment and
prepare the audio when the note opens. Actual playback uses the media element's
current time, including after seeking or changing speed. No ElevenLabs request or
Blob write credential belongs in the reader. Keep text available when media is
unavailable and label the narration as AI-generated.

## Upstream references

- [ElevenLabs speech with timestamps](https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps)
- [ElevenLabs models](https://elevenlabs.io/docs/overview/models)
- [Vercel Blob SDK](https://vercel.com/docs/vercel-blob/using-blob-sdk)
- [GitHub workflow events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)

The source files and local tests define this repository's behavior; upstream
service availability, quality, and account permissions require live verification.
