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
  return { answer: detex(await callGemini(env, [{ text: q }], false)) }
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
  return { heard: heard.slice(0, 200), answer: detex(answer) }
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
