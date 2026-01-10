// scripts/faturamento_historico.js
const puppeteer = require('puppeteer');
const { createClient } = require('@supabase/supabase-js');
//require('dotenv').config();

const empresas = [
  { nome: 'grupopadrecicero', regiao: 'sp01', precisaSelecionarEmpresa: true, nome_empresa: 'grupo_padre_cicero' },
  { nome: 'gpc_estacazero', regiao: 'nordeste01', precisaSelecionarEmpresa: false, nome_empresa: 'estaca_zero' },
  { nome: 'gpc_bacabal', regiao: 'nordeste01', precisaSelecionarEmpresa: false, nome_empresa: 'padin_bacabal' },
  { nome: 'gpc_caxias', regiao: 'nordeste01', precisaSelecionarEmpresa: false, nome_empresa: 'padin_caxias' },
  { nome: 'ghpc_caxias1', regiao: 'sp02', precisaSelecionarEmpresa: false, nome_empresa: 'caxias' },
  { nome: 'grpc_campomaior', regiao: 'sp01', precisaSelecionarEmpresa: false, nome_empresa: 'campo_maior' },
  //{ nome: 'grupohrpc', regiao: 'nordeste01', precisaSelecionarEmpresa: false, nome_empresa: 'box' },
  { nome: 'grpcgurupi', regiao: 'sp01', precisaSelecionarEmpresa: false, nome_empresa: 'gurupi' },
];

const usuario = process.env.user;
const senha = process.env.password;

// Função para formatar data no formato DD/MM/YYYY
function formatarData(data) {
  const dia = String(data.getDate()).padStart(2, '0');
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const ano = data.getFullYear();
  return `${dia}/${mes}/${ano}`;
}

// Função para converter data para fuso horário do Brasil (UTC-3)
// Necessário quando roda no GitHub Actions que usa UTC
function getDataBrasil(data = new Date()) {
  // Brasil está em UTC-3
  const offsetBrasil = -3 * 60; // -3 horas em minutos
  const utc = data.getTime() + (data.getTimezoneOffset() * 60000);
  const dataBrasil = new Date(utc + (offsetBrasil * 60000));
  return dataBrasil;
}

// Função para formatar data no formato YYYY-MM-DD (para o banco)
// Usa fuso horário do Brasil para evitar problemas de UTC
function formatarDataISO(data) {
  const dataBrasil = getDataBrasil(data);
  const ano = dataBrasil.getFullYear();
  const mes = String(dataBrasil.getMonth() + 1).padStart(2, '0');
  const dia = String(dataBrasil.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

// Função para gerar array dos últimos 90 dias
function gerarUltimos5Dias() {
  const dias = [];
  // Usa fuso horário do Brasil
  const hojeBrasil = getDataBrasil();
  hojeBrasil.setHours(0, 0, 0, 0);
  
  for (let i = 0; i < 5; i++) {
    const data = new Date(hojeBrasil);
    data.setDate(hojeBrasil.getDate() - i);
    dias.push(data);
  }
  
  return dias.reverse(); // do mais antigo para o mais recente
}

// Função auxiliar para delay (substitui waitForTimeout que foi removido)
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function extrairFaturamento(page, selector) {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return 0;
    const texto = el.innerText.replace(/[^\d,]/g, '').replace(',', '.');
    return parseFloat(texto) || 0;
  }, selector);
}

