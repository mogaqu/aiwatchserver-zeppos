// AI Ask server для Render.com (бесплатный тариф) — тот же протокол, что и у
// Cloudflare-воркера: POST /ask, POST /voice + GET /ping для «прогрева».
//
// Ноль зависимостей: чистый Node >= 18. Запуск: node index.js
// Переменные окружения (Render → Environment):
//   TOKEN        — строка-пароль (должна совпадать с app-side/index.js на часах)
//   GEMINI_KEY   — ключ Gemini (aistudio.google.com/apikey)
//   GEMINI_MODEL — опционально (по умолчанию gemini-3.5-flash-lite)
//   AUDIO_MIME   — опционально (по умолчанию audio/ogg)
//   MOCK_GEMINI  — '1' только для локальных тестов (без реального API)

import http from 'node:http'

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/'

const SYSTEM_PROMPT =
  'Ты — быстрый ассистент для коротких ответов на вопросы по школьным предметам. ' +
  'Отвечай предельно кратко и по делу: только суть, факты, определения, формулы, списки. ' +
  'Максимум 700 символов. Без приветствий, без вступлений, без рассуждений. На русском.'

const VOICE_INSTR =
  'В аудио — вопрос на русском. Расшифруй его и дай краткий ответ. ' +
  'Верни строго JSON вида {"heard":"расшифровка вопроса","answer":"краткий ответ по существу, до 700 символов"}.'

function json(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

function fail(res, e) {
  json(res, { error: String((e && e.message) || e) }, 502)
}

async function callGemini(env, parts, jsonOut) {
  if (env.MOCK_GEMINI === '1') {
    return jsonOut
      ? '{"heard":"тест услышан","answer":"Ответ сорок два"}'
      : 'Ответ сорок два'
  }
  const generationConfig = { temperature: 0.2, maxOutputTokens: 800 }
  if (jsonOut) generationConfig.responseMimeType = 'application/json'
  if (env.THINKING_LEVEL) generationConfig.thinkingConfig = { thinkingLevel: env.THINKING_LEVEL }

  const r = await fetch(API_BASE + (env.GEMINI_MODEL || 'gemini-3.5-flash-lite') + ':generateContent', {
    method: 'POST',
    headers: { 'x-goog-api-key': env.GEMINI_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents: [{ role: 'user', parts }],
      generationConfig,
    }),
  })
  if (!r.ok) throw new Error('Gemini ' + r.status + ': ' + (await r.text()).slice(0, 200))
  const d = await r.json()
  const cand = d.candidates && d.candidates[0]
  const out = cand && cand.content && cand.content.parts ? cand.content.parts : []
  const text = out.map((p) => p.text || '').join('').trim()
  if (!text) throw new Error('Gemini: пустой ответ (blocked? ' + JSON.stringify(d.promptFeedback || {}).slice(0, 120) + ')')
  return text
}

async function askText(env, q) {
  if (!q) throw new Error('пустой вопрос')
  return { answer: await callGemini(env, [{ text: q }], false) }
}

async function askVoice(env, b64) {
  if (!b64) throw new Error('пустое аудио')
  let bytes
  try {
    bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  } catch (e) {
    throw new Error('битный base64')
  }
  if (bytes.length < 100) throw new Error('аудио слишком короткое')

  const raw = await callGemini(
    env,
    [
      { inline_data: { mime_type: env.AUDIO_MIME || 'audio/ogg', data: b64 } },
      { text: VOICE_INSTR },
    ],
    true,
  )
  let heard = ''
  let answer = raw
  try {
    const d = JSON.parse(raw)
    heard = String(d.heard || '').trim()
    answer = String(d.answer || '').trim()
  } catch (e) {
    // модель ответила без JSON — считаем весь текст ответом
  }
  if (!answer) throw new Error('речь не распознана или пустой ответ')
  return { heard: heard.slice(0, 200), answer }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 12 * 1024 * 1024) reject(new Error('too large'))
    })
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {})
      } catch (e) {
        resolve(null)
      }
    })
    req.on('error', reject)
  })
}

export async function handle(req, res, env) {
  const url = (req.url || '').split('?')[0]
  if (req.method === 'GET' && (url === '/ping' || url === '/')) {
    // «прогрев»: пингер дёргает этот адрес, чтобы бесплатный инстанс не засыпал
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end('ok')
    return
  }
  if (req.method !== 'POST') return json(res, { error: 'POST only' }, 405)

  const body = await readBody(req)
  if (!body) return json(res, { error: 'bad json' }, 400)
  if (!env.TOKEN || body.token !== env.TOKEN) return json(res, { error: 'bad token' }, 401)

  try {
    if (url === '/ask') return json(res, await askText(env, String(body.q || '').slice(0, 500)))
    if (url === '/voice') return json(res, await askVoice(env, String(body.audio_b64 || '')))
    return json(res, { error: 'no route' }, 404)
  } catch (e) {
    return fail(res, e)
  }
}

// локальный запуск: node index.js (на Render — через `npm start`)
if (process.env.AIWATCH_NO_LISTEN !== '1') {
  const port = process.env.PORT || 3000
  http.createServer((req, res) => handle(req, res, process.env)).listen(port, () => {
    console.log('aiwatch server on :' + port)
  })
}
