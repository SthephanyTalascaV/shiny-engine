# Simulador de Ligações CS · Nibo

Clone da arquitetura do roleplaynibo.ai.studio, adaptado para CS (upsell do Radar e-CAC).

## Estrutura
- `index.html`: o app inteiro (HTML + CSS + JS puro). As telas são Treinar, Sessão de voz, Histórico, Resultado, Criar Agente via Call e Personas & Rubrica.
- `api/index.js`: **1 única** Serverless Function com roteamento interno (`/api/live-token`, `/api/evaluate`, `/api/transcribe`, `/api/clone`, `/api/health`).
- `vercel.json`: manda todo `/api/*` para a function.

## Deploy (Vercel)
1. Suba a pasta para um repositório no GitHub e importe na Vercel (Framework: **Other**).
2. Em Settings > Environment Variables, crie `GEMINI_API_KEY` (e, se quiser, `EVAL_MODEL`).
3. Faça o deploy e abra `/api/health`. A resposta tem que ser `{"ok":true}`.

## Como a voz funciona
O navegador pede um **token efêmero** em `/api/live-token`. Com ele, abre o WebSocket **direto** no Gemini Live, então a chave nunca vai para o front e a Vercel não precisa segurar WebSocket. O microfone é enviado em PCM 16 kHz e a voz da IA volta em PCM 24 kHz. As duas transcrições chegam em tempo real.

Se a chamada não conectar, troque o "Modelo de voz" em ⚙️ pelo modelo Live/native-audio que estiver disponível na sua chave.

## Dados
Personas, rubrica e histórico ficam no `localStorage`, e o áudio fica no IndexedDB do navegador. Para os gestores verem as ligações de todo o time, o próximo passo é trocar o objeto `db` por Supabase ou Firebase.
