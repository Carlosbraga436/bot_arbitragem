# Baseline recuperada — Site v16

## Origem

- Artefato observável: `entre-cripto-carlos` (Site ativo), source version 16.
- Data de recuperação: 2026-10-03.
- O código-fonte original do Site não foi exportável pela integração disponível; esta branch é uma reconstrução rastreável da baseline observável, não uma alegação de cópia byte a byte.

## Escopo preservado

- Binance × Bybit.
- Spot em USDT.
- Somente leitura/simulação; zero envio de ordens.
- Sem chave de API para market data público.
- 25 candidatos canônicos e até 15 pares comuns monitorados.
- Identidade elegível somente quando o par/base/quote está ativo nos dois catálogos e consta no registro canônico local.
- Livros recentes das duas corretoras.
- Liquidez calculada pelo consumo do livro, não apenas pelo melhor bid/ask.
- Custos padrão: Binance 0,10%; Bybit 0,10%; reserva 0,05%; recomposição 0,50 USDT.
- Top 5 somente de resultados líquidos positivos elegíveis.

## Arquitetura

- `server.js`: servidor local e proxy de catálogos REST públicos.
- `public/app.js`: conexão WebSocket pública com Binance e Bybit + UI.
- `src/core.js`: motor determinístico de liquidez, custos, freshness e ranking.
- `tests/core.test.js`: regressões das invariantes críticas.

## Segurança lógica

A aplicação não implementa endpoints de ordem nem carrega credenciais. Falha ou ausência de dados degrada para resultado inelegível; nunca fabrica preço.

## Limitação atual

A identidade confirma equivalência operacional por registro canônico + catálogos de spot das exchanges. Rede de saque, depósito, taxa de retirada e disponibilidade de transferência ainda não são verificadas. Por isso os resultados são **estimativas de spread líquido de execução simultânea com inventário pré-posicionado**, não arbitragem de transferência garantida.
