-- =========================================================
-- A Forja Pizzaria — Chatbot — Etapa 1: Banco de dados (Supabase)
-- Rode no Supabase: SQL Editor > New query > Run
-- =========================================================

-- Precisa rodar de novo do zero? Tire os "--" das linhas abaixo e rode só elas:
-- drop table if exists itens_pedido, pedidos, conversas, clientes,
--   faixas_entrega, bebidas, sabores, horarios, configuracoes,
--   precos, tamanhos, categorias, bordas, bairros cascade;

-- ---------- CONFIGURAÇÕES DA LOJA (uma linha só) ----------
create table configuracoes (
  id int primary key default 1 check (id = 1),
  nome_loja text not null,
  endereco_retirada text,
  latitude numeric(10,7),            -- coordenadas da pizzaria (Google Maps)
  longitude numeric(10,7),
  preco_pizza numeric(10,2) not null,          -- todas as pizzas grandes
  acrescimo_dois_sabores numeric(10,2) default 0,
  max_sabores int default 2,
  fator_rota numeric(3,2) default 1.30,        -- ajuste linha reta -> ruas
  chave_pix text,
  telefone_cozinha text,             -- WhatsApp que recebe os pedidos (ex.: 5562999999999)
  ativo_ate timestamptz              -- fim do período de teste / mensalidade
);

-- Horários: se "fecha" for menor que "abre", passa da meia-noite
-- (ex.: sexta 18:30 às 02:00 = aberto até 2h do sábado)
create table horarios (
  dia_semana int primary key check (dia_semana between 0 and 6), -- 0 = domingo
  abre time,
  fecha time,
  aberto boolean default false
);

-- ---------- CARDÁPIO ----------
create table sabores (
  id serial primary key,
  nome text not null,
  ordem int default 0,
  ativo boolean default true
);

create table bebidas (
  id serial primary key,
  nome text not null,
  preco numeric(10,2) not null,
  ordem int default 0,
  ativo boolean default true
);

-- ---------- TAXA DE ENTREGA POR DISTÂNCIA ----------
-- Pega a primeira faixa em que a distância <= ate_km.
-- Acima da maior faixa = fora da área de entrega.
create table faixas_entrega (
  id serial primary key,
  ate_km numeric(5,2) not null unique,
  taxa numeric(10,2) not null
);

-- ---------- CLIENTES E CONVERSAS ----------
create table clientes (
  id uuid primary key default gen_random_uuid(),
  telefone text unique not null,
  nome text,
  ultimo_endereco text,
  criado_em timestamptz default now()
);

create table conversas (
  cliente_id uuid primary key references clientes(id) on delete cascade,
  etapa text not null default 'inicio',
  pedido_parcial jsonb default '{}'::jsonb,   -- carrinho em montagem
  tentativas_invalidas int default 0,
  atendimento_humano boolean default false,   -- true = bot pausado
  atualizado_em timestamptz default now()
);

-- ---------- PEDIDOS ----------
create table pedidos (
  id bigserial primary key,
  cliente_id uuid references clientes(id),
  tipo_entrega text check (tipo_entrega in ('entrega','retirada')),
  endereco text,
  latitude numeric(10,7),
  longitude numeric(10,7),
  distancia_km numeric(6,2),
  taxa_entrega numeric(10,2) default 0,
  forma_pagamento text check (forma_pagamento in ('pix','cartao','dinheiro')),
  troco_para numeric(10,2),
  subtotal numeric(10,2) not null,
  total numeric(10,2) not null,
  status text default 'recebido'
    check (status in ('aguardando_pagamento','recebido','em_preparo',
                      'saiu_entrega','pronto_retirada','entregue','cancelado')),
  criado_em timestamptz default now()
);

create table itens_pedido (
  id bigserial primary key,
  pedido_id bigint references pedidos(id) on delete cascade,
  tipo text check (tipo in ('pizza','bebida')),
  descricao text not null,       -- ex.: "Pizza Grande — Calabresa / Bacon"
  quantidade int default 1,
  preco_unitario numeric(10,2) not null
);

create index on pedidos (status, criado_em);

-- ---------- SEGURANÇA ----------
-- RLS ligado: só a Edge Function (chave service_role) acessa os dados.
alter table configuracoes  enable row level security;
alter table horarios       enable row level security;
alter table sabores        enable row level security;
alter table bebidas        enable row level security;
alter table faixas_entrega enable row level security;
alter table clientes       enable row level security;
alter table conversas      enable row level security;
alter table pedidos        enable row level security;
alter table itens_pedido   enable row level security;

-- Acesso somente para o código do bot (service_role).
-- Necessário porque "Automatically expose new tables" fica desmarcado.
grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- =========================================================
-- DADOS DA A FORJA PIZZARIA
-- =========================================================
insert into configuracoes
  (nome_loja, endereco_retirada, latitude, longitude,
   preco_pizza, acrescimo_dois_sabores, max_sabores, chave_pix, telefone_cozinha)
values
  ('A Forja Pizzaria',
   'Avenida Rui Barbosa, Qd 06, Lote 01, Setor Cristina',
   null, null,          -- TODO: preencher com as coordenadas do Google Maps
   34.99, 5.00, 2,
   null,                -- TODO: preencher com a chave Pix
   null);               -- TODO: WhatsApp da cozinha, só números com 55 + DDD

-- Libera o bot por 7 dias a partir de agora (período de teste)
update configuracoes set ativo_ate = now() + interval '7 days' where id = 1;

insert into horarios (dia_semana, abre, fecha, aberto) values
  (0, '18:30', '23:00', true),   -- domingo
  (1, null,    null,    false),  -- segunda (fechado)
  (2, null,    null,    false),  -- terça (fechado)
  (3, '18:30', '23:30', true),   -- quarta
  (4, '18:30', '23:30', true),   -- quinta
  (5, '18:30', '02:00', true),   -- sexta (até 2h de sábado)
  (6, '18:30', '02:00', true);   -- sábado (até 2h de domingo)

insert into sabores (nome, ordem) values
  ('Calabresa', 1), ('Frango com Catupiry', 2), ('Carne Seca', 3),
  ('Bacon', 4), ('Marguerita', 5), ('Mussarela', 6),
  ('Calabacon', 7), ('Portuguesa', 8), ('Carne Seca Goiana', 9),
  ('Bacon Especial', 10), ('Carne Seca Cremosa', 11), ('Frango', 12),
  ('Frango com Bacon', 13), ('Presunto', 14), ('Frango Cheddar', 15);

insert into bebidas (nome, preco, ordem) values
  ('Coca-Cola Original 350ml', 5.99, 1),
  ('Coca-Cola Zero Açúcar 350ml', 5.99, 2),
  ('Sprite 350ml', 5.99, 3),
  ('Coca-Cola Original 1L', 9.99, 4),
  ('Coca-Cola Original 2L', 15.99, 5),
  ('Coca-Cola Zero Açúcar 2L', 15.99, 6),
  ('Fanta Laranja 2L', 14.99, 7),
  ('Sprite 2L', 14.99, 8);

-- EXEMPLO de faixas: ajuste com os valores reais da pizzaria
insert into faixas_entrega (ate_km, taxa) values
  (2, 5.00), (4, 7.00), (6, 10.00), (8, 13.00);
