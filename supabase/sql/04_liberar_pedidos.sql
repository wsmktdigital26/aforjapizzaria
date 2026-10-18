-- =========================================================
-- A Forja Pizzaria — Liberar os pedidos online
-- O campo ativo_ate controla até quando o sistema aceita pedidos.
-- Escolha UMA das opções abaixo e rode no SQL Editor.
-- =========================================================

-- Opção A: liberar por 30 dias a partir de agora (bom para cobrar mensalidade)
update configuracoes set ativo_ate = now() + interval '30 days' where id = 1;

-- Opção B: liberar sem prazo (tire os "--" da linha abaixo e rode só ela)
-- update configuracoes set ativo_ate = null where id = 1;
