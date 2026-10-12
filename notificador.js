// Robô diário: lê o Supabase e envia ao Telegram as cobranças do dia.
// Também cria, para cada empréstimo ativo, a cobrança (mês) que acabou de vencer.

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SUPA_URL = process.env.SUPA_URL || 'https://njxmkbottjywjggolott.supabase.co';
const SUPA_KEY = process.env.SUPA_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5qeG1rYm90dGp5d2pnZ29sb3R0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxNTA4MzksImV4cCI6MjA5NDcyNjgzOX0.3OmlrwwnY37a5VuhGU9P_xn6Anw-MGuB8jhsXwq0S6M';

// ─── Supabase ───────────────────────────────────────────────
async function sb(path, { method = 'GET', body, prefer } = {}) {
  const headers = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (prefer) headers.Prefer = prefer;
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  });
  const texto = await res.text();
  if (!res.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]} -> ${res.status}: ${texto}`);
  return texto ? JSON.parse(texto) : [];
}

// O Supabase devolve no máximo 1000 linhas por consulta: busca em páginas.
async function sbTodas(tabela, filtro = '') {
  const linhas = [];
  for (let off = 0; ; off += 1000) {
    const pagina = await sb(`${tabela}?select=*${filtro}&order=id&limit=1000&offset=${off}`);
    linhas.push(...pagina);
    if (pagina.length < 1000) break;
  }
  return linhas;
}

// ─── Datas e formatação ─────────────────────────────────────
const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
const brl = v => 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pad2 = n => String(n).padStart(2, '0');

function hojeEmBahia() {
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Bahia', day: '2-digit', month: '2-digit', year: 'numeric'
  }).formatToParts(new Date());
  const p = t => parseInt(partes.find(x => x.type === t).value, 10);
  return { dia: p('day'), mes: p('month'), ano: p('year') };
}
const ultimoDiaDoMes = (ano, mes) => new Date(Date.UTC(ano, mes, 0)).getUTCDate();

function addMes(ano, mes, n) {
  const t = ano * 12 + (mes - 1) + n;
  return { ano: Math.floor(t / 12), mes: (t % 12) + 1 };
}

// Dia do vencimento "efetivo" no mês: dia 31 vence no dia 30 (ou 28/29) em meses curtos.
const vencimentoNoMes = (diaCobranca, ano, mes) => Math.min(Number(diaCobranca), ultimoDiaDoMes(ano, mes));

// ─── Meses de cobrança (tabela emprestimo_meses) ────────────
// Garante que exista uma linha para cada vencimento ocorrido desde o cadastro
// do empréstimo até hoje (cobre dias em que o robô não rodou).
async function garantirMeses(emprestimosAtivos, hoje) {
  const existentes = await sbTodas('emprestimo_meses');
  const chaves = new Set(existentes.map(m => `${m.emprestimo_id}|${String(m.competencia).slice(0, 7)}`));
  const hojeISO = `${hoje.ano}-${pad2(hoje.mes)}-${pad2(hoje.dia)}`;
  const novas = [];

  for (const e of emprestimosAtivos) {
    const criado = String(e.criado_em || hojeISO).slice(0, 10);
    let c = { ano: Number(criado.slice(0, 4)), mes: Number(criado.slice(5, 7)) };
    while (c.ano < hoje.ano || (c.ano === hoje.ano && c.mes <= hoje.mes)) {
      const dataVenc = `${c.ano}-${pad2(c.mes)}-${pad2(vencimentoNoMes(e.dia_cobranca, c.ano, c.mes))}`;
      const chave = `${e.id}|${c.ano}-${pad2(c.mes)}`;
      if (dataVenc >= criado && dataVenc <= hojeISO && !chaves.has(chave)) {
        novas.push({ emprestimo_id: e.id, competencia: `${c.ano}-${pad2(c.mes)}-01`, valor_devido: Number(e.valor_cobranca), valor_pago: 0 });
        chaves.add(chave);
      }
      c = addMes(c.ano, c.mes, 1);
    }
  }

  if (novas.length) {
    await sb('emprestimo_meses?on_conflict=emprestimo_id,competencia', {
      method: 'POST', body: novas, prefer: 'resolution=ignore-duplicates,return=minimal'
    });
    console.log(`${novas.length} mês(es) de cobrança criado(s).`);
  }
}

// "07/26 a 09/26, 11/26"
function textoMeses(comps) {
  const lista = comps.map(c => String(c).slice(0, 7)).sort();
  const curto = c => `${c.slice(5, 7)}/${c.slice(2, 4)}`;
  const saida = []; let i = 0;
  while (i < lista.length) {
    let j = i;
    while (j + 1 < lista.length) {
      const [y1, m1] = lista[j].split('-').map(Number), [y2, m2] = lista[j + 1].split('-').map(Number);
      if ((y2 * 12 + m2) - (y1 * 12 + m1) !== 1) break;
      j++;
    }
    saida.push(i === j ? curto(lista[i]) : `${curto(lista[i])} a ${curto(lista[j])}`);
    i = j + 1;
  }
  return saida.join(', ');
}

// ─── Empréstimos do dia ─────────────────────────────────────
// Devolve [{ identificacao, cobranca, atraso }] das cobranças que vencem hoje.
async function buscarEmprestimosHoje(hoje) {
  const venceHoje = dia => Number(dia) === hoje.dia || (hoje.dia === ultimoDiaDoMes(hoje.ano, hoje.mes) && Number(dia) > hoje.dia);

  const ativos = await sbTodas('emprestimos', '&quitado=eq.false');
  const doDia = ativos.filter(e => venceHoje(e.dia_cobranca));
  const competenciaHoje = `${hoje.ano}-${pad2(hoje.mes)}`;

  let temMeses = true, meses = [];
  try {
    await garantirMeses(ativos, hoje);
    meses = await sbTodas('emprestimo_meses');
  } catch (err) {
    // Se as tabelas novas ainda não existirem, o robô continua usando os campos de "emprestimos".
    temMeses = false;
    console.warn('Aviso: não foi possível usar a tabela emprestimo_meses. Usando saldo_devedor_juros.', err.message);
  }

  const resultado = [];
  for (const e of doDia) {
    let atraso;
    if (temMeses) {
      const doEmp = meses.filter(m => m.emprestimo_id === e.id);
      const emAberto = doEmp.filter(m => r2(m.valor_devido - m.valor_pago) > 0.004);
      const total = r2(emAberto.reduce((s, m) => s + (m.valor_devido - m.valor_pago), 0));
      // Atraso = o que ficou de meses ANTERIORES (a cobrança de hoje já aparece no valor principal).
      atraso = r2(emAberto.filter(m => String(m.competencia).slice(0, 7) < competenciaHoje)
                          .reduce((s, m) => s + (m.valor_devido - m.valor_pago), 0));
      // Mantém os campos de resumo da tabela "emprestimos" em dia.
      try {
        await sb(`emprestimos?id=eq.${e.id}`, {
          method: 'PATCH', prefer: 'return=minimal',
          body: {
            saldo_devedor_juros: total,
            meses_em_atraso: textoMeses(emAberto.map(m => m.competencia)),
            pagamento_parcial: r2(emAberto.reduce((s, m) => s + Number(m.valor_pago), 0))
          }
        });
      } catch (err) { console.warn('Aviso: não atualizei o resumo de', e.identificacao, err.message); }
    } else {
      atraso = r2(e.saldo_devedor_juros);
    }
    resultado.push({ identificacao: e.identificacao, cobranca: Number(e.valor_cobranca), atraso });
  }
  return resultado.sort((a, b) => a.identificacao.localeCompare(b.identificacao, 'pt-BR'));
}

// ─── Principal ──────────────────────────────────────────────
async function run() {
  console.log('Iniciando a leitura da base de dados...');
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error('ERRO: As chaves do Telegram não foram encontradas no GitHub Secrets!');
    process.exit(1);
  }

  const hoje = hojeEmBahia();
  const venceHoje = dia => Number(dia) === hoje.dia || (hoje.dia === ultimoDiaDoMes(hoje.ano, hoje.mes) && Number(dia) > hoje.dia);

  const emprestimosHoje = await buscarEmprestimosHoje(hoje);
  const imoveis = await sb('imoveis?select=*');
  const alugueisHoje = imoveis.filter(i => i.ativo !== false && venceHoje(i.dia));

  // Texto simples (sem parse_mode): nenhum caractere do nome pode quebrar a API do Telegram.
  let mensagem = `📅 Cobranças de Hoje (${pad2(hoje.dia)}/${pad2(hoje.mes)}/${hoje.ano})\n\n`;
  let cobrancas = 0;

  if (emprestimosHoje.length > 0) {
    mensagem += `💰 EMPRÉSTIMOS:\n`;
    emprestimosHoje.forEach(e => {
      mensagem += `- ${e.identificacao}: ${brl(e.cobranca)}`;
      if (e.atraso > 0) mensagem += ` (Atraso Acumulado: ${brl(e.atraso)})`;
      mensagem += `\n`;
      cobrancas++;
    });
    mensagem += `\n`;
  }

  if (alugueisHoje.length > 0) {
    mensagem += `🏠 ALUGUÉIS:\n`;
    alugueisHoje.forEach(i => {
      mensagem += `- ${i.inq} (${i.endereco}): ${brl(i.valor)}\n`;
      cobrancas++;
    });
    mensagem += `\n`;
  }

  if (cobrancas === 0) mensagem += `Nenhuma cobrança agendada para hoje.`;
  mensagem = mensagem.trimEnd();

  console.log('Mensagem gerada. A enviar para o Telegram...');
  console.log(mensagem);

  const response = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TELEGRAM_CHAT_ID, text: mensagem })
  });
  const data = await response.json();
  if (!data.ok) {
    console.error('ERRO DO TELEGRAM:', data.description);
    process.exit(1); // Faz a rotina falhar no GitHub para podermos ver o erro
  }
  console.log('Mensagem enviada com sucesso ao Telegram!');
}

run().catch(err => {
  console.error('Erro fatal do sistema:', err);
  process.exit(1);
});
