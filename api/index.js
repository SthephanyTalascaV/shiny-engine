// api/index.js — UMA única Serverless Function com roteamento interno (regra Vercel Hobby: <= 12 functions)
// Rotas:
//   POST /api/live-token    -> token efêmero p/ o navegador abrir a chamada de voz direto no Gemini Live
//   POST /api/evaluate      -> avalia a transcrição da simulação pela rubrica
//   POST /api/transcribe    -> transcreve áudio de uma ligação real (Criar Agente via Call)
//   POST /api/clone         -> analisa a ligação real e gera uma persona pronta
//   GET  /api/health        -> checa se a GEMINI_API_KEY está configurada
//
// Variáveis de ambiente (Vercel > Settings > Environment Variables):
//   GEMINI_API_KEY   (obrigatória)
//   EVAL_MODEL       (opcional, padrão gemini-2.5-flash)

const { GoogleGenAI } = require('@google/genai');

const API_KEY = process.env.GEMINI_API_KEY;
const EVAL_MODEL = process.env.EVAL_MODEL || 'gemini-2.5-flash';
const GEN_URL = (model) =>
  `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

// ---------- helpers ----------
function send(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function gemini({ parts, schema, temperature = 0, model = EVAL_MODEL }) {
  const r = await fetch(GEN_URL(model), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': API_KEY },
    body: JSON.stringify({
      contents: [{ role: 'user', parts }],
      generationConfig: {
        temperature,
        ...(schema ? { responseMimeType: 'application/json', responseSchema: schema } : {}),
      },
    }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error?.message || `Gemini respondeu ${r.status}`);
  const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  return schema ? JSON.parse(text) : text;
}

// ---------- schemas ----------
const S = (type, extra = {}) => ({ type, ...extra });
const ARR = (items) => ({ type: 'ARRAY', items });

const EVAL_SCHEMA = S('OBJECT', {
  properties: {
    criteriaScores: ARR(S('OBJECT', {
      properties: { criterion: S('STRING'), score: S('NUMBER'), feedback: S('STRING') },
      required: ['criterion', 'score', 'feedback'],
    })),
    stages: ARR(S('OBJECT', {
      properties: {
        name: S('STRING'), score: S('NUMBER'), timestamp: S('STRING'),
        positivePoints: ARR(S('STRING')), improvementPoints: ARR(S('STRING')),
      },
      required: ['name', 'score', 'positivePoints', 'improvementPoints'],
    })),
    completedItems: ARR(S('STRING')),
    adherenceScore: S('NUMBER'),
    objectionsHandledCount: S('NUMBER'),
    techniquesUsed: ARR(S('STRING')),
    mainStrength: S('STRING'),
    mainImprovement: S('STRING'),
  },
  required: ['criteriaScores', 'stages', 'completedItems', 'adherenceScore',
    'objectionsHandledCount', 'techniquesUsed', 'mainStrength', 'mainImprovement'],
});

const CLONE_SCHEMA = S('OBJECT', {
  properties: {
    analysis: S('OBJECT', {
      properties: {
        clientProfile: S('OBJECT', {
          properties: {
            decisionMakerName: S('STRING'), gender: S('STRING'), role: S('STRING'),
            officeName: S('STRING'), segment: S('STRING'), estimatedSize: S('STRING'),
            temperament: S('STRING'), communicationStyle: S('STRING'),
          },
        }),
        currentScenario: S('OBJECT', {
          properties: {
            currentTools: ARR(S('STRING')), painPoints: ARR(S('STRING')), latentNeeds: S('STRING'),
          },
        }),
        objections: ARR(S('OBJECT', {
          properties: { text: S('STRING'), severity: S('STRING', { enum: ['alta', 'media', 'baixa'] }) },
        })),
      },
    }),
    generatedAgent: S('OBJECT', {
      properties: {
        name: S('STRING'), description: S('STRING'), persona: S('STRING'),
        objections: ARR(S('STRING')), voice: S('STRING'), productName: S('STRING'),
        officeName: S('STRING'), decisionMakerName: S('STRING'),
      },
    }),
  },
  required: ['analysis', 'generatedAgent'],
});

const VOICES = 'Mulher: Zephyr, Kore, Leda, Aoede, Callirrhoe, Autonoe, Despina, Erinome, Laomedeia, Achernar, Gacrux, Pulcherrima, Vindemiatrix, Sulafat. Homem: Puck, Charon, Fenrir, Orus, Enceladus, Iapetus, Umbriel, Algieba, Algenib, Rasalgethi, Alnilam, Schedar, Achird, Zubenelgenubi, Sadachbia, Sadaltager.';

// ---------- rotas ----------
async function liveToken(req, res) {
  const ai = new GoogleGenAI({ apiKey: API_KEY });
  const now = Date.now();
  const token = await ai.authTokens.create({
    config: {
      uses: 1,
      expireTime: new Date(now + 30 * 60 * 1000).toISOString(),      // chamada dura até 30 min
      newSessionExpireTime: new Date(now + 2 * 60 * 1000).toISOString(), // precisa conectar em 2 min
      httpOptions: { apiVersion: 'v1alpha' },
    },
  });
  send(res, 200, { token: token.name });
}

async function evaluate(req, res) {
  const { transcript, scenario, scriptItems = [], profile } = await readBody(req);
  if (!transcript || transcript.trim().length < 10) return send(res, 400, { error: 'Transcrição vazia.' });
  const criteria = (profile?.criteria || []).map(
    (c) => `- ${c.label} (peso ${c.weight}): ${c.rubric}`).join('\n');

  const prompt = `${profile?.preamble || 'Você é um coach de Customer Success extremamente criterioso.'}

