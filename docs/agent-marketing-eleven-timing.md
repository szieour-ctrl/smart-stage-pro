# ElevenLabs word timings for Agent Marketing captions (PR 1)

**Endpoint (from ElevenLabs' API reference):** `POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/with-timestamps`, JSON body with `text`, `model_id`, optional `voice_settings`. Response: `audio_base64`, `alignment`, `normalized_alignment`. Each alignment holds three equal-length arrays: `characters`, `character_start_times_seconds`, `character_end_times_seconds`. Timings are per character, not per word.

**What the code does:** `agent-marketing-timing-lib.js` groups characters into words (skipping `[audio tags]`), checks the alignment, groups words into caption lines, and finds each scene's start and end from its narration excerpt. It uses `alignment` (the text as sent) so captions show "99.4%", not the spoken expansion.

**Not yet verified (needs a real call, which this build environment cannot make):**
1. That `eleven_v3` returns `alignment` (the reference page does not mention v3 or audio tags).
2. Whether `alignment.characters` includes the `[tags]` or drops them. The code accepts either.
3. Cost per call versus the plain endpoint the listing pipeline uses.

**To run the check:** `ELEVENLABS_API_KEY=... node scripts/eleven-timing-check.js <voiceId> <outDir> [scriptFile]`. It prints `hasAlignment`, `alignmentUsable`, `wordsMatchCaption`, and writes the mp3, the raw response and the words.

**If `eleven_v3` returns no alignment:** the fallback is to make the narration with the plain endpoint as today and align the finished audio to the script (forced alignment). Only `wordsFromAlignment` changes; the caption and scene-window code stays.
