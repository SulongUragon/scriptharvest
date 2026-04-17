require('dotenv').config({ path: '.env.local' }); // local dev only; Railway uses env vars directly
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const fs      = require('fs');
const { exec } = require('child_process');
const { promisify } = require('util');
const Anthropic = require('@anthropic-ai/sdk');
const Groq = require('groq-sdk');
const db = require('./db');

const app    = express();
const execAsync = promisify(exec);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const MODEL  = 'claude-sonnet-4-5-20250929';
const PORT   = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── helpers ────────────────────────────────────────────────────────────────

function detectPlatform(url) {
  if (url.includes('tiktok.com'))                          return 'tiktok';
  if (url.includes('instagram.com'))                       return 'instagram';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'youtube';
  return 'unknown';
}

function parseSRT(srt) {
  return srt
    .replace(/\d+\n\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}\n/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/\{[^}]+\}/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .reduce((acc, line) => {
      if (!acc.length || acc[acc.length - 1] !== line) acc.push(line);
      return acc;
    }, [])
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function extractTranscript(url) {
  const platform = detectPlatform(url);

  // Get title
  let title = 'Untitled';
  try {
    const { stdout } = await execAsync(
      `yt-dlp --skip-download --print title "${url}" 2>/dev/null`,
      { timeout: 30000 }
    );
    title = stdout.trim() || 'Untitled';
  } catch (_) {}

  // Download subtitles to /tmp
  const tmpBase = `/tmp/sh_${Date.now()}`;
  try {
    await execAsync(
      `yt-dlp --skip-download --write-auto-sub --write-sub \
       --sub-lang "en,en-US,en-GB" --sub-format srt \
       -o "${tmpBase}" "${url}" 2>&1`,
      { timeout: 90000 }
    );
  } catch (e) {
    // yt-dlp exits non-zero when no subs found — that's ok, we'll check below
  }

  // Read whichever .srt file got created
  let transcript = '';
  try {
    const { stdout: ls } = await execAsync(`ls ${tmpBase}*.srt 2>/dev/null || true`);
    const files = ls.trim().split('\n').filter(Boolean);
    for (const f of files) {
      const { stdout: content } = await execAsync(`cat "${f}"`);
      transcript += content;
      execAsync(`rm -f "${f}"`).catch(() => {});
    }
  } catch (_) {}

  if (transcript.trim()) {
    return { title, transcript: parseSRT(transcript), platform };
  }

  // Fallback: download audio and transcribe via Groq Whisper
  if (process.env.GROQ_API_KEY) {
    const audioFile = `/tmp/sh_audio_${Date.now()}.mp3`;
    try {
      await execAsync(
        `yt-dlp -x --audio-format mp3 --audio-quality 0 -o "${audioFile}" "${url}" 2>&1`,
        { timeout: 120000 }
      );
      if (fs.existsSync(audioFile)) {
        const transcription = await groq.audio.transcriptions.create({
          file: fs.createReadStream(audioFile),
          model: 'whisper-large-v3-turbo',
          response_format: 'text',
        });
        fs.unlinkSync(audioFile);
        if (transcription && transcription.trim()) {
          return { title, transcript: transcription.trim(), platform };
        }
      }
    } catch (e) {
      console.error('Whisper fallback failed:', e.message);
      try { fs.unlinkSync(audioFile); } catch (_) {}
    }
  }

  return {
    title,
    transcript: '[No transcript or captions available for this video.]',
    platform,
  };
}

async function claude(system, user) {
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 1024,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return msg.content[0].text;
}

// ─── transcript routes ───────────────────────────────────────────────────────

// GET all saved transcripts
app.get('/api/transcripts', (req, res) => {
  res.json(db.all());
});