// Função para verificar e atualizar faturamento apenas se o novo valor for maior
async function atualizarFaturamentoSeMaior(filial, dataISO, novoValor, numVendas, agora) {
  // Buscar registro existente
  const { data: registroExistente, error: errorBusca } = await supabase
    .from('faturamento_diario')
    .select('valor')
    .eq('filial', filial)
    .eq('data', dataISO)
    .single();

  // Se não existe registro ou se o novo valor é maior, atualiza
  if (errorBusca && errorBusca.code === 'PGRST116') {
    // Registro não existe, pode inserir
    const { error } = await supabase.from('faturamento_diario').upsert(
      {
        filial: filial,
        data: dataISO,
        valor: novoValor,
        num_vendas: numVendas,
        updated_at: agora
      },
      {
        onConflict: 'filial,data'
      }
    );
    return { atualizado: true, error };
  } else if (registroExistente) {
    // Registro existe, verifica se o novo valor é maior
    if (novoValor > registroExistente.valor) {
      const { error } = await supabase.from('faturamento_diario').upsert(
        {
          filial: filial,
          data: dataISO,
          valor: novoValor,
          num_vendas: numVendas,
          updated_at: agora
        },
        {
          onConflict: 'filial,data'
        }
      );
      return { atualizado: true, error };
    }
    else {
      // Novo valor é menor, não atualiza
      return { atualizado: false, error: null };
    }
  } else {
    // Erro na busca (diferente de "não encontrado")
    return { atualizado: false, error: errorBusca };
  }
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

(async () => {
  const browser = await puppeteer.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();

  const dias = gerarUltimos5Dias();
  const agora = new Date().toISOString();
  
  console.log(`Iniciando extração de faturamento histórico para os últimos ${dias.length} dias...`);

  for (const empresa of empresas) {
    const baseUrl = `https://${empresa.regiao}.retaguarda.app/${empresa.nome}`;
    
    console.log(`\nProcessando empresa: ${empresa.nome_empresa}`);

    // Login (seguindo o padrão do faturamento.js que funciona)
    await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle2' });
    await page.type('#txtLogin', usuario);
    await page.type('#txtSenha', senha);
    await page.click('#btnLogin');

    if (!empresa.precisaSelecionarEmpresa) {
      await page.waitForNavigation({ waitUntil: 'networkidle2' });
    } else {
      // grupopadrecicero (com seleção de lojas) - seguindo exatamente o padrão do faturamento.js
      await page.waitForSelector('input[id^="lvLojas_btnSelLoja_0"]', { timeout: 10000 });
      await page.evaluate(() => {
        const botao = document.querySelector('input[id^="lvLojas_btnSelLoja_0"]');
        if (botao) botao.click();
      });
      await page.waitForNavigation({ waitUntil: 'networkidle2' });
    }

    // Navegar para a página de saídas (seguindo o padrão do faturamento.js)
    await page.goto(`${baseUrl}/movcentral/saidas`, { waitUntil: 'networkidle2' });
    await page.waitForSelector('#contentBody_pnlAbaMovimento', { timeout: 15000 });

    // Processar cada dia
    for (let i = 0; i < dias.length; i++) {
      const data = dias[i];
      const dataFormatada = formatarData(data);
      const dataISO = formatarDataISO(data);
      
      console.log(`  Processando dia ${i + 1}/${dias.length}: ${dataFormatada}`);

      try {
        // Preencher campos de data (inputs type="date" esperam formato YYYY-MM-DD)
        await page.waitForSelector('#contentBody_txtDInicial', { timeout: 30000 });
        
        // Preencher data inicial usando evaluate para garantir que o valor seja definido corretamente
        await page.evaluate((data) => {
          const input = document.querySelector('#contentBody_txtDInicial');
          if (input) {
            input.value = data;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, dataISO);

        await page.waitForSelector('#contentBody_txtDFinal', { timeout: 30000 });
        
        // Preencher data final
        await page.evaluate((data) => {
          const input = document.querySelector('#contentBody_txtDFinal');
          if (input) {
            input.value = data;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, dataISO);
        
        await delay(3000); // Pequeno delay após preencher as datas

        // Clicar no botão de atualizar e aguardar carregamento
        await page.waitForSelector('#contentBody_btnAtualizarMovimento', { timeout: 30000 });
        
        // Aguardar o carregamento dos dados após clicar
        await Promise.all([
          page.waitForSelector('#contentBody_pnlAbaMovimento', { timeout: 60000 }).catch(() => {}),
          page.click('#contentBody_btnAtualizarMovimento')
        ]);
        
        await delay(5000); // Aguardar um pouco mais para garantir que os dados foram carregados

        if (!empresa.precisaSelecionarEmpresa) {
          // Empresas simples (uma única loja)
          const faturamento = await extrairFaturamento(page, '#contentBody_lblVTotAut1');
          const vendas = await extrairFaturamento(page, '#contentBody_lblQtdMovAut1');

          if (faturamento > 0 || vendas > 0) {
            const resultado = await atualizarFaturamentoSeMaior(
              empresa.nome_empresa,
              dataISO,
              faturamento,
              vendas,
              agora
            );
            
            if (resultado.atualizado) {
              console.log(`    ✓ ${empresa.nome_empresa}: R$ ${faturamento.toFixed(2)} | ${vendas} vendas`);
            } else if (resultado.error) {
              console.error(`    ✗ Erro ao atualizar ${empresa.nome_empresa}:`, resultado.error.message);
            } else {
              console.log(`    ⊘ ${empresa.nome_empresa}: Valor menor igual que o existente, mantido anterior`);
            }
          }
        } else {
          // grupopadrecicero (múltiplas lojas)
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
            if (valores.revenue > 0 || valores.sales > 0) {
              const resultado = await atualizarFaturamentoSeMaior(
                nome,
                dataISO,
                valores.revenue,
                valores.sales,
                agora
              );
              
              if (resultado.atualizado) {
                console.log(`    ✓ ${nome}: R$ ${valores.revenue.toFixed(2)} | ${valores.sales} vendas`);
              } else if (resultado.error) {
                console.error(`    ✗ Erro ao atualizar ${nome}:`, resultado.error.message);
              } else {
                console.log(`    ⊘ ${nome}: Valor menor que o existente, mantido anterior`);
              }
            }
          }
        }
      } catch (error) {
        console.error(`    ✗ Erro ao processar ${dataFormatada} para ${empresa.nome_empresa}:`, error.message);
        // Continua para o próximo dia mesmo se houver erro
      }

      // Pequeno delay entre requisições para não sobrecarregar o servidor
      await delay(4000);
    }

    console.log(`✓ Concluído para ${empresa.nome_empresa}`);
  }

  await browser.close();

  console.log('\n✓ Extração histórica concluída!');
})();

