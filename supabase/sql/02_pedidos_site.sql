-- =========================================================
-- A Forja Pizzaria — Pedidos pelo cardápio digital
-- Rode no Supabase: SQL Editor > New query > Run
-- =========================================================

alter table pedidos      add column if not exists origem text default 'whatsapp';
alter table pedidos      add column if not exists observacoes text;
alter table itens_pedido add column if not exists observacao text;

create index if not exists pedidos_criado_em_idx on pedidos (criado_em desc);
