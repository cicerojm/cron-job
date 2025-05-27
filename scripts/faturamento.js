// scripts/faturamento.js
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
//require('dotenv').config();


const empresas = [
  { nome: 'gpc_estacazero', precisaSelecionarEmpresa: false, nome_empresa: 'estaca_zero' },
  { nome: 'gpc_bacabal', precisaSelecionarEmpresa: false, nome_empresa: 'padin_bacabal' },
  { nome: 'gpc_caxias', precisaSelecionarEmpresa: false, nome_empresa: 'padin_caxias' },
  { nome: 'grupopadrecicero', precisaSelecionarEmpresa: true, nome_empresa: 'grupo_padre_cicero' },
];

const usuario = process.env.user;
const senha = process.env.password;

async function extrairFaturamento(page, selector) {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const texto = el.innerText.replace(/[^\d,]/g, '').replace(',', '.');
    return parseFloat(texto);
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
    const baseUrl = `https://nordeste01.retaguarda.app/${empresa.nome}`;
    await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle2' });
    await page.type('#txtLogin', usuario);
    await page.type('#txtSenha', senha);
    await page.click('#btnLogin');

    if (!empresa.precisaSelecionarEmpresa) {
        await page.waitForNavigation({ waitUntil: 'networkidle2' });
        await page.goto(`${baseUrl}/movcentral/saidas`, { waitUntil: 'networkidle2' });
        await page.waitForSelector('#contentBody_lblVTotAut1', { timeout: 15000 });

        const faturamento = await extrairFaturamento(page, '#contentBody_lblVTotAut1');
        resultados.push({ nome: empresa.nome_empresa, revenue: faturamento });
    } else {
        // grupopadrecicero (com seleção de lojas)
        await page.waitForSelector('input[id^="lvLojas_btnSelLoja_0"]', { timeout: 10000 });
        await page.evaluate(() => {
            const botao = document.querySelector('input[id^="lvLojas_btnSelLoja_0"]');
            if (botao) botao.click();
        });
        await page.waitForNavigation({ waitUntil: 'networkidle2' });
        await page.goto(`${baseUrl}/movcentral/saidas`, { waitUntil: 'networkidle2' });
        await page.waitForSelector('#contentBody_lblVTotAut1', { timeout: 15000 });
        
        const dados = await page.evaluate(() => {
            const parse = (id) => {
            const el = document.querySelector(`#contentBody_lblVTotAut${id}`);
            if (!el) return null;
            return parseFloat(el.innerText.replace(/[^\d,]/g, '').replace(',', '.'));
            };
            return {
            peritoro: parse(1),
            acailandia: parse(2),
            caxias: parse(6),
            santa_maria: parse(7),
            sobral: parse(8),
            buriticupu: parse(11)
            };
        });

        for (const [nome, revenue] of Object.entries(dados)) {
            resultados.push({ nome, revenue });
        }
    }
  }

  await browser.close();

  // Grava no Supabase
  const agora = new Date().toISOString();
  let total = 0
  for (const r of resultados) {
    total += r.revenue
    await supabase.from('faturamento_atual').upsert({
      id: r.nome,
      valor: r.revenue,
      created_at: agora
     });
  }
  await supabase.from('faturamento_atual').upsert({
      id: 'total',
      valor: total,
      created_at: agora
     });

  console.log('Faturamento registrado:', resultados);
})();
