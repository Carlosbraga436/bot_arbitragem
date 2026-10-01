# Política de mudança

## Branches

- `main`: somente estado validado.
- `feature/<tema>`: funcionalidade.
- `fix/<bug>`: correção.
- `chore/<tema>`: manutenção.
- `recovery/<tema>`: recuperação de incidente/regressão.

## Antes da alteração

1. Recuperar contexto no Carlos OS.
2. Verificar manifesto técnico, invariantes, bugs e último checkpoint.
3. Registrar mudança relevante no Controle de Mudanças.
4. Definir rollback quando risco for Médio/Alto.

## Antes de integrar em main

1. Executar testes aplicáveis.
2. Executar regressões relevantes.
3. Confirmar que invariantes continuam válidas.
4. Confirmar ausência de credenciais.
5. Registrar bugs conhecidos.
6. Atualizar changelog e checkpoint.
7. Atualizar commit/versão estável no manifesto.

Uma mudança que não passou por validação não deve ser chamada de versão estável.
