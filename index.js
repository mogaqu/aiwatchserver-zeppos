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
  'Максимум 700 символов. Без приветствий, без вступлений, без рассуждений. На русском. ' +
  'Никакого LaTeX и TeX-разметки: не используй знаки доллара, \frac, \Delta, ^ и _ — '
 +
  'формулы пиши юникодом (Δ, ×, ·, ≈, →, ², ₂, °), например H₂O, E=mc², C₆H₁₂O₆, a/b.'

const VOICE_INSTR =
  'В аудио — вопрос на русском. Расшифруй его и дай краткий ответ. ' +
  'Верни строго JSON вида {"heard":"расшифровка вопроса","answer":"краткий ответ по существу, до 700 символов"}.'

// ---------- ОЧИСТКА ФОРМУЛ (LaTeX -> юникод) ----------
const BB = String.fromCharCode(92) // бэкслеш без экранирования
const TEX_CMD = { Delta: 'Δ', delta: 'δ', alpha: 'α', beta: 'β', gamma: 'γ', Gamma: 'Γ', pi: 'π', Pi: 'Π', mu: 'μ', lambda: 'λ', Lambda: 'Λ', Omega: 'Ω', omega: 'ω', theta: 'θ', phi: 'φ', varphi: 'φ', rho: 'ρ', sigma: 'σ', Sigma: 'Σ', epsilon: 'ε', varepsilon: 'ε', tau: 'τ', eta: 'η', zeta: 'ζ', chi: 'χ', psi: 'ψ', xi: 'ξ', nu: 'ν', kappa: 'κ', times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠', approx: '≈', equiv: '≡', propto: '∝', infty: '∞', degree: '°', circ: '°', sum: 'Σ', partial: '∂', nabla: '∇', rightarrow: '→', to: '→', Rightarrow: '⇒', leftarrow: '←', Leftarrow: '⇐', leftrightarrow: '↔', Leftrightarrow: '⇔', quad: ' ', qquad: '  ' }
const SUP = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '−': '⁻', '(': '⁽', ')': '⁾', 'n': 'ⁿ', 'i': 'ⁱ', 'k': 'ᵏ' }
const SUB = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '−': '₋', '(': '₍', ')': '₎', 'n': 'ₙ', 'i': 'ᵢ', 'x': 'ₓ', 'm': 'ₘ' }

function texMap(t, map) {
  const keys = Object.keys(map).sort((a, b) => b.length - a.length) // длинные ключи раньше
  for (const k of keys) t = t.split(BB + k).join(map[k])
  return t
}

function texSupSub(t, sym, map) {
  // sym{...} -> юникод (если все символы мапятся), иначе sym(...)
  const reGroup = new RegExp(BB + sym + BB + '{([^{}]*)' + BB + '}', 'g')
  t = t.replace(reGroup, (m, g) => {
    const cs = [...String(g)]
    return cs.length && cs.every((c) => map[c] !== undefined) ? cs.map((c) => map[c]).join('') : sym + '(' + g + ')'
  })
  // symX одиночный символ
  const reSingle = new RegExp(BB + sym + '([0-9a-zA-Z+' + BB + '-−])', 'g')
  t = t.replace(reSingle, (m, c) => (map[c] !== undefined ? map[c] : m))
  return t
}

function detex(input) {
  let t = String(input || '')
  const reFrac = new RegExp(BB + BB + '(?:d|D)?frac' + BB + 's*' + BB + '{([^{}]*)' + BB + '}' + BB + 's*' + BB + '{([^{}]*)' + BB + '}', 'g')
  const reSqrt = new RegExp(BB + BB + 'sqrt' + BB + 's*' + BB + '{([^{}]*)' + BB + '}', 'g')
  const reText = new RegExp(BB + BB + '(?:text|mathrm|mathbf|mathit)' + BB + 's*' + BB + '{([^{}]*)' + BB + '}', 'g')
  const reLeftRight = new RegExp(BB + BB + '(?:left|right)', 'g')
  for (let i = 0; i < 4; i++) {
    t = t.replace(reFrac, '($1)/($2)')
    t = t.replace(reSqrt, '√($1)')
    t = t.replace(reText, '$1')
    t = t.replace(reLeftRight, '')
  }
  t = texSupSub(t, '^', SUP)
  t = texSupSub(t, '_', SUB)
  t = texMap(t, TEX_CMD)
  t = t.split('^°').join('°').split('_°').join('°') // 36,6^° -> 36,6°
  t = t.replace(new RegExp(BB + '$', 'g'), '') // знаки доллара
  t = t.replace(new RegExp(BB + BB + '[a-zA-Z]+', 'g'), '') // остатки команд
  t = t.replace(/[{}]/g, '')
  t = t.replace(/ {2,}/g, ' ')
  return t.trim()
}

