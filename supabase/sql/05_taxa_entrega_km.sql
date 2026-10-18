-- =========================================================
-- A Forja Pizzaria — Taxa de entrega por distância
-- Rode no Supabase: SQL Editor > New query > Run
-- =========================================================

-- Faixas da A Forja (a distância é arredondada para cima: 3,2 km cai na faixa de até 5 km)
delete from faixas_entrega;
insert into faixas_entrega (ate_km, taxa) values
  (3,  5.00),
  (5,  6.00),
  (7,  8.00),
  (10, 12.00),
  (15, 15.00);

-- Coordenadas da pizzaria (OBRIGATÓRIO para calcular a distância)
-- No Google Maps, segure o dedo sobre a pizzaria e copie os dois números.
-- Exemplo: update configuracoes set latitude = -16.6512345, longitude = -49.4923456 where id = 1;
update configuracoes set
  latitude  = null,   -- TODO: cole a latitude aqui (número negativo, ex.: -16.65...)
  longitude = null    -- TODO: cole a longitude aqui (número negativo, ex.: -49.49...)
where id = 1;

-- Ajuste entre a linha reta e o caminho pelas ruas (1.30 = 30% a mais)
update configuracoes set fator_rota = 1.30 where id = 1;
