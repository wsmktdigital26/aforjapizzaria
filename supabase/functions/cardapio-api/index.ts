// deno-lint-ignore-file no-explicit-any
// A Forja Pizzaria — Edge Function "cardapio-api"
// Recebe os pedidos do cardápio digital e atende o painel da cozinha.
// Cole no index.ts de uma função nova chamada cardapio-api e desligue o Verify JWT.

import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const SENHA_PAINEL = Deno.env.get("PAINEL_SENHA") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-painel-senha",
};
const json = (dados: unknown, status = 200) =>
  new Response(JSON.stringify(dados), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const erro = (msg: string, status = 400) => json({ erro: msg }, status);

const arred = (v: number) => Math.round(v * 100) / 100;
const soDigitos = (s: unknown) => String(s ?? "").replace(/\D/g, "");
const texto = (s: unknown, max: number) => String(s ?? "").trim().slice(0, max);

function normalizaTelefone(t: unknown) {
  let d = soDigitos(t);
  if (d.length === 10 || d.length === 11) d = "55" + d;
  return d.length === 12 || d.length === 13 ? d : null;
}

// =========================================================
// TAXA DE ENTREGA POR DISTÂNCIA
// =========================================================
function distanciaKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371, rad = (g: number) => (g * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

async function calcularTaxa(config: any, lat: number, lng: number) {
  if (config.latitude == null || config.longitude == null) return { erro: "sem_coordenadas" };
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return { erro: "local_invalido" };
  const { data: faixas } = await db.from("faixas_entrega").select("ate_km, taxa").order("ate_km");
  const lista = faixas ?? [];
  const dist = distanciaKm(Number(config.latitude), Number(config.longitude), lat, lng) * Number(config.fator_rota ?? 1.3);
  const km = Math.round(dist * 10) / 10;
  const faixa = lista.find((f: any) => Math.ceil(dist) <= Number(f.ate_km));
  const max = lista.length ? Number(lista[lista.length - 1].ate_km) : 0;
  if (!faixa) return { fora: true, distancia: km, max };
  return { distancia: km, taxa: Number(faixa.taxa) };
}

async function rotaCalcularTaxa(b: any) {
  const { data: config } = await db.from("configuracoes").select("latitude, longitude, fator_rota").eq("id", 1).single();
  if (!config) return erro("Loja não configurada.", 500);
  const r: any = await calcularTaxa(config, Number(b?.lat), Number(b?.lng));
  if (r.erro) return erro(r.erro === "sem_coordenadas" ? "Cálculo de taxa indisponível." : "Localização inválida.", 400);
  return json(r);
}

const STATUS_VALIDOS = [
  "aguardando_pagamento", "recebido", "em_preparo", "saiu_entrega", "pronto_retirada", "entregue", "cancelado",
];

// =========================================================
// PEDIDO VINDO DO CARDÁPIO (público)
// =========================================================
async function criarPedido(b: any) {
  const nome = texto(b.nome, 80);
  const telefone = normalizaTelefone(b.telefone);
  if (!nome) return erro("Informe seu nome.");
  if (!telefone) return erro("Informe um WhatsApp válido com DDD.");

  const tipo = b.tipo === "retirada" ? "retirada" : "entrega";
  const pagamento = ({ pix: "pix", cartao: "cartao", dinheiro: "dinheiro" } as any)[b.pagamento];
  if (!pagamento) return erro("Escolha a forma de pagamento.");
  if (!Array.isArray(b.itens) || b.itens.length === 0 || b.itens.length > 30) return erro("A sacola está vazia.");

  const [{ data: config }, { data: sabores }, { data: bebidas }] = await Promise.all([
    db.from("configuracoes").select("*").eq("id", 1).single(),
    db.from("sabores").select("nome").eq("ativo", true),
    db.from("bebidas").select("nome, preco, ordem").eq("ativo", true),
  ]);
  if (!config) return erro("Loja não configurada.", 500);
  if (config.ativo_ate && new Date() > new Date(config.ativo_ate)) {
    return erro("Pedidos online indisponíveis no momento.", 403);
  }

  // Preços sempre calculados aqui, com os valores do banco
  const nomesSabores = new Set((sabores ?? []).map((s: any) => s.nome.toLowerCase()));
  const maxSabores = Number(config.max_sabores) || 2;
  const itens: any[] = [];

  for (const it of b.itens) {
    const qtd = Math.min(20, Math.max(1, parseInt(it?.qtd) || 1));
    if (it?.tipo === "pizza") {
      const sab = (Array.isArray(it.sabores) ? it.sabores : []).map((s: unknown) => texto(s, 60)).slice(0, maxSabores);
      if (!sab.length || sab.some((s: string) => !nomesSabores.has(s.toLowerCase()))) {
        return erro(`Sabor indisponível: ${sab.join(" / ") || "não informado"}.`);
      }
      const preco = arred(Number(config.preco_pizza) + (sab.length > 1 ? Number(config.acrescimo_dois_sabores) : 0));
      itens.push({
        tipo: "pizza", descricao: `Pizza Grande ${sab.join(" / ")}`, quantidade: qtd,
        preco_unitario: preco, observacao: texto(it.obs, 200) || null,
      });
    } else if (it?.tipo === "bebida") {
      const beb = (bebidas ?? []).find((x: any) => Number(x.ordem) === Number(it.ordem));
      if (!beb) return erro("Uma das bebidas não está mais disponível.");
      itens.push({ tipo: "bebida", descricao: beb.nome, quantidade: qtd, preco_unitario: Number(beb.preco), observacao: null });
    } else {
      return erro("Item inválido na sacola.");
    }
  }

  const subtotal = arred(itens.reduce((s, i) => s + i.preco_unitario * i.quantidade, 0));

  let endereco: string | null = null;
  let taxa = 0, distancia: number | null = null, lat: number | null = null, lng: number | null = null;
  if (tipo === "entrega" && b.local && b.local.lat != null) {
    const r: any = await calcularTaxa(config, Number(b.local.lat), Number(b.local.lng));
    if (r.fora) return erro(`Você está a ${r.distancia} km e entregamos até ${r.max} km. Escolha retirada no balcão.`);
    if (!r.erro) {
      taxa = r.taxa; distancia = r.distancia;
      lat = Number(b.local.lat); lng = Number(b.local.lng);
    }
  }
  if (tipo === "entrega") {
    const rua = texto(b.endereco?.rua, 150), bairro = texto(b.endereco?.bairro, 80), ref = texto(b.endereco?.ref, 150);
    if (!rua || !bairro) return erro("Informe a rua com número e o bairro.");
    endereco = [rua, bairro, ref ? `Ref.: ${ref}` : ""].filter(Boolean).join(" — ");
  }

  let troco: number | null = null;
  if (pagamento === "dinheiro" && b.troco != null && b.troco !== "") {
    troco = Number(b.troco);
    if (isNaN(troco) || troco < arred(subtotal + taxa)) return erro("O troco precisa ser para um valor maior que o total do pedido.");
  }

  // Cliente
  let { data: cli } = await db.from("clientes").select("id").eq("telefone", telefone).maybeSingle();
  if (!cli) {
    ({ data: cli } = await db.from("clientes").insert({ telefone, nome, ultimo_endereco: endereco }).select("id").single());
  } else {
    await db.from("clientes").update({ nome, ...(endereco ? { ultimo_endereco: endereco } : {}) }).eq("id", cli.id);
  }
  if (!cli) return erro("Não foi possível registrar o cliente.", 500);

  const codigo = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const { data: ped, error } = await db.from("pedidos").insert({
    codigo,
    cliente_id: cli.id,
    tipo_entrega: tipo,
    endereco,
    latitude: lat,
    longitude: lng,
    distancia_km: distancia,
    taxa_entrega: taxa,
    forma_pagamento: pagamento,
    troco_para: troco,
    subtotal,
    total: arred(subtotal + taxa),
    status: "recebido",
    origem: "site",
    observacoes: texto(b.obs, 300) || null,
  }).select("id").single();
  if (error || !ped) {
    console.error("Erro ao gravar pedido:", error);
    return erro("Não foi possível registrar o pedido.", 500);
  }

  const { error: erroItens } = await db.from("itens_pedido").insert(itens.map((i) => ({ ...i, pedido_id: ped.id })));
  if (erroItens) console.error("Erro ao gravar itens:", erroItens);

  return json({ id: ped.id, subtotal, taxa, total: arred(subtotal + taxa), distancia, codigo });
}

// =========================================================
// ACOMPANHAMENTO PELO CLIENTE (público, exige o código do pedido)
// =========================================================
async function acompanhar(url: URL) {
  const id = Number(url.searchParams.get("id"));
  const codigo = String(url.searchParams.get("c") ?? "");
  if (!id || codigo.length < 8) return erro("Pedido não encontrado.", 404);
  const { data: p } = await db.from("pedidos")
    .select("id, codigo, status, tipo_entrega, subtotal, taxa_entrega, total, forma_pagamento, criado_em, itens_pedido(descricao, quantidade)")
    .eq("id", id).maybeSingle();
  if (!p || p.codigo !== codigo) return erro("Pedido não encontrado.", 404);
  const { codigo: _c, ...publico } = p as any;
  return json({ pedido: publico });
}

// =========================================================
// PAINEL DA COZINHA (protegido por senha)
// =========================================================
async function listarPedidos(url: URL) {
  const dias = Math.min(7, Math.max(1, Number(url.searchParams.get("dias")) || 1));
  const desde = new Date(Date.now() - dias * 86400000).toISOString();
  const { data, error } = await db.from("pedidos")
    .select(`id, codigo, criado_em, status, tipo_entrega, endereco, latitude, longitude, distancia_km, forma_pagamento,
             troco_para, subtotal, taxa_entrega, total, origem, observacoes,
             clientes(nome, telefone), itens_pedido(descricao, quantidade, preco_unitario, observacao)`)
    .gte("criado_em", desde)
    .order("criado_em", { ascending: false })
    .limit(200);
  if (error) return erro(error.message, 500);
  return json({ pedidos: data });
}

async function mudarStatus(b: any) {
  const id = Number(b.id);
  if (!id || !STATUS_VALIDOS.includes(b.status)) return erro("Status inválido.");
  const { error } = await db.from("pedidos").update({ status: b.status }).eq("id", id);
  if (error) return erro(error.message, 500);
  return json({ ok: true });
}

async function definirTaxa(b: any) {
  const id = Number(b.id), taxa = arred(Number(b.taxa));
  if (!id || isNaN(taxa) || taxa < 0 || taxa > 200) return erro("Taxa inválida.");
  const { data: ped } = await db.from("pedidos").select("subtotal").eq("id", id).single();
  if (!ped) return erro("Pedido não encontrado.", 404);
  const { error } = await db.from("pedidos")
    .update({ taxa_entrega: taxa, total: arred(Number(ped.subtotal) + taxa) }).eq("id", id);
  if (error) return erro(error.message, 500);
  return json({ ok: true });
}

// =========================================================
// SERVIDOR
// =========================================================
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const acao = url.searchParams.get("acao");

  try {
    if (acao === "pedido" && req.method === "POST") return await criarPedido(await req.json());
    if (acao === "acompanhar" && req.method === "GET") return await acompanhar(url);
    if (acao === "calcular_taxa" && req.method === "POST") return await rotaCalcularTaxa(await req.json());

    // Daqui para baixo, só o painel da cozinha
    if (!SENHA_PAINEL) return erro("Cadastre o segredo PAINEL_SENHA no Supabase.", 500);
    if (req.headers.get("x-painel-senha") !== SENHA_PAINEL) return erro("Senha do painel incorreta.", 401);

    if (acao === "pedidos" && req.method === "GET") return await listarPedidos(url);
    if (acao === "status" && req.method === "POST") return await mudarStatus(await req.json());
    if (acao === "taxa" && req.method === "POST") return await definirTaxa(await req.json());

    return erro("Ação desconhecida.", 404);
  } catch (e) {
    console.error("Erro:", e);
    return erro("Erro interno.", 500);
  }
});
