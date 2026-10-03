# Bot de Arbitragem

Repositório técnico do projeto **Arbitragem Crypto**.

## Estado atual

A branch `recovery/site-v16-baseline` contém a primeira baseline reconstruída e testável do Radar Cripto a partir do Site observável `entre-cripto-carlos` source version 16.

**Ainda não é versão estável.** O `main` continua sendo o estado aprovado anterior até a recuperação passar pelo PR/CI e pelo checkpoint do Carlos OS.

## Escopo da baseline

- Binance × Bybit.
- Mercado spot em USDT.
- 25 candidatos canônicos; até 15 pares comuns monitorados.
- Livros de ofertas em tempo real via relay server-side; o navegador consome o próprio backend e não conecta diretamente às exchanges.
- Simulação de profundidade/VWAP para o valor escolhido.
- Filtro de identidade, freshness, sincronismo e liquidez.
- Custos modelados antes de classificar oportunidade.
- Top 5 somente com resultado líquido positivo.
- Zero envio de ordens e zero credenciais.

## Executar localmente

Requer Node.js 22+.

```bash
npm ci
npm test
npm run check
npm start
```

Abra `http://127.0.0.1:8787`.

Preview de recuperação: `https://radar-cripto-carlos-frankfurt.onrender.com` (Frankfurt).

## Regras

- `main`: somente estado aprovado.
- Mudanças relevantes: branch de trabalho.
- Nunca commitar API keys, secret keys, tokens ou credenciais.
- Versões estáveis precisam de commit/tag explícito e checkpoint no Carlos OS.
- Bugs relevantes precisam de causa raiz e teste de regressão.
- Alterações materiais geram changelog e checkpoint no Carlos OS.

## Limitação importante

A baseline calcula uma **estimativa de spread líquido com inventário pré-posicionado nas duas exchanges**. Rede de saque, depósito, taxa de retirada e disponibilidade de transferência ainda não são validadas automaticamente; portanto, o radar não chama essas estimativas de arbitragem de transferência garantida.

## Fonte de contexto

Decisões, requisitos, bugs, invariantes e checkpoints ficam no **Carlos OS / Notion**. O GitHub é a fonte oficial dos arquivos e versões de código quando consolidados.
