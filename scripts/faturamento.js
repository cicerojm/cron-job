// scripts/faturamento.js
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
//require('dotenv').config();

const empresas = [
  { nome: 'gpc_estacazero', regiao: 'nordeste01', precisaSelecionarEmpresa: false, nome_empresa: 'estaca_zero' },
  { nome: 'gpc_bacabal', regiao: 'nordeste01', precisaSelecionarEmpresa: false, nome_empresa: 'padin_bacabal' },
  { nome: 'gpc_caxias', regiao: 'nordeste01', precisaSelecionarEmpresa: false, nome_empresa: 'padin_caxias' },
  { nome: 'ghpc_caxias1', regiao: 'sp02', precisaSelecionarEmpresa: false, nome_empresa: 'caxias' },
  { nome: 'grpc_campomaior', regiao: 'sp01', precisaSelecionarEmpresa: false, nome_empresa: 'campo_maior' },
  { nome: 'grupohrpc', regiao: 'nordeste01', precisaSelecionarEmpresa: false, nome_empresa: 'box' },
  { nome: 'grupopadrecicero', regiao: 'sp01', precisaSelecionarEmpresa: true, nome_empresa: 'grupo_padre_cicero' },
];

const usuario = process.env.user;
const senha = process.env.password;

async function extrairFaturamento(page, selector) {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return 0;
    const texto = el.innerText.replace(/[^\d,]/g, '').replace(',', '.');
    return parseFloat(texto) || 0;
  }, selector);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

(async () => {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();

  const resultados = [];

  for (const empresa of empresas) {
    const baseUrl = `https://${empresa.regiao}.retaguarda.app/${empresa.nome}`;

    await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle2' });
    await page.type('#txtLogin', usuario);
    await page.type('#txtSenha', senha);
    await page.click('#btnLogin');

    if (!empresa.precisaSelecionarEmpresa) {
      await page.waitForNavigation({ waitUntil: 'networkidle2' });
      await page.goto(`${baseUrl}/movcentral/saidas`, { waitUntil: 'networkidle2' });
      await page.waitForSelector('#contentBody_pnlAbaMovimento', { timeout: 15000 });

      const faturamento = await extrairFaturamento(page, '#contentBody_lblVTotAut1');
      const vendas = await extrairFaturamento(page, '#contentBody_lblQtdMovAut1');
      resultados.push({ nome: empresa.nome_empresa, revenue: faturamento, sales: vendas });
    } else {
      // grupopadrecicero (com seleção de lojas)
      await page.waitForSelector('input[id^="lvLojas_btnSelLoja_0"]', { timeout: 10000 });
      await page.evaluate(() => {
        const botao = document.querySelector('input[id^="lvLojas_btnSelLoja_0"]');
        if (botao) botao.click();
      });
      await page.waitForNavigation({ waitUntil: 'networkidle2' });
      await page.goto(`${baseUrl}/movcentral/saidas`, { waitUntil: 'networkidle2' });
      await page.waitForSelector('#contentBody_pnlAbaMovimento', { timeout: 15000 });

      const dados = await page.evaluate(() => {
        const parseNumber = (selector) => {
          const el = document.querySelector(selector);
          if (!el) return 0;
          return parseFloat(el.innerText.replace(/[^\d,]/g, '').replace(',', '.')) || 0;
        };
        const parse = (id) => ({
          revenue: parseNumber(`#contentBody_lblVTotAut${id}`),
          sales: parseNumber(`#contentBody_lblQtdMovAut${id}`)
        });
        return {
          peritoro: parse(1),
          acailandia: parse(2),
          santa_maria: parse(7),
          sobral: parse(8),
          buriticupu: parse(11)
        };
      });

      for (const [nome, valores] of Object.entries(dados)) {
        resultados.push({ nome, revenue: valores.revenue, sales: valores.sales });
      }
    }

    // desloga antes de ir para a próxima empresa (se precisar)
    // opcional: await page.goto(`${baseUrl}/logout`, { waitUntil: 'networkidle2' });
  }

  await browser.close();

  // === Grava no Supabase ===
  const agora = new Date().toISOString();
  const hoje = new Date().toISOString().slice(0, 10); // 'YYYY-MM-DD' (data de referência do faturamento)

  let total = 0;
  let total_vendas = 0;

  for (const r of resultados) {
    total += r.revenue;
    total_vendas += r.sales;

    // 1) Painel em tempo real (como já fazia)
    await supabase.from('faturamento_atual').upsert({
      id: r.nome,
      valor: r.revenue,
      num_vendas: r.sales,
      created_at: agora
    });

    // 2) Histórico diário
    await supabase.from('faturamento_diario').upsert(
      {
        filial: r.nome,
        data: hoje,
        valor: r.revenue,
        num_vendas: r.sales,
        updated_at: agora
      },
      {
        onConflict: 'filial,data' // precisa bater com o índice único criado
      }
    );
  }

  // total em tempo real
  await supabase.from('faturamento_atual').upsert({
    id: 'total',
    valor: total,
    num_vendas: total_vendas,
    created_at: agora
  });

  // total diário (opcional, mas eu já deixo aqui)
  await supabase.from('faturamento_diario').upsert(
    {
      filial: 'total',
      data: hoje,
      valor: total,
      num_vendas: total_vendas,
      updated_at: agora
    },
    {
      onConflict: 'filial,data'
    }
  );

  console.log('Faturamento registrado (atual e diário):', resultados);
})();