function json(res, obj, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

function fail(res, e) {
  json(res, { error: String((e && e.message) || e) }, 502)
}

// ---------- GEMINI ----------
// Текст — через GEMINI_MODEL (500/день у lite).
// Голос — через цепочку перебора: модели x mime-форматы, первая рабочая
// комбинация запоминается. Официально аудио принимают: 3.8/3.7/3.6/3.5 Flash,
// 3.5/3.1/2.5 Flash-Lite, 2.5 Flash (mime: audio/ogg и audio/opus).
const VOICE_DEFAULTS = 'gemini-3.5-flash-lite,gemini-3.8-flash,gemini-3.7-flash,gemini-3.6-flash'
let voiceOk = null // {model, mime} — найденная рабочая комбинация

async function callGemini(env, parts, jsonOut, model) {
  if (env.MOCK_GEMINI === '1') {
    return jsonOut
      ? '{"heard":"тест услышан","answer":"Ответ сорок два"}'
      : 'Ответ сорок два'
  }
  const generationConfig = { temperature: 0.2, maxOutputTokens: 800 }
  if (jsonOut) generationConfig.responseMimeType = 'application/json'
  if (env.THINKING_LEVEL) generationConfig.thinkingConfig = { thinkingLevel: env.THINKING_LEVEL }

  const r = await fetch(API_BASE + (model || env.GEMINI_MODEL || 'gemini-3.5-flash-lite') + ':generateContent', {
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

// ---------- АВТОПОДБОР МОДЕЛИ ----------
// Если дефолтная модель отклонена (400/404) — спрашиваем у API список
// доступных и берём первую подходящую flash-модель (лайты вперёд).
let modelList = null
let rejectedModels = new Set() // модели, которые API уже отверг
async function discoverModels(env) {
  if (modelList) return modelList
  try {
    const r = await fetch(API_BASE, { headers: { 'x-goog-api-key': env.GEMINI_KEY } })
    if (!r.ok) throw new Error('list ' + r.status)
    const d = await r.json()
    const all = (d.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).indexOf('generateContent') >= 0)
      .map((m) => String(m.name || '').replace(/^models\//, ''))
      .filter(
        (n) =>
          n.indexOf('flash') >= 0 &&
          n.indexOf('image') < 0 &&
          n.indexOf('tts') < 0 &&
          n.indexOf('live') < 0 &&
          n.indexOf('embedding') < 0,
      )
    all.sort((a, b) => (b.indexOf('lite') >= 0 ? 1 : 0) - (a.indexOf('lite') >= 0 ? 1 : 0))
    modelList = all
    console.error('[aiwatch] доступны модели:', all.slice(0, 5).join(', '))
  } catch (e) {
    console.error('[aiwatch] список моделей не получен:', String((e && e.message) || e).slice(0, 120))
    modelList = []
  }
  return modelList
}

function isModelReject(msg) {
  msg = String(msg || '')
  return msg.indexOf('Gemini 400') >= 0 || msg.indexOf('Gemini 404') >= 0
}

async function askText(env, q) {
  if (!q) throw new Error('пустой вопрос')
  try {
    return { answer: detex(await callGemini(env, [{ text: q }], false)) }
  } catch (e) {
    if (!isModelReject(e && e.message)) throw e
    console.error('[aiwatch] модель отклонена, пробую автоподбор:', String(e.message).slice(0, 140))
    rejectedModels.add(env.GEMINI_MODEL || 'gemini-3.5-flash-lite')
    const list = (await discoverModels(env)).filter((m) => !rejectedModels.has(m))
    if (!list.length) throw e
    const text = await callGemini(env, [{ text: q }], false, list[0])
    return { answer: detex(text) }
  }
}

function parseHeardAnswer(raw) {
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
  return { heard: heard.slice(0, 200), answer: detex(answer) }
}

async function voiceAttempt(env, model, mime, b64) {
  return parseHeardAnswer(
    await callGemini(
      env,
      [
        { inline_data: { mime_type: mime, data: b64 } },
        { text: VOICE_INSTR },
      ],
      true,
      model,
    ),
  )
}


// ---------- ГОЛОС ЧЕРЕЗ FILES API (официальный путь) ----------
// Аудио грузится отдельным запросом (client.files.upload), затем в
// generateContent уходит file_data-часть со ссылкой. Если SDK недоступен
// (нет пакета) — молча переходим на инлайн-цепочку.
let genaiClient = null
let sdkBroken = false
if (typeof globalThis !== 'undefined') {
  // хук для тестов: сброс кэша SDK-клиента
  globalThis.__genaiReset = () => {
    genaiClient = null
    sdkBroken = false
  }
}

async function getGenai(env) {
  if (genaiClient) return genaiClient
  if (globalThis.__genaiFactory) {
    // хук для тестов: подставляем фейкового клиента
    genaiClient = globalThis.__genaiFactory(env)
    return genaiClient
  }
  try {
    const mod = await import('@google/genai')
    genaiClient = new mod.GoogleGenAI({ apiKey: env.GEMINI_KEY })
    return genaiClient
  } catch (e) {
    sdkBroken = true
    throw new Error('sdk-unavailable: ' + String((e && e.message) || e).slice(0, 80))
  }
}

async function uploadAudioFile(env, b64, mime) {
  const client = await getGenai(env)
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const blob = new Blob([bytes], { type: mime })
  let f = await client.files.upload({ file: blob, config: { mimeType: mime } })
  // ждём, пока Google обработает файл (обычно мгновенно для коротких)
  for (let i = 0; i < 20 && f && f.state === 'PROCESSING'; i++) {
    await new Promise((r) => setTimeout(r, 500))
    f = await client.files.get({ name: f.name })
  }
  if (f && f.state && f.state !== 'ACTIVE') throw new Error('файл не готов: ' + f.state)
  const uri = f.uri || (f.file && f.file.uri)
  if (!uri) throw new Error('нет uri после загрузки')
  return { uri, mime }
}

async function voiceAttemptFile(env, model, mime, b64) {
  const f = await uploadAudioFile(env, b64, mime)
  return parseHeardAnswer(
    await callGemini(
      env,
      [{ file_data: { mime_type: f.mime, file_uri: f.uri } }, { text: VOICE_INSTR }],
      true,
      model,
    ),
  )
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

  const models = String(env.VOICE_MODELS || VOICE_DEFAULTS)
    .split(',')
    .map((s) => s.trim())
    .filter((m) => m && !rejectedModels.has(m))
  const mimes = String(env.VOICE_MIMES || 'audio/ogg,audio/opus')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  let lastErr = null

  // 1) закэшированная рабочая комбинация
  if (voiceOk) {
    try {
      const r =
        voiceOk.kind === 'file'
          ? await voiceAttemptFile(env, voiceOk.model, voiceOk.mime, b64)
          : await voiceAttempt(env, voiceOk.model, voiceOk.mime, b64)
      return r
    } catch (e) {
      lastErr = e
      voiceOk = null // кэш протух — ищем заново
    }
  }

  // 2) Files API (правильный путь для аудио), перебор моделей
  if (!sdkBroken) {
    for (const m of models) {
      try {
        const r = await voiceAttemptFile(env, m, 'audio/ogg', b64)
        voiceOk = { kind: 'file', model: m, mime: 'audio/ogg' }
        return r
      } catch (e) {
        if (String((e && e.message) || e).indexOf('sdk-unavailable') >= 0) {
          sdkBroken = true
          break
        }
        lastErr = e
      }
    }
  }

  // 3) инлайн-цепочка (модели x форматы)
  for (const m of models) {
    for (const mm of mimes) {
      try {
        const r = await voiceAttempt(env, m, mm, b64)
        voiceOk = { kind: 'inline', model: m, mime: mm }
        return r
      } catch (e) {
        lastErr = e
      }
    }
  }
  console.error('[aiwatch] голос: все попытки провалились, последняя ошибка:', String((lastErr && lastErr.message) || lastErr).slice(0, 200))
  throw new Error(
    'голос не прошёл ни одним способом; последняя ошибка: ' +
      String((lastErr && lastErr.message) || lastErr).slice(0, 160),
  )
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
