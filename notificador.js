const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const SUPA_URL = 'https://njxmkbottjywjggolott.supabase.co';
const SUPA_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5qeG1rYm90dGp5d2pnZ29sb3R0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkxNTA4MzksImV4cCI6MjA5NDcyNjgzOX0.3OmlrwwnY37a5VuhGU9P_xn6Anw-MGuB8jhsXwq0S6M';

async function fetchSupabase(table) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${table}?select=*`, {
    headers: { 'apikey': SUPA_KEY, 'Authorization': `Bearer ${SUPA_KEY}` }
  });
  return await res.json();
}

async function run() {
  const hoje = new Date();
  // Ajusta o fuso horário para o Brasil (Bahia) para garantir o dia correto
  const formatter = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Bahia', day: '2-digit', month: '2-digit', year: 'numeric' });
  const [{ value: dia }, , { value: mes }, , { value: ano }] = formatter.formatToParts(hoje);
  const diaHoje = parseInt(dia, 10);

  const emprestimos = await fetchSupabase('emprestimos');
  const imoveis = await fetchSupabase('imoveis');

  let mensagem = `📅 *Cobranças de Hoje (${dia}/${mes}/${ano})*\n\n`;
  let cobrancas = 0;

  // Verifica Alugueres
  const alugueisHoje = imoveis.filter(i => i.ativo !== false && Number(i.dia) === diaHoje);
  if (alugueisHoje.length > 0) {
    mensagem += `🏠 *ALUGUÉIS:*\n`;
    alugueisHoje.forEach(i => {
      mensagem += `- ${i.inq} (${i.endereco}): R$ ${i.valor}\n`;
      cobrancas++;
    });
    mensagem += `\n`;
  }

  // Verifica Empréstimos (Baseado no dia da data inicial)
  const emprestimosHoje = emprestimos.filter(e => {
    if (e.quitado) return false;
    const diaEmp = parseInt(e.data.split('-')[2], 10);
    return diaEmp === diaHoje;
  });

  if (emprestimosHoje.length > 0) {
    mensagem += `💰 *EMPRÉSTIMOS:*\n`;
    emprestimosHoje.forEach(e => {
      mensagem += `- ${e.nome}: R$ ${e.valor} (Valor Original)\n`;
      cobrancas++;
    });
  }

  if (cobrancas === 0) {
    mensagem += `Nenhuma cobrança agendada para hoje.`;
  }

  // Envia para o Telegram
  const tgUrl = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`;
  await fetch(tgUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: mensagem,
      parse_mode: 'Markdown'
    })
  });
  console.log('Processo concluído com sucesso!');
}

run().catch(console.error);