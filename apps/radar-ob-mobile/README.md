# Radar OB Mobile V7 — pesquisa de estratégias Forex (experimental)

## Estado
Aplicativo PWA no Render, sem cadastro, analisa pares Forex da API pública Deriv somente enquanto aberto no iPhone. Não opera na IQ Option, não executa ordens, não fornece sinais garantidos.

### Alterações V7 (2026-10-11)
- **Comparação honesta entre dois métodos**: baseline V6 mantido intacto; novo setup de tendência/volatilidade/candle pré-fixado (sem ajustar parâmetros no trecho de avaliação).
- **Validação cronológica**: 60% inicial como referência de desenvolvimento, últimos 40% como teste retrospectivo; ambos os modelos avaliados no mesmo trecho. Isto NÃO é prova prospectiva nem independente de toda a pesquisa já feita.
- **Regras por expiração**: 1-2 minutos protegem contra exaustão; 3-5 usam confirmação de continuidade; 10-30 requerem tendência mais forte.
- **Filtros**: relação das EMAs, inclinação da EMA21, ATR normalizado, proporção corpo/pavio, distância da tendência, continuidade da série.
- **Proteção contra superestimação**: trades não sobrepostos em cada par/prazo; apenas velas fechadas; indicação de número de testes, Wilson unilateral de 95%, mínimo 30 eventos no desenvolvimento e 25 no teste, limite inferior acima do equilíbrio hipotético do payout + 2 pontos percentuais.
- **Dados**: solicita até 2.500 candles de 1 minuto por ativo; reduz automaticamente para 1.000 se o provedor rejeitar quantidade maior. Ticks via WebSocket; atualização visual no próximo frame; histórico em cache entre ticks.
- **Nenhuma promessa de melhoria na taxa de acertos**: novos filtros tendem a reduzir a frequência de entradas, mas podem não aumentar a taxa no futuro. Se a validação não demonstrar vantagem, apresenta SEM ENTRADA.

## Premissas do teste
Indicadores calculados apenas com candles disponíveis no instante do sinal. Entrada hipotética na abertura da próxima vela de 1m e expiração avaliada pelo fechamento da vela apropriada; empates contam como perda. Taxa mostrada não inclui slippage, spread, preço de liquidação real, latência ou payout específico do contrato. Cada vencimento é avaliado separadamente, sem sobreposição de operações dentro de um par e vencimento.

O histórico pode conter até 2.500 minutos consecutivos fechados; resultados continuam com amostras pequenas, inclusive devido a filtro adicional. Comparar muitos pares/prazos também gera risco de seleção. Os filtros foram definidos antes desta V7, mas após inspeção de resultados históricos V6; portanto o teste atual ainda é exploratório. Antes de qualquer uso real deve haver acompanhamento prospectivo em conta demonstrativa com sinais e preços executáveis registrados antes do desfecho e auditoria independente.

## Fonte e arquitetura
Deriv WebSocket público em https://developers.deriv.com/docs/data/ticks-history/ e `active_symbols`. Endpoint principal `wss://api.derivws.com/trading/v1/options/ws/public`, fallback `wss://ws.binaryws.com/websockets/v3`. A fonte difere das cotações IQ Option, especialmente OTC. Pares: EUR/USD, GBP/USD, USD/JPY, EUR/JPY, AUD/USD, USD/CHF. Vencimentos simulados: 1, 2, 3, 5, 10, 15, 30 minutos. Não monitora com a página fechada.

GitHub: `Carlosbraga436/bot_arbitragem` branch `app/radar-ob-mobile-v5`, pasta isolada `apps/radar-ob-mobile`. Render: serviço `radar-ob-mobile-carlos`. Build `cd apps/radar-ob-mobile && npm install --omit=dev`. Start `cd apps/radar-ob-mobile && npm start`.

## Critérios de aceitação
1. Com mercado fechado: carrega histórico, mostra ambas as estratégias e ZERO entradas ao vivo.
2. Com mercado aberto: atualiza ticks assim que chegam e bloqueia cotações atrasadas.
3. Se a amostra ou intervalo de confiança não sustenta vantagem: SEM ENTRADA.
4. Comparação histórica mostra frequência de operações e resultado por estratégia, sem ranking enganoso baseado em acertos brutos.
