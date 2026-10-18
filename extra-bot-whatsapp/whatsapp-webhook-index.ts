// deno-lint-ignore-file no-explicit-any
// A Forja Pizzaria — Edge Function "whatsapp-webhook" — v3 (fluxo completo + modo simulador)
// Cole este código no arquivo index.ts da função e clique em Deploy.

import { createClient } from "jsr:@supabase/supabase-js@2";
import { AsyncLocalStorage } from "node:async_hooks";

// Modo simulador: quando ativo, as respostas não vão para a Meta,
// são devolvidas para a página do simulador.
const simulador = new AsyncLocalStorage<{ saida: any[]; ignorarHorario: boolean }>();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, x-simulador-token",
};

const WHATSAPP_TOKEN = Deno.env.get("WHATSAPP_TOKEN")!;
const WHATSAPP_PHONE_ID = Deno.env.get("WHATSAPP_PHONE_ID")!;
const VERIFY_TOKEN = Deno.env.get("WHATSAPP_VERIFY_TOKEN")!;
const GRAPH_URL = `https://graph.facebook.com/v25.0/${WHATSAPP_PHONE_ID}/messages`;

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

// =========================================================
// UTILITÁRIOS
// =========================================================
const brl = (v: number) => "R$ " + Number(v).toFixed(2).replace(".", ",");
const arred = (v: number) => Math.round(v * 100) / 100;
const corta = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + "…");
const soDigitos = (s: string) => (s ?? "").replace(/\D/g, "");

// Compara números ignorando o 9 extra dos celulares brasileiros
function mesmoNumero(a: string, b: string) {
  const x = soDigitos(a), y = soDigitos(b);
  if (!x || !y) return false;
  return x.slice(0, 4) === y.slice(0, 4) && x.slice(-8) === y.slice(-8);
}

const STATUS_TEXTO: Record<string, string> = {
  aguardando_pagamento: "aguardando a confirmação do Pix",
  recebido: "recebido, já na fila da cozinha",
  em_preparo: "em preparo",
  saiu_entrega: "saiu para entrega",
  pronto_retirada: "pronto para retirada",
  entregue: "entregue",
  cancelado: "cancelado",
};

// =========================================================
// ENVIO DE MENSAGENS (WhatsApp Cloud API)
// =========================================================
async function enviar(para: string, conteudo: Record<string, unknown>) {
  const sim = simulador.getStore();
  if (sim) {
    sim.saida.push({ para, ...conteudo });
    return;
  }
  const r = await fetch(GRAPH_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: para, ...conteudo }),
  });
  if (!r.ok) console.error("Erro ao enviar:", await r.text());
}

const texto = (para: string, t: string) => enviar(para, { type: "text", text: { body: t } });

function botoes(para: string, t: string, opcoes: [string, string][]) {
  return enviar(para, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: t },
      action: {
        buttons: opcoes.slice(0, 3).map(([id, titulo]) => ({
          type: "reply",
          reply: { id, title: corta(titulo, 20) },
        })),
      },
    },
  });
}

function lista(para: string, t: string, rotulo: string, linhas: { id: string; titulo: string; descricao?: string }[]) {
  return enviar(para, {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: t },
      action: {
        button: corta(rotulo, 20),
        sections: [{
          title: "Opções",
          rows: linhas.slice(0, 10).map((l) => ({
            id: l.id,
            title: corta(l.titulo, 24),
            ...(l.descricao ? { description: corta(l.descricao, 72) } : {}),
          })),
        }],
      },
    },
  });
}

const imagem = (para: string, link: string, legenda: string) =>
  enviar(para, { type: "image", image: { link, caption: legenda } });

const pedirLocalizacao = (para: string, t: string) =>
  enviar(para, {
    type: "interactive",
    interactive: { type: "location_request_message", body: { text: t }, action: { name: "send_location" } },
  });

// =========================================================
// HORÁRIO DE FUNCIONAMENTO (fuso de Brasília)
// =========================================================
function agoraBrasilia() {
  const partes = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const pega = (t: string) => partes.find((p) => p.type === t)!.value;
  const dia = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(pega("weekday"));
  const hora = Number(pega("hour")) % 24;
  return { dia, min: hora * 60 + Number(pega("minute")) };
}

const paraMin = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

