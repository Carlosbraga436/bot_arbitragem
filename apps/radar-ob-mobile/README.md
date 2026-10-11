# Radar OB Mobile — Forex independente (V6 experimental)

## Objetivo
Monitorar pares de Forex convencionais sem conta na IQ Option. O aplicativo começa ao abrir no iPhone e suspende a conexão WebSocket quando fica oculto/fechado. Sem ordens nem login.

## Fonte
Dados públicos da **Deriv**, diretamente no navegador, via WebSocket com fallback entre:
- `wss://api.derivws.com/trading/v1/options/ws/public` (nova API pública)
- `wss://ws.binaryws.com/websockets/v3` (compatibilidade legado)

Consulta `active_symbols`, `ticks_history` (candles de 60 segundos) e `ticks` com `subscribe: 1`. A fonte é externa à IQ Option. OTC da IQ Option não é suportado. Nenhuma conta exigida para consultas de mercado, segundo a documentação pública da API Deriv.

## Análise
6 pares Forex; 7 prazos de expiração (1,2,3,5,10,15,30min) por par. Indicadores EMA 9/21/50, RSI14, ATR14. Candles precisam estar fechados. Backtest de 40% mais recente dos candles, sem dados futuros para gerar sinal; entrada teórica na abertura da vela seguinte, saída no fechamento após o vencimento, sem sobreposição de operações no mesmo par/prazo. Exibe taxa histórica, amostras e limite inferior de Wilson unilateral a 90%. Exige >=30 amostras e limite inferior > ponto de equilíbrio do payout HIPOTÉTICO + 2pp. Se a última vela está atrasada ou a cotação tem mais de 4,5 segundos, bloqueia todos os candidatos. Apenas nos 8 primeiros segundos da próxima vela considera candidato teórico, ainda NÃO operável.

### Segurança / limitações
- **Não constitui indicação para executar opções binárias**. A cotação é diferente da IQ Option e o payout é simulado, não verificado.
- Indicadores e backtests podem apresentar resultados piores ao vivo (viés de seleção, spread, latência, volatilidade e especificidades do contrato). 
- Não há monitoramento do mercado enquanto o aplicativo não estiver aberto; hospedagem gratuita Render pode levar ~1 min para acordar.
- Final de semana: Forex convencional fecha; o aplicativo exibe preços ausentes sem inventar sinais.
- Testes unitários locais do cálculo concluídos; a conexão real Deriv no ambiente de hospedagem/navegador requer validação externa.

## Publicação
GitHub: `Carlosbraga436/bot_arbitragem`, branch `app/radar-ob-mobile-v5`, apenas pasta `apps/radar-ob-mobile`, sem alterar código do bot de arbitragem. Render service `radar-ob-mobile-carlos` (free); Start command: `cd apps/radar-ob-mobile && npm start`. Arquivos públicos: index.html, core.js e forex.js.

## Uso no iPhone
Abra https://radar-ob-mobile-carlos.onrender.com no Safari, Compartilhar > Adicionar à Tela de Início. A busca começa ao abrir, pode ser pausada. O app não solicita senha de corretora.
