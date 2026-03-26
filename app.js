import { initializeApp } from "https://www.gstatic.com/firebasejs/9.23.0/firebase-app.js";
import {
  getDatabase,
  ref,
  onValue,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/9.23.0/firebase-database.js";

const HOST_WHATSAPP_NUMBER = "5561985020209";
const ITEMS_PATH = "items";
const CATEGORY_ORDER = [
  "Fraldas",
  "Higiene e Cuidados",
  "Roupinhas (06 meses)",
  "Banho",
  "Amamentação / Alimentação",
  "Passeio / Transporte",
  "Quarto do Bebê",
  "Mimos (Opcional)",
  "Outros",
];

const firebaseConfig = window.__FIREBASE_CONFIG__;
if (!firebaseConfig || !firebaseConfig.databaseURL) {
  throw new Error("Config do Firebase não carregou. Verifique o env.js.");
}

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

function toSearchText(value = "") {
  return String(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function inferCategory(nome) {
  const value = toSearchText(nome);
  if (/^fralda (rn|p|m|g)|^lenco umedecido/.test(value)) return "Fraldas";
  if (
    /pomada|termometro|sabonete|shampoo|hidratante|oleo|hastes|algodao|kit higiene|kit manicure|aspirador nasal|massageador de gengiva|alcool em gel/.test(
      value
    )
  ) {
    return "Higiene e Cuidados";
  }
  if (
    /body|calca\/mijao|macacao|macaquinho|pijama|casaquinho|meias|touca|luvas|saida maternidade/.test(
      value
    )
  ) {
    return "Roupinhas (06 meses)";
  }
  if (/toalha|banheira|rede\/almofada de banho|trocador$/.test(value)) {
    return "Banho";
  }
  if (
    /panos de boca|fralda de ombro|babadores|mamadeiras|escova para mamadeira|aquecedor|esterilizador/.test(
      value
    )
  ) {
    return "Amamentação / Alimentação";
  }
  if (/bolsa maternidade|frasqueira|trocador portatil|canguru/.test(value)) {
    return "Passeio / Transporte";
  }
  if (
    /lencol de berco|protetor de colchao|cobertor\/manta|cueiro|mosquiteiro|ninho|travesseiro|cestos organizadores|lixeira antiodor|cesto de roupa/.test(
      value
    )
  ) {
    return "Quarto do Bebê";
  }
  if (/naninha|mobile de berco|luz noturna|porta maternidade/.test(value)) {
    return "Mimos (Opcional)";
  }
  return "Outros";
}

function inferPriority(_nome, prioridade) {
  return prioridade === true;
}

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parseQuotaInfo(nome) {
  const match = String(nome).trim().match(/^(.*)\((\d+)\s+de\s+(\d+)\)$/);
  if (!match) {
    return {
      baseName: String(nome).trim(),
      quotaIndex: 1,
      quotaTotal: 1,
      quotaLabel: "Cota única",
    };
  }

  const baseName = match[1].trim();
  const quotaIndex = Number(match[2]);
  const quotaTotal = Number(match[3]);
  return {
    baseName,
    quotaIndex,
    quotaTotal,
    quotaLabel: `Cota ${quotaIndex} de ${quotaTotal}`,
  };
}

function normalizeItem(raw) {
  const nome = String(raw?.nome ?? "").trim();
  const quota = parseQuotaInfo(nome);
  const marcas = Array.isArray(raw?.marcas)
    ? raw.marcas.map((value) => String(value).trim()).filter(Boolean)
    : [];
  const lojas = Array.isArray(raw?.lojas)
    ? raw.lojas.map((value) => String(value).trim()).filter(Boolean)
    : [];

  return {
    nome,
    baseName: quota.baseName,
    quotaIndex: quota.quotaIndex,
    quotaTotal: quota.quotaTotal,
    quotaLabel: quota.quotaLabel,
    categoria: String(raw?.categoria ?? "").trim() || inferCategory(nome),
    marcas,
    lojas,
    prioridade: inferPriority(nome, raw?.prioridade),
    reservado: raw?.reservado === true,
    reservadoPor: String(raw?.reservadoPor ?? "").trim(),
    reserveId: String(raw?.reserveId ?? "").trim(),
    reservadoEm: typeof raw?.reservadoEm === "number" ? raw.reservadoEm : null,
  };
}

function getOrCreateReserveId() {
  const key = "giftlist_reserve_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id =
      (crypto?.randomUUID?.() ||
        `rid_${Math.random().toString(16).slice(2)}_${Date.now()}`) + "";
    localStorage.setItem(key, id);
  }
  return id;
}

function buildWhatsAppLink({ guestName, giftName }) {
  const msg = `Oi! Eu, ${guestName}, reservei na lista o presente: ${giftName}.`;
  return `https://wa.me/${HOST_WHATSAPP_NUMBER}?text=${encodeURIComponent(msg)}`;
}

function compareGroupItems(a, b) {
  const aAvailable = a.availableQuotas > 0 ? 0 : 1;
  const bAvailable = b.availableQuotas > 0 ? 0 : 1;
  if (aAvailable !== bAvailable) return aAvailable - bAvailable;
  if (a.prioridade !== b.prioridade) return a.prioridade ? -1 : 1;
  return a.nome.localeCompare(b.nome, "pt-BR");
}

function sortQuotas(a, b) {
  return a.quotaIndex - b.quotaIndex;
}

const DEVICE_RESERVE_ID = getOrCreateReserveId();

const elLista = document.getElementById("lista");
const elEstadoVazio = document.getElementById("estadoVazio");
const elContador = document.getElementById("contador");
const elStatus = document.getElementById("status");
const elBusca = document.getElementById("busca");
const elSomenteDisponiveis = document.getElementById("somenteDisponiveis");

const modalReserva = document.getElementById("modalReserva");
const modalReservaItem = document.getElementById("modalReservaItem");
const modalReservaResumo = document.getElementById("modalReservaResumo");
const listaCotas = document.getElementById("listaCotas");
const formReserva = document.getElementById("formReserva");
const inputNome = document.getElementById("inputNome");
const erroNome = document.getElementById("erroNome");
const btnCancelarReserva = document.getElementById("btnCancelarReserva");
const btnConfirmarReserva = document.getElementById("btnConfirmarReserva");

const modalSucesso = document.getElementById("modalSucesso");
const modalSucessoMsg = document.getElementById("modalSucessoMsg");
const btnAvisarWhatsapp = document.getElementById("btnAvisarWhatsapp");
const btnFecharSucesso = document.getElementById("btnFecharSucesso");

let allItems = [];
let groupedItems = [];
let currentReserve = null;

function setNameError(message = "") {
  const hasError = Boolean(message);
  erroNome.textContent = message;
  erroNome.classList.toggle("hidden", !hasError);
  inputNome.classList.toggle("border-red-300", hasError);
  inputNome.classList.toggle("bg-red-50", hasError);
  inputNome.classList.toggle("text-red-900", hasError);
}

function openModal(el) {
  el.classList.remove("hidden");
}

function closeModal(el) {
  el.classList.add("hidden");
}

btnCancelarReserva.addEventListener("click", () => closeModal(modalReserva));
btnFecharSucesso.addEventListener("click", () => closeModal(modalSucesso));

modalReserva.addEventListener("click", (e) => {
  if (e.target === modalReserva) closeModal(modalReserva);
});

modalSucesso.addEventListener("click", (e) => {
  if (e.target === modalSucesso) closeModal(modalSucesso);
});

function buildGroupedItems(items) {
  const grouped = new Map();

  for (const item of items) {
    const key = `${item.categoria}__${item.baseName}`;
    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        nome: item.baseName,
        categoria: item.categoria,
        marcas: item.marcas,
        lojas: item.lojas,
        prioridade: item.prioridade,
        quotas: [],
      });
    }

    const group = grouped.get(key);
    group.quotas.push(item);
    if (item.prioridade) group.prioridade = true;
    if ((!group.marcas || group.marcas.length === 0) && item.marcas.length > 0) {
      group.marcas = item.marcas;
    }
    if ((!group.lojas || group.lojas.length === 0) && item.lojas.length > 0) {
      group.lojas = item.lojas;
    }
  }

  return Array.from(grouped.values()).map((group) => {
    const quotas = group.quotas.sort(sortQuotas);
    const totalQuotas = quotas.length;
    const availableQuotas = quotas.filter((quota) => !quota.reservado).length;
    const reservedQuotas = totalQuotas - availableQuotas;
    const myQuotas = quotas.filter((quota) => quota.reserveId === DEVICE_RESERVE_ID);
    const myQuota = myQuotas[0] || null;

    return {
      ...group,
      quotas,
      totalQuotas,
      availableQuotas,
      reservedQuotas,
      myReservedCount: myQuotas.length,
      myQuota,
    };
  });
}