// POST single URL
app.post('/api/transcripts', async (req, res) => {
  const { url } = req.body;
  if (!url?.trim()) return res.status(400).json({ error: 'URL required' });

  const cleanUrl = url.trim();
  if (detectPlatform(cleanUrl) === 'unknown') {
    return res.status(400).json({ error: 'Only TikTok, Instagram Reels, and YouTube Shorts are supported.' });
  }

  try {
    const { title, transcript, platform } = await extractTranscript(cleanUrl);
    const row = db.insert({ url: cleanUrl, platform, title, transcript });
    res.json(row);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST bulk (up to 50)
app.post('/api/transcripts/bulk', async (req, res) => {
  const { urls } = req.body;
  if (!Array.isArray(urls) || !urls.length) return res.status(400).json({ error: 'urls array required' });
  if (urls.length > 50) return res.status(400).json({ error: 'Max 50 URLs' });

  const results = [];
  for (const raw of urls) {
    const url = (raw || '').trim();
    if (detectPlatform(url) === 'unknown') { results.push({ url, error: 'Unsupported URL' }); continue; }
    try {
      const { title, transcript, platform } = await extractTranscript(url);
      const row = db.insert({ url, platform, title, transcript });
      results.push(row);
    } catch (err) {
      results.push({ url, error: err.message });
    }
  }
  res.json(results);
});

// DELETE one
app.delete('/api/transcripts/:id', (req, res) => {
  db.delete(req.params.id);
  res.json({ ok: true });
});

// ─── AI routes ───────────────────────────────────────────────────────────────

app.post('/api/ai/hook', async (req, res) => {
  const { transcript, platform } = req.body;
  if (!transcript) return res.status(400).json({ error: 'transcript required' });
  try {
    const result = await claude(
      `You are a viral short-form video expert. Generate irresistible hooks for ${platform || 'TikTok/Reels/Shorts'}.`,
      `Based on this transcript, write 5 viral hook options (under 15 words each).
Include: bold claim, question, shocking stat, personal story opener, contrarian take.
Add a one-line explanation for each hook.

Transcript:
"""
${transcript.slice(0, 3000)}
"""`
    );
    res.json({ result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ai/rewrite', async (req, res) => {
  const { transcript, style, platform } = req.body;
  if (!transcript) return res.status(400).json({ error: 'transcript required' });
  const styles = {
    viral: 'extremely viral with pattern interrupts every 10 seconds',
    educational: 'clear and educational with memorable takeaways',
    storytelling: 'narrative-driven with a strong emotional arc',
    funny: 'humorous with comedic timing',
    motivational: 'inspiring and energetic with a strong CTA',
  };
  try {
    const result = await claude(
      `You are a short-form video scriptwriter optimizing for ${platform || 'TikTok/Reels/Shorts'}.`,
      `Rewrite this transcript to be ${styles[style] || styles.viral}.
Rules: under 60 seconds spoken (~150 words), powerful hook, short sentences, add [PAUSE]/[CUT]/[B-ROLL] cues, end with CTA.

Original:
"""
${transcript.slice(0, 3000)}
"""`
    );
    res.json({ result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ai/analyze', async (req, res) => {
  const { transcript, platform } = req.body;
  if (!transcript) return res.status(400).json({ error: 'transcript required' });
  try {
    const result = await claude(
      `You are a data-driven social media analyst who has studied millions of viral videos.`,
      `Analyze virality potential for ${platform || 'short-form video'}.

Provide:
## Virality Score: X/10
## Strengths (3-5 bullets)
## Weaknesses (3-5 bullets)
## Key Metrics (hook, retention, shareability, emotion — each /10)
## Top 3 Improvements
## Best Platform & Posting Strategy

Transcript:
"""
${transcript.slice(0, 3000)}
"""`
    );
    res.json({ result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/ai/translate', async (req, res) => {
  const { transcript, targetLanguage } = req.body;
  if (!transcript || !targetLanguage) return res.status(400).json({ error: 'transcript and targetLanguage required' });
  try {
    const result = await claude(
      `You are a professional translator specializing in social media scripts. Preserve tone, humor, and natural flow.`,
      `Translate to ${targetLanguage}. Adapt idioms culturally. Output only the translation.

"""
${transcript.slice(0, 4000)}
"""`
    );
    res.json({ result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── fallback ────────────────────────────────────────────────────────────────

app.get('*', (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

app.listen(PORT, () => {
  console.log(`\n🎬 ScriptHarvest running → http://localhost:${PORT}`);
  console.log(`   Claude API: ${process.env.ANTHROPIC_API_KEY ? '✓ ready' : '✗ MISSING — add ANTHROPIC_API_KEY to .env'}\n`);
});
