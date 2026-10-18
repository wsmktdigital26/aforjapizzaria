-- =========================================================
-- A Forja Pizzaria — Ajustes para a versão 2 do bot
-- Rode no Supabase: SQL Editor > New query > Run
-- =========================================================

alter table configuracoes add column if not exists url_cardapio text;
alter table configuracoes add column if not exists telefone_loja text;
alter table configuracoes add column if not exists cidade text;
alter table conversas     add column if not exists ultima_msg_id text;

update configuracoes set
  telefone_loja = '(62) 99127-4120',
  cidade        = null,   -- TODO: cidade da pizzaria (usada no Pix), ex.: 'Trindade'
  url_cardapio  = null    -- TODO: URL pública da imagem do cardápio no Storage
where id = 1;

-- Para testar: garanta que o bot está liberado por 7 dias a partir de agora
update configuracoes set ativo_ate = now() + interval '7 days' where id = 1;