function lojaAberta(horarios: any[]) {
  const { dia, min } = agoraBrasilia();
  const hoje = horarios.find((h) => h.dia_semana === dia);
  const ontem = horarios.find((h) => h.dia_semana === (dia + 6) % 7);
  if (hoje?.aberto && hoje.abre && hoje.fecha) {
    const a = paraMin(hoje.abre), f = paraMin(hoje.fecha);
    if (f > a ? min >= a && min < f : min >= a) return true;
  }
  // Expediente de ontem que passou da meia-noite (ex.: sexta até 02:00)
  if (ontem?.aberto && ontem.abre && ontem.fecha) {
    const a = paraMin(ontem.abre), f = paraMin(ontem.fecha);
    if (f <= a && min < f) return true;
  }
  return false;
}

function textoHorarios(horarios: any[]) {
  const nomes = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
  const ordem = [1, 2, 3, 4, 5, 6, 0];
  return ordem
    .map((d) => horarios.find((h) => h.dia_semana === d))
    .filter((h) => h?.aberto)
    .map((h) => `${nomes[h.dia_semana]}: ${h.abre.slice(0, 5)} às ${h.fecha.slice(0, 5)}`)
    .join("\n");
}

// =========================================================
// DISTÂNCIA E PIX
// =========================================================
function distanciaKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371;
  const rad = (g: number) => (g * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function pixCopiaECola(chave: string, valor: number, nome: string, cidade: string, txid: string) {
  const campo = (id: string, v: string) => id + String(v.length).padStart(2, "0") + v;
  const limpa = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
  const conta = campo("00", "br.gov.bcb.pix") + campo("01", chave);
  let p = campo("00", "01") + campo("26", conta) + campo("52", "0000") + campo("53", "986") +
    campo("54", valor.toFixed(2)) + campo("58", "BR") + campo("59", limpa(nome).slice(0, 25)) +
    campo("60", limpa(cidade).slice(0, 15)) + campo("62", campo("05", txid)) + "6304";
  let crc = 0xffff;
  for (const c of new TextEncoder().encode(p)) {
    crc ^= c << 8;
    for (let i = 0; i < 8; i++) crc = (crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xffff;
  }
  return p + crc.toString(16).toUpperCase().padStart(4, "0");
}

// =========================================================
// LEITURA DA MENSAGEM RECEBIDA
// =========================================================
function lerEntrada(msg: any) {
  if (msg.type === "interactive") {
    const r = msg.interactive?.button_reply ?? msg.interactive?.list_reply;
    return { tipo: "opcao", id: r?.id as string, titulo: r?.title as string };
  }
  if (msg.type === "text") return { tipo: "texto", texto: String(msg.text?.body ?? "").trim() };
  if (msg.type === "location") {
    return {
      tipo: "local",
      lat: Number(msg.location.latitude),
      lng: Number(msg.location.longitude),
      endereco: [msg.location.name, msg.location.address].filter(Boolean).join(" - "),
    };
  }
  if (["image", "document"].includes(msg.type)) return { tipo: "midia" };
  return { tipo: "outro" };
}

// =========================================================
// TELAS DO FLUXO
// =========================================================
const totalPedido = (p: any) => arred(p.itens.reduce((s: number, i: any) => s + i.preco, 0) + (p.taxa ?? 0));

async function mostrarMenu(c: any) {
  const primeiroNome = c.nome ? ", " + c.nome.split(" ")[0] : "";
  c.conv.etapa = "menu";
  await botoes(c.tel, `Olá${primeiroNome}! Bem-vindo à ${c.config.nome_loja}. Como posso ajudar?`, [
    ["m:pedido", "Fazer pedido"],
    ["m:cardapio", "Ver cardápio"],
    ["m:atendente", "Falar com atendente"],
  ]);
}

async function enviarCardapio(c: any) {
  const legenda = `Pizza grande de 8 pedaços: ${brl(c.config.preco_pizza)}\nMeio a meio: + ${brl(c.config.acrescimo_dois_sabores)}`;
  if (c.config.url_cardapio) {
    await imagem(c.tel, c.config.url_cardapio, legenda);
  } else {
    const { data: sab } = await db.from("sabores").select("nome").eq("ativo", true).order("ordem");
    await texto(c.tel, `${legenda}\n\nSabores:\n${(sab ?? []).map((s: any) => "• " + s.nome).join("\n")}`);
  }
  c.conv.etapa = "menu";
  await botoes(c.tel, "Gostou? É só pedir:", [["m:pedido", "Fazer pedido"], ["m:atendente", "Falar com atendente"]]);
}

async function mostrarSabores(c: any, pagina: number, segundo: boolean) {
  const { data: sab } = await db.from("sabores").select("id, nome").eq("ativo", true).order("ordem");
  const todos = sab ?? [];
  const precisaPaginar = todos.length > 10;
  const daPagina = !precisaPaginar ? todos : pagina === 1 ? todos.slice(0, 9) : todos.slice(9, 18);
  const linhas = daPagina.map((s: any) => ({ id: `sab:${s.id}`, titulo: s.nome }));
  if (precisaPaginar) {
    linhas.push(pagina === 1
      ? { id: "sab:mais", titulo: "Ver mais sabores" }
      : { id: "sab:voltar", titulo: "Voltar aos primeiros" });
  }
  const t = segundo
    ? "Escolha o sabor da outra metade:"
    : `Pizza grande de 8 pedaços: ${brl(c.config.preco_pizza)}.\nEscolha o sabor:`;
  c.conv.etapa = segundo ? "sabor2" : "sabor1";
  await lista(c.tel, t, "Ver sabores", linhas);
}

async function adicionarPizza(c: any) {
  const p = c.p;
  const meio = !!p.atual?.s2;
  const preco = arred(Number(c.config.preco_pizza) + (meio ? Number(c.config.acrescimo_dois_sabores) : 0));
  const descricao = `Pizza Grande ${p.atual.s1}${meio ? " / " + p.atual.s2 : ""}`;
  p.itens.push({ tipo: "pizza", descricao, preco });
  delete p.atual;
  await perguntarMais(c, `${descricao} adicionada: ${brl(preco)}.`);
}

async function perguntarMais(c: any, prefixo: string) {
  c.conv.etapa = "mais";
  await botoes(c.tel, `${prefixo}\n\nDeseja mais alguma coisa?`, [
    ["mais:pizza", "Outra pizza"],
    ["mais:bebida", "Bebida"],
    ["mais:fim", "Finalizar pedido"],
  ]);
}

async function mostrarBebidas(c: any) {
  const { data: beb } = await db.from("bebidas").select("id, nome, preco").eq("ativo", true).order("ordem");
  c.conv.etapa = "bebida";
  await lista(c.tel, "Escolha a bebida:", "Ver bebidas",
    (beb ?? []).map((b: any) => ({ id: `beb:${b.id}`, titulo: b.nome, descricao: `${b.nome} · ${brl(b.preco)}` })));
}

async function perguntarEntrega(c: any) {
  c.conv.etapa = "entrega";
  await botoes(c.tel, "Vai ser entrega ou retirada no balcão?", [["ent:entrega", "Entrega"], ["ent:retirada", "Retirada"]]);
}

async function perguntarLocalizacao(c: any) {
  c.conv.etapa = "localizacao";
  await pedirLocalizacao(c.tel,
    "Para calcular a taxa de entrega, envie sua localização tocando no botão abaixo.\n\nSe preferir, toque no clipe 📎, depois em Localização.");
}

async function perguntarPagamento(c: any) {
  c.conv.etapa = "pagamento";
  await botoes(c.tel, `Total: ${brl(totalPedido(c.p))}.\nComo vai pagar?`, [
    ["pg:pix", "Pix"],
    ["pg:cartao", "Cartão"],
    ["pg:dinheiro", "Dinheiro"],
  ]);
}

function textoResumo(p: any) {
  const linhas = p.itens.map((i: any) => `• ${i.descricao} · ${brl(i.preco)}`).join("\n");
  const entrega = p.tipo === "entrega"
    ? `Entrega: ${brl(p.taxa)}\nEndereço: ${p.endereco}`
    : "Retirada no balcão";
  const pag = p.pagamento === "pix" ? "Pix"
    : p.pagamento === "cartao" ? "Cartão (maquininha)"
    : `Dinheiro${p.troco ? ", troco para " + brl(p.troco) : ", sem troco"}`;
  return `${linhas}\n\n${entrega}\nPagamento: ${pag}\n*Total: ${brl(totalPedido(p))}*`;
}

async function mostrarResumo(c: any) {
  c.conv.etapa = "confirmar";
  await botoes(c.tel, `*Resumo do pedido*\n\n${textoResumo(c.p)}`, [
    ["conf:sim", "Confirmar pedido"],
    ["conf:alterar", "Alterar pedido"],
    ["m:cancelar", "Cancelar"],
  ]);
}

// =========================================================
// COZINHA
// =========================================================
function botoesCozinha(id: number, status: string, tipo: string): [string, string][] {
  const pronto: [string, string] = tipo === "entrega"
    ? [`st:${id}:saiu_entrega`, "Saiu p/ entrega"]
    : [`st:${id}:pronto_retirada`, "Pronto p/ retirar"];
  if (status === "aguardando_pagamento") return [[`st:${id}:recebido`, "Pix confirmado"], [`st:${id}:cancelado`, "Cancelar"]];
  if (status === "recebido") return [[`st:${id}:em_preparo`, "Em preparo"], pronto, [`st:${id}:cancelado`, "Cancelar"]];
  if (status === "em_preparo") return [pronto, [`st:${id}:cancelado`, "Cancelar"]];
  if (status === "saiu_entrega" || status === "pronto_retirada") return [[`st:${id}:entregue`, "Entregue"]];
  return [];
}

async function avisarCozinha(config: any, t: string, opcoes: [string, string][] = []) {
  if (!config.telefone_cozinha) return;
  const para = soDigitos(config.telefone_cozinha);
  if (opcoes.length) await botoes(para, t, opcoes);
  else await texto(para, t);
}

async function mudarStatus(idBotao: string, telCozinha: string) {
  const [, idTxt, status] = idBotao.split(":");
  const id = Number(idTxt);
  const { data: ped } = await db.from("pedidos")
    .update({ status }).eq("id", id)
    .select("id, status, tipo_entrega, clientes(telefone)").single();
  if (!ped) return texto(telCozinha, `Pedido nº ${id} não encontrado.`);

  const telCliente = (ped as any).clientes?.telefone;
  const avisos: Record<string, string> = {
    recebido: `Pagamento confirmado! Seu pedido nº ${id} já foi para a cozinha.`,
    em_preparo: `Seu pedido nº ${id} está sendo preparado. 🍕`,
    saiu_entrega: `Seu pedido nº ${id} saiu para entrega! Logo chega aí.`,
    pronto_retirada: `Seu pedido nº ${id} está pronto para retirada no balcão.`,
    cancelado: `Seu pedido nº ${id} foi cancelado. Se tiver dúvidas, é só responder esta mensagem.`,
  };
  if (telCliente && avisos[status]) await texto(telCliente, avisos[status]);

  const proximos = botoesCozinha(id, status, ped.tipo_entrega);
  if (proximos.length) await botoes(telCozinha, `Pedido nº ${id}: ${STATUS_TEXTO[status]}.`, proximos);
  else await texto(telCozinha, `Pedido nº ${id} finalizado (${STATUS_TEXTO[status]}).`);
}

// =========================================================
// CRIAÇÃO DO PEDIDO
// =========================================================
async function criarPedido(c: any) {
  const p = c.p;
  const subtotal = arred(p.itens.reduce((s: number, i: any) => s + i.preco, 0));
  const total = totalPedido(p);
  const status = p.pagamento === "pix" ? "aguardando_pagamento" : "recebido";

  const { data: ped, error } = await db.from("pedidos").insert({
    cliente_id: c.cliente.id,
    tipo_entrega: p.tipo,
    endereco: p.endereco ?? null,
    latitude: p.lat ?? null,
    longitude: p.lng ?? null,
    distancia_km: p.distancia ?? null,
    taxa_entrega: p.taxa ?? 0,
    forma_pagamento: p.pagamento,
    troco_para: p.troco ?? null,
    subtotal,
    total,
    status,
  }).select("id").single();

  if (error || !ped) {
    console.error("Erro ao salvar pedido:", error);
    await texto(c.tel, "Ops, tivemos um problema ao registrar seu pedido. Tente confirmar de novo em instantes.");
    return;
  }

  await db.from("itens_pedido").insert(p.itens.map((i: any) => ({
    pedido_id: ped.id, tipo: i.tipo, descricao: i.descricao, quantidade: 1, preco_unitario: i.preco,
  })));

  const previsao = p.tipo === "entrega" ? "40 a 50 minutos" : "cerca de 30 minutos";
  await texto(c.tel, `✅ Pedido nº ${ped.id} confirmado!\nPrevisão: ${previsao}.\n\nVocê vai receber as atualizações por aqui.`);

  if (p.pagamento === "pix") {
    if (c.config.chave_pix) {
      await texto(c.tel, `Pague ${brl(total)} com o Pix copia e cola abaixo e depois envie o comprovante por aqui:`);
      await texto(c.tel, pixCopiaECola(c.config.chave_pix, total, c.config.nome_loja, c.config.cidade ?? "BRASIL", `AFORJA${ped.id}`));
    } else {
      await texto(c.tel, "Em instantes enviamos a chave Pix. Depois de pagar, envie o comprovante por aqui.");
    }
  }

  const mapa = p.lat ? `\nMapa: https://maps.google.com/?q=${p.lat},${p.lng}` : "";
  await avisarCozinha(c.config,
    `🔔 *Novo pedido nº ${ped.id}*\nCliente: ${c.nome || "sem nome"} (+${c.tel})\n\n${textoResumo(p)}${mapa}`,
    botoesCozinha(ped.id, status, p.tipo));

  c.conv.etapa = "pos_pedido";
  c.conv.pedido_parcial = { ultimo_pedido: ped.id };
}

// =========================================================
// MÁQUINA DE ESTADOS
// =========================================================
async function reperguntar(c: any) {
  const e = c.conv.etapa;
  if (e === "sabor1") return mostrarSabores(c, 1, false);
  if (e === "sabor2") return mostrarSabores(c, 1, true);
  if (e === "dois") return perguntarDois(c);
  if (e === "mais") return perguntarMais(c, "Não entendi.");
  if (e === "bebida") return mostrarBebidas(c);
  if (e === "entrega") return perguntarEntrega(c);
  if (e === "localizacao") return perguntarLocalizacao(c);
  if (e === "endereco") return texto(c.tel, "Escreva o endereço completo: rua, número, quadra/lote e um ponto de referência.");
  if (e === "pagamento") return perguntarPagamento(c);
  if (e === "troco") return perguntarTroco(c);
  if (e === "confirmar") return mostrarResumo(c);
  return mostrarMenu(c);
}

async function perguntarDois(c: any) {
  c.conv.etapa = "dois";
  await botoes(c.tel,
    `${c.p.atual.s1} anotada! Quer fazer meio a meio com outro sabor? (+ ${brl(c.config.acrescimo_dois_sabores)})`,
    [["dois:nao", "Só esse sabor"], ["dois:sim", "Meio a meio"]]);
}

async function perguntarTroco(c: any) {
  c.conv.etapa = "troco";
  await botoes(c.tel,
    `O total é ${brl(totalPedido(c.p))}. Vai precisar de troco? Digite para quanto (ex.: 100) ou toque no botão.`,
    [["troco:nao", "Não preciso"]]);
}

async function invalido(c: any) {
  c.conv.tentativas_invalidas = (c.conv.tentativas_invalidas ?? 0) + 1;
  if (c.conv.tentativas_invalidas >= 3) {
    c.conv.tentativas_invalidas = 0;
    await botoes(c.tel, "Parece que não estou entendendo. Quer falar com um atendente?", [
      ["m:atendente", "Falar com atendente"],
      ["m:menu", "Voltar ao menu"],
    ]);
    return;
  }
  await reperguntar(c);
}

async function executar(c: any, e: any) {
  const p = c.p;
  const id: string = e.tipo === "opcao" ? e.id ?? "" : "";
  const txt: string = e.tipo === "texto" ? e.texto.toLowerCase() : "";

  // ---------- Comandos que valem em qualquer etapa ----------
  if (["menu", "cancelar", "sair", "voltar", "inicio", "início"].includes(txt)) {
    c.conv.pedido_parcial = {};
    return mostrarMenu(c);
  }
  if (id.startsWith("m:")) {
    const acao = id.slice(2);
    if (acao === "pedido" || acao === "novo") {
      c.conv.pedido_parcial = { itens: [] };
      c.p = c.conv.pedido_parcial;
      return mostrarSabores(c, 1, false);
    }
    if (acao === "cardapio") return enviarCardapio(c);
    if (acao === "atendente") {
      c.conv.etapa = "inicio";
      await texto(c.tel,
        `Certo! Um atendente vai falar com você pelo WhatsApp da loja: ${c.config.telefone_loja ?? ""}.\nSe preferir, pode chamar direto por lá.`);
      await avisarCozinha(c.config,
        `🙋 ${c.nome || "Um cliente"} pediu atendimento humano.\nChamar: https://wa.me/${c.tel}`);
      return;
    }
    if (acao === "cancelar") {
      c.conv.pedido_parcial = {};
      await texto(c.tel, "Pedido cancelado. Quando quiser, é só chamar!");
      c.conv.etapa = "inicio";
      return;
    }
    return mostrarMenu(c);
  }

  // ---------- Etapas ----------
  switch (c.conv.etapa) {
    case "sabor1":
    case "sabor2": {
      const segundo = c.conv.etapa === "sabor2";
      if (id === "sab:mais") return mostrarSabores(c, 2, segundo);
      if (id === "sab:voltar") return mostrarSabores(c, 1, segundo);
      if (id.startsWith("sab:")) {
        const { data: s } = await db.from("sabores").select("nome").eq("id", Number(id.slice(4))).single();
        if (!s) return invalido(c);
        if (!segundo) {
          p.atual = { s1: s.nome };
          if (Number(c.config.max_sabores) < 2) return adicionarPizza(c);
          return perguntarDois(c);
        }
        p.atual.s2 = s.nome;
        return adicionarPizza(c);
      }
      return invalido(c);
    }

    case "dois":
      if (id === "dois:nao") return adicionarPizza(c);
      if (id === "dois:sim") return mostrarSabores(c, 1, true);
      return invalido(c);

    case "mais":
      if (id === "mais:pizza") return mostrarSabores(c, 1, false);
      if (id === "mais:bebida") return mostrarBebidas(c);
      if (id === "mais:fim") return perguntarEntrega(c);
      return invalido(c);

    case "bebida":
      if (id.startsWith("beb:")) {
        const { data: b } = await db.from("bebidas").select("nome, preco").eq("id", Number(id.slice(4))).single();
        if (!b) return invalido(c);
        p.itens.push({ tipo: "bebida", descricao: b.nome, preco: Number(b.preco) });
        return perguntarMais(c, `${b.nome} adicionada: ${brl(b.preco)}.`);
      }
      return invalido(c);

    case "entrega":
      if (id === "ent:retirada") {
        p.tipo = "retirada";
        p.taxa = 0;
        delete p.lat; delete p.lng; delete p.distancia; delete p.endereco;
        await texto(c.tel, `Retirada no balcão: ${c.config.endereco_retirada}.`);
        return perguntarPagamento(c);
      }
      if (id === "ent:entrega") {
        p.tipo = "entrega";
        return perguntarLocalizacao(c);
      }
      return invalido(c);

    case "localizacao": {
      if (e.tipo !== "local") return invalido(c);
      const { data: faixas } = await db.from("faixas_entrega").select("ate_km, taxa").order("ate_km");
      const lista_ = faixas ?? [];
      let dist: number | null = null;
      let taxa: number;
      if (c.config.latitude != null && c.config.longitude != null) {
        dist = distanciaKm(Number(c.config.latitude), Number(c.config.longitude), e.lat, e.lng) *
          Number(c.config.fator_rota ?? 1.3);
        const faixa = lista_.find((f: any) => dist! <= Number(f.ate_km));
        if (!faixa) {
          const max = lista_.length ? Number(lista_[lista_.length - 1].ate_km) : 0;
          c.conv.etapa = "entrega";
          return botoes(c.tel,
            `Que pena! Você está a ${dist.toFixed(1)} km e nossa área de entrega vai até ${max} km. Quer retirar no balcão?`,
            [["ent:retirada", "Retirar no balcão"], ["m:cancelar", "Cancelar pedido"]]);
        }
        taxa = Number(faixa.taxa);
      } else {
        console.warn("Coordenadas da pizzaria não configuradas: usando a menor taxa.");
        taxa = lista_.length ? Number(lista_[0].taxa) : 0;
      }
      p.lat = e.lat; p.lng = e.lng; p.taxa = taxa;
      p.distancia = dist != null ? arred(dist) : null;
      c.conv.etapa = "endereco";
      const distTxt = dist != null ? `Você está a ${dist.toFixed(1)} km. ` : "";
      const pergunta = `${distTxt}Taxa de entrega: ${brl(taxa)}.\n\nAgora escreva o endereço completo: rua, número, quadra/lote e um ponto de referência.`;
      if (c.cliente.ultimo_endereco) {
        return botoes(c.tel, `${pergunta}\n\nOu use o último endereço:\n${c.cliente.ultimo_endereco}`,
          [["end:anterior", "Usar esse endereço"]]);
      }
      return texto(c.tel, pergunta);
    }

    case "endereco":
      if (id === "end:anterior" && c.cliente.ultimo_endereco) {
        p.endereco = c.cliente.ultimo_endereco;
        return perguntarPagamento(c);
      }
      if (e.tipo === "texto" && e.texto.length >= 5) {
        p.endereco = e.texto;
        await db.from("clientes").update({ ultimo_endereco: e.texto }).eq("id", c.cliente.id);
        return perguntarPagamento(c);
      }
      return invalido(c);

    case "pagamento":
      if (id === "pg:pix") { p.pagamento = "pix"; p.troco = null; return mostrarResumo(c); }
      if (id === "pg:cartao") { p.pagamento = "cartao"; p.troco = null; return mostrarResumo(c); }
      if (id === "pg:dinheiro") { p.pagamento = "dinheiro"; return perguntarTroco(c); }
      return invalido(c);

    case "troco": {
      if (id === "troco:nao") { p.troco = null; return mostrarResumo(c); }
      if (e.tipo === "texto") {
        const v = Number(e.texto.replace(/[^\d,.]/g, "").replace(",", "."));
        if (!isNaN(v) && v >= totalPedido(p)) { p.troco = arred(v); return mostrarResumo(c); }
        return texto(c.tel, `Informe um valor igual ou maior que ${brl(totalPedido(p))}, ou toque em "Não preciso".`);
      }
      return invalido(c);
    }

    case "confirmar":
      if (id === "conf:sim") return criarPedido(c);
      if (id === "conf:alterar") {
        c.conv.pedido_parcial = { itens: [] };
        c.p = c.conv.pedido_parcial;
        await texto(c.tel, "Sem problemas! Vamos montar o pedido de novo.");
        return mostrarSabores(c, 1, false);
      }
      return invalido(c);

    case "pos_pedido": {
      const idPed = p.ultimo_pedido;
      const { data: ped } = idPed
        ? await db.from("pedidos").select("id, status, total, tipo_entrega").eq("id", idPed).single()
        : { data: null };
      if (ped && e.tipo === "midia" && ped.status === "aguardando_pagamento") {
        await texto(c.tel, "Comprovante recebido! Assim que conferirmos, seu pedido vai para a cozinha.");
        return avisarCozinha(c.config,
          `💸 O cliente do pedido nº ${ped.id} enviou o comprovante do Pix. Confira no app do banco se entrou ${brl(ped.total)}.`,
          botoesCozinha(ped.id, ped.status, ped.tipo_entrega));
      }
      if (ped) {
        return botoes(c.tel, `Seu pedido nº ${ped.id} está: *${STATUS_TEXTO[ped.status]}*.\nPrecisa de algo?`, [
          ["m:novo", "Novo pedido"],
          ["m:atendente", "Falar com atendente"],
        ]);
      }
      return mostrarMenu(c);
    }

    default: // "inicio" e "menu"
      return mostrarMenu(c);
  }
}

// =========================================================
// PROCESSAMENTO DE CADA MENSAGEM
// =========================================================
async function processar(valor: any) {
  const msg = valor?.messages?.[0];
  if (!msg) return; // avisos de status (enviado, entregue, lido)

  const tel: string = msg.from; // pode vir sem o 9 (ex.: 556296389017)
  const nome: string = valor?.contacts?.[0]?.profile?.name ?? "";
  const e = lerEntrada(msg);

  const [{ data: config }, { data: horarios }] = await Promise.all([
    db.from("configuracoes").select("*").eq("id", 1).single(),
    db.from("horarios").select("*"),
  ]);
  if (!config) return console.error("Tabela configuracoes vazia.");

  // Botões de status enviados pela cozinha
  if (e.tipo === "opcao" && e.id?.startsWith("st:") && config.telefone_cozinha &&
      mesmoNumero(tel, config.telefone_cozinha)) {
    return mudarStatus(e.id, tel);
  }

  // Cliente e conversa
  let { data: cliente } = await db.from("clientes").select("*").eq("telefone", tel).maybeSingle();
  if (!cliente) {
    ({ data: cliente } = await db.from("clientes").insert({ telefone: tel, nome }).select("*").single());
  } else if (nome && cliente.nome !== nome) {
    await db.from("clientes").update({ nome }).eq("id", cliente.id);
  }
  let { data: conv } = await db.from("conversas").select("*").eq("cliente_id", cliente.id).maybeSingle();
  if (!conv) {
    ({ data: conv } = await db.from("conversas").insert({ cliente_id: cliente.id }).select("*").single());
  }

  // A Meta às vezes reenvia a mesma mensagem: processa só uma vez
  if (conv.ultima_msg_id === msg.id) return;
  conv.ultima_msg_id = msg.id;

  const c: any = { tel, nome, config, cliente, conv, p: conv.pedido_parcial ?? {} };
  conv.pedido_parcial = c.p;
  const tentativasAntes = conv.tentativas_invalidas;

  try {
    if (!config.ativo_ate || new Date() > new Date(config.ativo_ate)) {
      // Período de teste encerrado
      await texto(tel, `No momento nosso atendimento automático está indisponível. Para pedir, chame no ${config.telefone_loja ?? "WhatsApp da loja"}.`);
    } else if (!simulador.getStore()?.ignorarHorario && !lojaAberta(horarios ?? []) && conv.etapa !== "pos_pedido") {
      conv.etapa = "inicio";
      conv.pedido_parcial = {};
      await texto(tel, `Olá! A ${config.nome_loja} está fechada agora.\n\nNosso horário:\n${textoHorarios(horarios ?? [])}\n\nTe esperamos! 🍕`);
    } else {
      await executar(c, e);
    }
  } catch (err) {
    console.error("Erro no fluxo:", err);
    await texto(tel, "Ops, algo deu errado. Digite *menu* para recomeçar.");
  }

  // Zera as tentativas quando a resposta foi válida
  if (conv.tentativas_invalidas === tentativasAntes) conv.tentativas_invalidas = 0;

  await db.from("conversas").update({
    etapa: conv.etapa,
    pedido_parcial: conv.pedido_parcial,
    tentativas_invalidas: conv.tentativas_invalidas,
    ultima_msg_id: conv.ultima_msg_id,
    atualizado_em: new Date().toISOString(),
  }).eq("cliente_id", cliente.id);
}

// =========================================================
// SERVIDOR
// =========================================================
Deno.serve(async (req) => {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  if (req.method === "GET") {
    const ok = url.searchParams.get("hub.mode") === "subscribe" &&
      url.searchParams.get("hub.verify_token") === VERIFY_TOKEN;
    const desafio = url.searchParams.get("hub.challenge");
    return ok && desafio ? new Response(desafio, { status: 200 }) : new Response("Token inválido", { status: 403 });
  }

  // ---------- Modo simulador (página de testes) ----------
  if (req.method === "POST" && url.searchParams.get("simulador") === "1") {
    const json = (dados: unknown, status = 200) =>
      new Response(JSON.stringify(dados), { status, headers: { ...CORS, "Content-Type": "application/json" } });
    if (req.headers.get("x-simulador-token") !== VERIFY_TOKEN) return json({ erro: "Senha do simulador inválida" }, 401);

    let corpo: any;
    try { corpo = await req.json(); } catch { return json({ erro: "JSON inválido" }, 400); }
    const telefone = soDigitos(corpo.telefone);
    if (!telefone || !corpo.mensagem) return json({ erro: "Informe telefone e mensagem" }, 400);

    const valor = {
      contacts: [{ wa_id: telefone, profile: { name: corpo.nome ?? "" } }],
      messages: [{ from: telefone, id: corpo.mensagem.id ?? crypto.randomUUID(), ...corpo.mensagem }],
    };
    const store = { saida: [] as any[], ignorarHorario: !!corpo.ignorarHorario };
    try {
      await simulador.run(store, () => processar(valor));
    } catch (e) {
      console.error("Erro no simulador:", e);
      return json({ erro: String(e), mensagens: store.saida }, 500);
    }
    return json({ mensagens: store.saida });
  }

  // ---------- Mensagens reais do WhatsApp ----------
  if (req.method === "POST") {
    let corpo: any = null;
    try { corpo = await req.json(); } catch { return new Response("ok", { status: 200 }); }
    const valor = corpo?.entry?.[0]?.changes?.[0]?.value;
    const tarefa = processar(valor).catch((e) => console.error("Erro ao processar:", e));
    // Responde 200 na hora e continua processando em segundo plano
    const rt = (globalThis as any).EdgeRuntime;
    if (rt?.waitUntil) rt.waitUntil(tarefa);
    else await tarefa;
    return new Response("ok", { status: 200 });
  }

  return new Response("Método não permitido", { status: 405, headers: CORS });
});
