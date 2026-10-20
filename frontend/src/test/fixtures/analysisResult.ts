/**
 * Analysis result recorded from the first real run (2026-10-19, RTX 4050): a 3:13 Balochi
 * song. Whisper has no Balochi; auto mode chose Persian (Arabic script) by decoder score.
 */
import type { AnalysisResult } from '@/api/schemas';

export const REAL_RESULT: AnalysisResult = {
  "duration_s": 193.02,
  "lyrics": {
    "language": "fa",
    "language_probability": 0.832,
    "approximate": false,
    "device": "cuda",
    "fallback": null,
    "note": null,
    "segments": [
      {
        "start": 0.1,
        "end": 7.04,
        "text": "آشی ملگورا تیجو تابو کنه"
      },
      {
        "start": 14.4,
        "end": 24.4,
        "text": "کاشی ملگو را پیچو تا بکانے"
      },
      {
        "start": 24.7,
        "end": 34.4,
        "text": "دست وات تو منا عذاب کانے"
      },
      {
        "start": 34.6,
        "end": 38.1,
        "text": "کاشی ملگو را پیچو تا"
      },
      {
        "start": 56.2,
        "end": 76.2,
        "text": "راند من اچکایا هجاب کنے"
      },
      {
        "start": 76.2,
        "end": 81.4,
        "text": "کاش ملگورا پیچوتا بکن"
      },
      {
        "start": 81.4,
        "end": 87.34,
        "text": "کانش ملگو را پیچو تا بکنے"
      },
      {
        "start": 109.0,
        "end": 112.9,
        "text": "دوتی این پیم چون ای ملا"
      },
      {
        "start": 112.9,
        "end": 124.58,
        "text": "نشتا گئی تصویر ایساب کنے"
      },
      {
        "start": 124.58,
        "end": 134.4,
        "text": "کاش ملگوران تیچتا بکنے"
      },
      {
        "start": 134.4,
        "end": 140.02,
        "text": "کاشی ملگو رانتی چوتا بکنی"
      },
      {
        "start": 161.6,
        "end": 171.08,
        "text": "روچ نوکی تو شتتی سازے"
      },
      {
        "start": 171.08,
        "end": 177.06,
        "text": "دلچیا تاہیرہ عذاب کنے"
      },
      {
        "start": 177.06,
        "end": 186.72,
        "text": "کانش ملگو راں تیچو تاہب کنے"
      },
      {
        "start": 186.72,
        "end": 190.98,
        "text": "کاشی ملگو را تیچو تا"
      }
    ]
  },
  "style": {
    "tempo_bpm": 107.7,
    "tempo_confidence": 0.87,
    "key": "A#",
    "scale": "major",
    "key_confidence": 0.6,
    "loudness_dbfs": -16.6,
    "loudness_lufs": -10.8,
    "instruments": {
      "stems": {
        "vocals": 49.0,
        "drums": 5.8,
        "bass": 0.0,
        "other": 45.2
      },
      "tags": [
        {
          "label": "dhol",
          "score": 0.28
        },
        {
          "label": "rubab",
          "score": 0.175
        },
        {
          "label": "benju (banjo)",
          "score": 0.152
        }
      ]
    },
    "genre": [
      {
        "label": "pop",
        "score": 0.266
      },
      {
        "label": "Pakistani folk",
        "score": 0.266
      },
      {
        "label": "wedding song",
        "score": 0.212
      }
    ],
    "mood": [
      {
        "label": "happy",
        "score": 0.326
      },
      {
        "label": "devotional",
        "score": 0.227
      },
      {
        "label": "sad",
        "score": 0.103
      }
    ]
  },
  "sections": [
    {
      "start": 0.0,
      "end": 39.36,
      "label": "verse",
      "has_vocals": true,
      "vocal_share": 0.85
    },
    {
      "start": 39.36,
      "end": 55.15,
      "label": "instrumental",
      "has_vocals": false,
      "vocal_share": 0.0
    },
    {
      "start": 55.15,
      "end": 87.54,
      "label": "chorus",
      "has_vocals": true,
      "vocal_share": 0.85
    },
    {
      "start": 87.54,
      "end": 108.72,
      "label": "instrumental",
      "has_vocals": false,
      "vocal_share": 0.0
    },
    {
      "start": 108.72,
      "end": 140.36,
      "label": "verse",
      "has_vocals": true,
      "vocal_share": 0.85
    },
    {
      "start": 140.36,
      "end": 161.45,
      "label": "instrumental",
      "has_vocals": false,
      "vocal_share": 0.0
    },
    {
      "start": 161.45,
      "end": 193.02,
      "label": "chorus",
      "has_vocals": true,
      "vocal_share": 0.83
    }
  ]
};
