# Invariantes — Arbitragem Crypto

Estas regras são requisitos de segurança lógica. Elas só podem mudar mediante decisão explícita registrada no Carlos OS.

1. **Mesmo mercado:** nunca comparar ativos/pares/mercados incompatíveis entre exchanges.
2. **Lucro líquido:** oportunidade exibida como lucro deve considerar os custos explicitamente modelados pelo sistema.
3. **Liquidez:** oportunidade sem liquidez mínima definida não deve ser classificada como executável.
4. **Dados válidos:** preço nulo, stale ou inválido não pode gerar oportunidade válida.
5. **Falha de exchange:** indisponibilidade de uma API deve degradar com segurança, não gerar preço/operação falsa.
6. **Credenciais:** chaves e secrets nunca entram no repositório.
7. **Rastreabilidade:** versão estável precisa ter commit explícito e checkpoint correspondente.
8. **Sem falsa precisão:** quando taxas, slippage ou custos não estiverem confirmados, o resultado deve ser identificado como estimativa, não lucro garantido.

## Validação

Assim que o código real for consolidado, cada invariante deverá possuir teste automatizado ou verificação explícita correspondente.
