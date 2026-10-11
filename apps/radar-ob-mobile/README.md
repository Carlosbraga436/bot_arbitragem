# Radar OB Mobile — hospedagem experimental

App instalável como PWA; sem login; busca liga automaticamente ao abrir e para ao pausar/ocultar. Comunicação SSE em /api/stream (sem polling de 12 segundos). Suporta seleção de 1, 2, 3, 5, 10, 15 e 30 minutos, Forex e OTC.

**ESTADO:** O servidor e a interface estão publicados como protótipo de infraestrutura. NÃO existe conexão IQ Option autenticada/validada; NÃO existem sinais reais; NÃO existe execução automática. Por segurança não exibimos cotações falsas nem CALL/PUT simulados.

Fonte de dados futura: conta demonstrativa autorizada, com conector isolado do frontend. Os ticks podem ser enviados à rota POST /api/tick com Authorization: Bearer INGEST_TOKEN, mas essa rota é desabilitada caso INGEST_TOKEN não esteja definido; ela recebe apenas ticks e não valida nem gera sinais. Historico, payout, backtesting fora da amostra e aferição de latência são etapas futuras necessárias.

O repositório original de arbitragem não foi alterado no ramo principal. Este app vive em apps/radar-ob-mobile na branch app/radar-ob-mobile-v5 e tem serviço Render próprio. Não configure senha de IQ Option em GitHub, no HTML, nem em logs.

Deploy Render: runtime Node; build: cd apps/radar-ob-mobile && npm install --omit=dev; start: cd apps/radar-ob-mobile && npm start; health: /api/health. Plano gratuito pode hibernar após 15 minutos sem tráfego, causando atraso na abertura.