## CENÁRIO / PERSONA DO CLIENTE (o que a IA interpretou)
${scenario || '(não informado)'}

## CHECKLIST ESPERADO DO ANALISTA
${scriptItems.length ? scriptItems.map((s) => '- ' + s).join('\n') : '(sem checklist fixo)'}

## CRITÉRIOS (nota de 1 a 10 cada — use EXATAMENTE estes nomes em "criterion")
${criteria}

## REGRAS
- Avalie só o ANALISTA (falas "ANALISTA"). As falas "CLIENTE" são da IA.
- Seja técnico e cite trechos/momentos concretos no feedback.
- stages: divida a ligação nas etapas que realmente aconteceram (nota 0-100 cada, com timestamp aproximado).
- completedItems: só os itens do checklist que foram de fato cumpridos. adherenceScore = % do checklist cumprido (0-100).
- objectionsHandledCount: quantas objeções do cliente foram contornadas de forma eficaz.
- mainStrength / mainImprovement: 1 a 2 frases cada, em português.
- Se a ligação foi curta demais ou sem conteúdo, dê notas baixas e explique.

## TRANSCRIÇÃO
${transcript}`;

  const out = await gemini({ parts: [{ text: prompt }], schema: EVAL_SCHEMA, temperature: profile?.temperature ?? 0 });
  send(res, 200, out);
}

async function transcribe(req, res) {
  const { audioBase64, mimeType = 'audio/webm' } = await readBody(req);
  if (!audioBase64) return send(res, 400, { error: 'Áudio não enviado.' });
  const text = await gemini({
    parts: [
      { inlineData: { mimeType, data: audioBase64 } },
      { text: 'Transcreva esta ligação comercial em português, separando os falantes como "ANALISTA:" (quem é da Nibo) e "CLIENTE:". Uma fala por linha, com [mm:ss] no início. Não resuma, não invente.' },
    ],
  });
  send(res, 200, { transcript: text.trim() });
}

async function clone(req, res) {
  const { transcript, contextNotes = '', productName = '' } = await readBody(req);
  if (!transcript || transcript.trim().length < 20) return send(res, 400, { error: 'Transcrição curta demais.' });
  const prompt = `Você é especialista em treinamento de Customer Success da Nibo (software contábil B2B).
Analise a ligação REAL abaixo e:
1) Extraia o perfil do cliente/decisor, o cenário atual (ferramentas, dores, necessidade latente) e TODAS as objeções reais com severidade.
2) Gere um agente de simulação ("generatedAgent") que reproduza fielmente esse cliente:
   - persona: instrução em 2ª pessoa ("Você é ...") com 150-300 palavras: quem é, escritório, rotina, dores, temperamento, como reage, frases típicas que usou, e a regra de que NÃO conhece técnicas de venda e NÃO facilita para o analista.
   - objections: 3-6 objeções reformuladas em fala natural do cliente.
   - voice: escolha UMA voz coerente com o gênero do decisor. ${VOICES}
   - productName: ${productName ? `"${productName}"` : 'o produto Nibo discutido na call'}.
   - Troque nomes reais de pessoas/empresas por nomes fictícios parecidos (LGPD).
${contextNotes ? `\nContexto do gestor: ${contextNotes}` : ''}

TRANSCRIÇÃO:
${transcript}`;
  const out = await gemini({ parts: [{ text: prompt }], schema: CLONE_SCHEMA, temperature: 0.4 });
  send(res, 200, out);
}

// ---------- roteador ----------
module.exports = async (req, res) => {
  const path = (req.url || '').split('?')[0].replace(/\/+$/, '');
  try {
    if (path === '/api/health') return send(res, 200, { ok: !!API_KEY, evalModel: EVAL_MODEL });
    if (!API_KEY) return send(res, 500, { error: 'GEMINI_API_KEY não configurada na Vercel.' });
    if (req.method !== 'POST') return send(res, 405, { error: 'Use POST.' });
    if (path === '/api/live-token') return await liveToken(req, res);
    if (path === '/api/evaluate') return await evaluate(req, res);
    if (path === '/api/transcribe') return await transcribe(req, res);
    if (path === '/api/clone') return await clone(req, res);
    return send(res, 404, { error: `Rota não encontrada: ${path}` });
  } catch (e) {
    console.error(path, e);
    return send(res, 500, { error: e.message || String(e) });
  }
};
