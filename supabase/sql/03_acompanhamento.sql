-- =========================================================
-- A Forja Pizzaria — Acompanhamento de pedidos
-- Rode no Supabase: SQL Editor > New query > Run
-- =========================================================

-- Código aleatório que protege o link de acompanhamento de cada pedido
alter table pedidos add column if not exists codigo text;