function render() {
  const q = toSearchText(elBusca.value || "");
  const onlyAvailable = elSomenteDisponiveis.checked;

  let items = [...groupedItems];

  if (q) {
    items = items.filter(
      (item) =>
        toSearchText(item.nome).includes(q) ||
        toSearchText(item.categoria).includes(q)
    );
  }

  if (onlyAvailable) {
    items = items.filter((item) => item.availableQuotas > 0);
  }

  const totalGroups = groupedItems.length;
  const totalAvailableQuotas = groupedItems.reduce(
    (sum, item) => sum + item.availableQuotas,
    0
  );
  elContador.textContent = `${totalGroups} presentes - ${totalAvailableQuotas} cotas disponíveis`;

  elStatus.textContent = q || onlyAvailable ? `${items.length} exibidos` : "";

  elLista.querySelectorAll("[data-item]").forEach((n) => n.remove());

  if (groupedItems.length === 0) {
    elEstadoVazio.classList.remove("hidden");
    return;
  }

  elEstadoVazio.classList.add("hidden");

  if (items.length === 0) {
    const empty = document.createElement("div");
    empty.dataset.item = "true";
    empty.className =
      "rounded-[1.5rem] border border-dashed border-rose-200 bg-rose-50/60 p-4 text-sm text-slate-600";
    empty.textContent = "Nenhum item encontrado com esses filtros.";
    elLista.appendChild(empty);
    return;
  }

  const groupedByCategory = new Map();
  for (const item of items) {
    const key = item.categoria || "Outros";
    if (!groupedByCategory.has(key)) groupedByCategory.set(key, []);
    groupedByCategory.get(key).push(item);
  }

  const sortedCategories = Array.from(groupedByCategory.keys()).sort((a, b) => {
    const ai = CATEGORY_ORDER.indexOf(a);
    const bi = CATEGORY_ORDER.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b, "pt-BR");
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  for (const category of sortedCategories) {
    const section = document.createElement("section");
    section.dataset.item = "true";
    section.className = "space-y-3";

    const header = document.createElement("div");
    header.className = "flex items-center justify-between gap-3";

    const title = document.createElement("h3");
    title.className = "text-sm font-semibold uppercase text-rose-500";
    title.textContent = category;

    const count = document.createElement("span");
    count.className =
      "inline-flex items-center rounded-full border border-rose-100 bg-rose-50 px-3 py-1 text-xs font-medium text-rose-700";
    count.textContent = `${groupedByCategory.get(category).length} itens`;

    header.appendChild(title);
    header.appendChild(count);

    const list = document.createElement("div");
    list.className = "space-y-3";

    groupedByCategory
      .get(category)
      .sort(compareGroupItems)
      .forEach((item) => list.appendChild(renderCard(item)));

    section.appendChild(header);
    section.appendChild(list);
    elLista.appendChild(section);
  }
}

function renderCard(item) {
  const soldOut = item.availableQuotas === 0;
  const hasMultipleQuotas = item.totalQuotas > 1;
  const statusLabel = hasMultipleQuotas
    ? soldOut
      ? "Indisponível"
      : `${item.availableQuotas} de ${item.totalQuotas} disponíveis`
    : soldOut
      ? "Indisponível"
      : "Disponível";

  const card = document.createElement("div");
  card.className =
    "rounded-[1.5rem] border bg-white/95 p-4 sm:rounded-[1.75rem] sm:p-5 flex flex-col gap-4 shadow-[0_18px_50px_rgba(117,71,88,0.08)] " +
    (item.prioridade
      ? "border-rose-200 bg-gradient-to-br from-rose-50/90 to-white"
      : "border-[rgba(114,81,91,0.12)]");

  const left = document.createElement("div");
  left.className = "min-w-0";

  const labels = document.createElement("div");
  labels.className = "mb-3 flex items-start justify-between gap-3";

  const priorityWrap = document.createElement("div");
  priorityWrap.className = "flex min-w-0 flex-wrap gap-2";

  if (item.prioridade) {
    const priority = document.createElement("span");
    priority.className =
      "inline-flex items-center rounded-full border border-rose-200 bg-rose-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-rose-700";
    priority.textContent = "Prioridade";
    priorityWrap.appendChild(priority);
  } else {
    const normal = document.createElement("span");
    normal.className =
      "inline-flex items-center rounded-full border border-slate-200 bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-[0.14em] text-slate-600";
    normal.textContent = "Normal";
    priorityWrap.appendChild(normal);
  }

  const title = document.createElement("p");
  title.className = "text-[15px] font-semibold leading-6 text-slate-900 sm:text-base";
  title.textContent = item.nome || "(Sem nome)";

  const pill = document.createElement("span");
  pill.className =
    "inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium " +
    (soldOut
      ? "border-slate-200 bg-slate-100 text-slate-700"
      : "border-emerald-200 bg-emerald-50 text-emerald-700");
  pill.innerHTML = soldOut
    ? `<span class="mr-2 inline-block h-2 w-2 rounded-full bg-slate-400"></span>${statusLabel}`
    : `<span class="mr-2 inline-block h-2 w-2 rounded-full bg-emerald-500"></span>${statusLabel}`;

  labels.appendChild(priorityWrap);
  labels.appendChild(pill);
  left.appendChild(labels);
  left.appendChild(title);

  if (
    (Array.isArray(item.marcas) && item.marcas.length > 0) ||
    (Array.isArray(item.lojas) && item.lojas.length > 0)
  ) {
    const description = document.createElement("div");
    description.className = "mt-2 space-y-1 text-xs leading-6 text-slate-500";

    if (Array.isArray(item.marcas) && item.marcas.length > 0) {
      const marcasLine = document.createElement("p");
      marcasLine.innerHTML = `<span class="font-semibold text-slate-700">Marcas sugeridas:</span> ${escapeHtml(
        item.marcas.join(", ")
      )}`;
      description.appendChild(marcasLine);
    }

    if (Array.isArray(item.lojas) && item.lojas.length > 0) {
      const lojasLine = document.createElement("p");
      lojasLine.innerHTML = `<span class="font-semibold text-slate-700">Onde comprar:</span> ${escapeHtml(
        item.lojas.join(", ")
      )}`;
      description.appendChild(lojasLine);
    }

    left.appendChild(description);
  }

  const actions = document.createElement("div");
  actions.className =
    "flex flex-col gap-3 border-t border-[rgba(114,81,91,0.10)] pt-4 sm:flex-row sm:items-center sm:justify-between";

  const actionInfo = document.createElement("div");
  actionInfo.className = "min-h-[20px] text-xs text-rose-600";

  if (item.myReservedCount > 0) {
    actionInfo.textContent =
      item.myReservedCount === 1
        ? "Você reservou 1 cota deste item."
        : `Você reservou ${item.myReservedCount} cotas deste item.`;
  }

  actions.appendChild(actionInfo);

  const button = document.createElement("button");
  button.type = "button";
  button.className =
    "w-full sm:w-auto rounded-2xl px-5 py-3 text-sm font-semibold " +
    (soldOut && !item.myQuota
      ? "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
      : "bg-rose-500 text-white hover:bg-rose-600");
  button.textContent = "Reservar";
  button.addEventListener("click", () => openReserveFlow(item));
  actions.appendChild(button);

  card.appendChild(left);
  card.appendChild(actions);
  return card;
}

function renderQuotaList() {
  listaCotas.innerHTML = "";

  if (!currentReserve) return;

  const hasAvailableQuota = currentReserve.quotas.some((quota) => !quota.reservado);
  btnConfirmarReserva.disabled = !hasAvailableQuota;
  btnConfirmarReserva.textContent = hasAvailableQuota
    ? "Confirmar reserva"
    : "Sem cotas disponíveis";

  const hasMultipleQuotas = currentReserve.totalQuotas > 1;
  modalReservaResumo.textContent = hasMultipleQuotas
    ? `${currentReserve.availableQuotas} de ${currentReserve.totalQuotas} cotas disponíveis`
    : hasAvailableQuota
      ? "Selecione o item abaixo para continuar."
      : "Este presente não possui cotas disponíveis no momento.";

  for (const quota of currentReserve.quotas) {
    const isSelected = currentReserve.selectedQuotaId === quota.id;
    const isMine = quota.reserveId === DEVICE_RESERVE_ID;
    const button = document.createElement("button");
    button.type = "button";
    button.className =
      "rounded-2xl border px-4 py-3 text-left transition " +
      (quota.reservado
        ? isMine
          ? "border-rose-200 bg-rose-50 text-rose-700 ring-2 ring-rose-100"
          : "border-slate-200 bg-slate-50 text-slate-400"
        : isSelected
          ? "border-rose-300 bg-rose-50 text-slate-900 ring-2 ring-rose-100"
          : "border-[rgba(114,81,91,0.12)] bg-white text-slate-700 hover:border-rose-200 hover:bg-rose-50/60");

    if (quota.reservado && !isMine) {
      button.disabled = true;
    } else {
      button.addEventListener("click", () => {
        currentReserve.selectedQuotaId = quota.id;
        erroNome.classList.add("hidden");
        renderQuotaList();
      });
    }

    const label = document.createElement("div");
    label.className = "flex items-center justify-between gap-3 text-sm font-semibold";
    label.textContent = quota.quotaLabel;

    if (!quota.reservado) {
      const tag = document.createElement("span");
      tag.className =
        "inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-700";
      tag.textContent = "Disponível";
      label.appendChild(tag);
    } else if (isMine) {
      const tag = document.createElement("span");
      tag.className =
        "inline-flex items-center rounded-full bg-rose-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-rose-700";
      tag.textContent = "Sua";
      label.appendChild(tag);
    } else {
      const tag = document.createElement("span");
      tag.className =
        "inline-flex items-center rounded-full bg-slate-200 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-600";
      tag.textContent = "Reservada";
      label.appendChild(tag);
    }

    button.appendChild(label);

    const meta = document.createElement("div");
    meta.className = "mt-1 text-xs";
    if (quota.reservado) {
      if (isMine) {
        meta.textContent = "Reservada por você";
      } else if (quota.reservadoPor) {
        meta.innerHTML = `Reservada por <span class="font-semibold">${escapeHtml(
          quota.reservadoPor
        )}</span>`;
      } else {
        meta.textContent = "Reservada";
      }
    } else {
      meta.textContent = "Disponível";
    }
    button.appendChild(meta);

    listaCotas.appendChild(button);
  }
}

function openReserveFlow(item) {
  const firstAvailableQuota = item.quotas.find((quota) => !quota.reservado) || null;
  const myQuota = item.quotas.find((quota) => quota.reserveId === DEVICE_RESERVE_ID) || null;

  currentReserve = {
    ...item,
    selectedQuotaId: firstAvailableQuota?.id || myQuota?.id || null,
  };

  modalReservaItem.textContent = item.nome;
  setNameError("");
  inputNome.value = "";
  renderQuotaList();
  openModal(modalReserva);
  setTimeout(() => inputNome.focus(), 50);
}

inputNome.addEventListener("input", () => {
  if ((inputNome.value || "").trim().length >= 2) {
    setNameError("");
  }
});

formReserva.addEventListener("submit", async (e) => {
  e.preventDefault();

  const guestName = (inputNome.value || "").trim();
  if (guestName.length < 2) {
    setNameError("Por favor, informe seu nome para concluir a reserva.");
    return;
  }

  const selectedQuota = currentReserve?.quotas.find(
    (quota) => quota.id === currentReserve.selectedQuotaId
  );

  if (!selectedQuota) {
    setNameError("Selecione uma cota para continuar.");
    return;
  }

  if (selectedQuota.reservado && selectedQuota.reserveId !== DEVICE_RESERVE_ID) {
    setNameError("Essa cota já foi reservada. Escolha outra.");
    return;
  }

  btnConfirmarReserva.disabled = true;
  btnConfirmarReserva.textContent = "Reservando...";

  try {
    const itemRef = ref(db, `${ITEMS_PATH}/${selectedQuota.id}`);

    const result = await runTransaction(itemRef, (current) => {
      const cur = normalizeItem(current || {});
      if (cur.reservado === true) return;

      return {
        ...current,
        nome: current?.nome ?? selectedQuota.nome,
        categoria: current?.categoria ?? currentReserve.categoria,
        marcas: Array.isArray(current?.marcas) ? current.marcas : (currentReserve.marcas ?? []),
        lojas: Array.isArray(current?.lojas) ? current.lojas : (currentReserve.lojas ?? []),
        prioridade: current?.prioridade === true || currentReserve.prioridade === true,
        reservado: true,
        reservadoPor: guestName,
        reserveId: DEVICE_RESERVE_ID,
        reservadoEm: Date.now(),
      };
    });

    if (!result.committed) {
      setNameError("Ops! Essa cota acabou de ser reservada por outra pessoa.");
      return;
    }

    closeModal(modalReserva);
    modalSucessoMsg.innerHTML = `Você reservou <strong>${escapeHtml(
      currentReserve.nome
    )}</strong> (${escapeHtml(selectedQuota.quotaLabel)}) como <strong>${escapeHtml(
      guestName
    )}</strong>.`;
    btnAvisarWhatsapp.href = buildWhatsAppLink({
      guestName,
      giftName: `${currentReserve.nome} - ${selectedQuota.quotaLabel}`,
    });
    openModal(modalSucesso);
    currentReserve = null;
  } catch (err) {
    console.error(err);
    setNameError("Não foi possível reservar agora. Verifique as permissões e tente novamente.");
  } finally {
    btnConfirmarReserva.disabled = false;
    btnConfirmarReserva.textContent = "Confirmar reserva";
  }
});

elBusca.addEventListener("input", render);
elSomenteDisponiveis.addEventListener("change", render);

const itemsRef = ref(db, ITEMS_PATH);
onValue(
  itemsRef,
  (snapshot) => {
    const data = snapshot.val() || {};
    allItems = Object.entries(data).map(([id, raw]) => ({ id, ...normalizeItem(raw) }));
    groupedItems = buildGroupedItems(allItems);
    render();
  },
  (error) => {
    console.error(error);
    elStatus.textContent = "Erro ao carregar a lista. Verifique o Firebase.";
  }
);
