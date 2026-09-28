// ligacaonova-worker.js
// Worker dedicado ao processamento da Base Oficial (Email Ligação Nova).
// Roda inteiramente fora da thread principal — medido empiricamente que o
// parse do SheetJS 0.18.5 bloqueia quem o chama por vários segundos (6-14s
// no arquivo real de 24MB), então esse trabalho só pode rodar aqui.
//
// Este Worker NÃO resolve matrícula→posto nem Sede (não tem acesso ao
// Firestore/cache de usuários da thread principal) — ele devolve os casos já
// com GERENTE e matrícula normalizados, e a resolução final (posto, Sede,
// exclusão de outras gerências) acontece na thread principal.

importScripts('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');

const LN_ABA_BASE = 'base';
const LN_GERENTE_OPERACAO = 'MARCELO PORTUGAL';

// Cabeçalhos obrigatórios e variações aceitas, já normalizadas (ver
// lnNormalizarCabecalho). A normalização cobre o caso real encontrado no
// arquivo de teste: "Número do caso  ↑" (seta decorativa + espaço duplo).
const LN_CAMPOS_OBRIGATORIOS = {
  'NUMERO DO CASO': ['NUMERO DO CASO'],
  'SUB STATUS': ['SUB STATUS'],
  'NUMERO DO PONTO DE FORNECIMENTO': ['NUMERO DO PONTO DE FORNECIMENTO'],
  'DATA/HORA DE ABERTURA': ['DATA/HORA DE ABERTURA'],
  'CRIADO POR: N DO FUNCIONARIO': ['CRIADO POR: N DO FUNCIONARIO', 'CRIADO POR: NO DO FUNCIONARIO'],
  'VALIDACAO EMAIL': ['VALIDACAO EMAIL'],
  'DATA DE EXTRACAO': ['DATA DE EXTRACAO'],
  'GERENTE': ['GERENTE']
};
// Só usado pra exibição (coluna "Atendente" no Detalhamento) — opcional,
// nunca bloqueia a importação se a coluna não existir no arquivo.
const LN_CAMPO_ATENDENTE_NOME = ['CRIADO POR: NOME COMPLETO'];

function lnNormalizarCabecalho(h) {
  return String(h || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remove acentos
    .replace(/[↑↓→←]/g, '')                             // remove seta decorativa
    .replace(/[°º]/g, '')                                // "Nº" -> "N"
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

function lnResolverCabecalhos(headerRow) {
  const mapa = {};
  headerRow.forEach((h, idx) => {
    const norm = lnNormalizarCabecalho(h);
    for (const [canon, variantes] of Object.entries(LN_CAMPOS_OBRIGATORIOS)) {
      if (variantes.includes(norm) && mapa[canon] === undefined) mapa[canon] = idx;
    }
  });
  return mapa;
}

// Converte um valor de célula de data (Date, serial numérico do Excel, ou
// string) pra "AAAA-MM-DD", sem nunca deixar passar um serial numérico cru
// pra frente. Com {cellDates:true} no XLSX.read, o caso normal já vem como
// Date — o ramo numérico aqui é só defesa extra caso alguma célula específica
// escape dessa conversão automática do SheetJS.
function lnDataParaISO(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, '0'), d = String(v.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof v === 'number') {
    try {
      const dc = XLSX.SSF.parse_date_code(v);
      if (dc && dc.y) return `${String(dc.y).padStart(4, '0')}-${String(dc.m).padStart(2, '0')}-${String(dc.d).padStart(2, '0')}`;
    } catch (e) { /* segue pro fallback de string abaixo */ }
    return null;
  }
  const s = String(v).trim();
  let m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

function lnNormalizarMatricula(v) {
  return String(v || '').trim().toUpperCase();
}

// Chave canônica do "Número do caso" — SEMPRE string, trim, e sem ".0" à
// direita (o Excel/SheetJS pode representar um inteiro como decimal
// dependendo do formato da célula: 1048373462.0 e 1048373462 precisam virar
// exatamente a mesma chave "1048373462"). Usada igual no Controle
// (index.html) — mesma lógica, arquivos diferentes por causa do Worker.
function lnNormalizarNumeroCaso(v) {
  if (v === null || v === undefined) return '';
  let s = String(v).trim();
  s = s.replace(/\.0+$/, '');
  return s;
}

// Universo pré-filtrado ainda dentro do Worker (só o que é seguro decidir
// sem Firestore): mantém linhas cujo GERENTE já é literalmente a operação,
// e mantém também linhas com GERENTE ambíguo/vazio (0, "-", vazio) — essas
// PODEM ser Sede (casos reais confirmados: Plicila e Danielly chegam com
// GERENTE=0) e são decididas de verdade só na thread principal, por
// matrícula. Qualquer outro nome de gerente real é descartado aqui mesmo,
// pra não carregar linhas de outras gerências até a thread principal.
function lnGerentePodeSerDoUniverso(gerenteRaw) {
  const g = gerenteRaw;
  if (g === undefined || g === null) return true;
  const s = String(g).trim();
  if (s === '' || s === '0' || s === '-') return true;
  return s.toUpperCase() === LN_GERENTE_OPERACAO;
}

self.onmessage = function (e) {
  const { tipo, buffer } = e.data || {};
  if (tipo !== 'processar_base_oficial') return;

  try {
    self.postMessage({ etapa: 'lendo_planilha' });

    // Escalada de teto sem suposição silenciosa: se o resultado bater
    // exatamente no teto pedido, pode haver mais linha abaixo — tenta de
    // novo com um teto maior antes de aceitar como completo.
    // cellDates:true faz o SheetJS já entregar células de data como objeto
    // Date (em vez de serial numérico) — é a causa raiz corrigida do "mês
    // aparecendo como 46290" na interface.
    const tetos = [100000, 300000, 1000000];
    let workbook = null, truncado = true;

    for (let i = 0; i < tetos.length; i++) {
      const teto = tetos[i];
      if (i > 0) self.postMessage({ etapa: 'lendo_planilha', tentativaAmpliada: true, novoTeto: teto });
      workbook = XLSX.read(buffer, { type: 'array', sheets: [LN_ABA_BASE], sheetRows: teto, cellDates: true });
      const ws = workbook.Sheets[LN_ABA_BASE];
      if (!ws) break; // aba não existe — teto maior não resolve isso
      const range = XLSX.utils.decode_range(ws['!ref']);
      const linhasLidas = range.e.r + 1;
      truncado = (linhasLidas === teto);
      if (!truncado) break;
    }

    const ws = workbook.Sheets[LN_ABA_BASE];
    if (!ws) {
      self.postMessage({ etapa: 'erro', codigo: 'ABA_BASE_NAO_ENCONTRADA', mensagem: 'A aba "base" não foi encontrada neste arquivo.' });
      return;
    }
    if (truncado) {
      self.postMessage({ etapa: 'erro', codigo: 'ARQUIVO_MAIOR_QUE_SUPORTADO', mensagem: 'O arquivo tem mais linhas do que o suportado atualmente (1.000.000). Fale com o suporte técnico.' });
      return;
    }

    self.postMessage({ etapa: 'aba_localizada', abaEncontrada: LN_ABA_BASE });

    const range = XLSX.utils.decode_range(ws['!ref']);
    const headerRow = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cell = ws[XLSX.utils.encode_cell({ r: 0, c })];
      headerRow.push(cell ? cell.v : undefined);
    }
    const mapa = lnResolverCabecalhos(headerRow);
    const faltando = Object.keys(LN_CAMPOS_OBRIGATORIOS).filter(k => mapa[k] === undefined);
    if (faltando.length) {
      self.postMessage({ etapa: 'erro', codigo: 'CABECALHO_FALTANDO', mensagem: 'Coluna(s) obrigatória(s) não encontrada(s) no arquivo: ' + faltando.join(', ') });
      return;
    }

    const idxCaso = mapa['NUMERO DO CASO'];
    const idxExtracao = mapa['DATA DE EXTRACAO'];
    const idxSubStatus = mapa['SUB STATUS'];
    const idxPF = mapa['NUMERO DO PONTO DE FORNECIMENTO'];
    const idxDataAbertura = mapa['DATA/HORA DE ABERTURA'];
    const idxMatricula = mapa['CRIADO POR: N DO FUNCIONARIO'];
    const idxValidacao = mapa['VALIDACAO EMAIL'];
    const idxGerente = mapa['GERENTE'];
    // Coluna opcional (só exibição) — resolvida à parte, nunca bloqueia a
    // importação se não existir no arquivo.
    let idxAtendenteNome;
    headerRow.forEach((h, idx) => { if (idxAtendenteNome===undefined && LN_CAMPO_ATENDENTE_NOME.includes(lnNormalizarCabecalho(h))) idxAtendenteNome = idx; });

    // Passo 1: varre só "Número do caso" + "Data de extração" pra achar a
    // extração mais recente, sem montar o objeto completo de cada linha.
    let extracaoMaisRecente = null;
    let linhasComCaso = 0;
    for (let r = 1; r <= range.e.r; r++) {
      const cellCaso = ws[XLSX.utils.encode_cell({ r, c: idxCaso })];
      if (!cellCaso || cellCaso.v === undefined || cellCaso.v === '') continue;
      linhasComCaso++;
      const cellExt = ws[XLSX.utils.encode_cell({ r, c: idxExtracao })];
      const dataExt = cellExt ? lnDataParaISO(cellExt.v) : null;
      if (dataExt && (!extracaoMaisRecente || dataExt > extracaoMaisRecente)) extracaoMaisRecente = dataExt;
      if (r % 5000 === 0) self.postMessage({ etapa: 'lendo_planilha', linhaAtual: r });
    }

    if (!extracaoMaisRecente) {
      self.postMessage({ etapa: 'erro', codigo: 'DATA_EXTRACAO_NAO_ENCONTRADA', mensagem: 'Nenhuma "Data de extração" válida foi encontrada no arquivo.' });
      return;
    }

    self.postMessage({ etapa: 'extraindo_extracao_mais_recente', dataExtracao: extracaoMaisRecente, linhasRealEncontradas: linhasComCaso });

    // Passo 2: lê por completo só as linhas da extração mais recente E cujo
    // GERENTE pode pertencer ao universo (operação ou ambíguo/Sede) —
    // descarta aqui mesmo qualquer outra gerência, sem levar isso pra
    // thread principal. Agrupa por Número do caso (pra duplicidade/conflito).
    const casosPorNumero = {};
    for (let r = 1; r <= range.e.r; r++) {
      const cellCaso = ws[XLSX.utils.encode_cell({ r, c: idxCaso })];
      if (!cellCaso || cellCaso.v === undefined || cellCaso.v === '') continue;
      const cellExt = ws[XLSX.utils.encode_cell({ r, c: idxExtracao })];
      const dataExt = cellExt ? lnDataParaISO(cellExt.v) : null;
      if (dataExt !== extracaoMaisRecente) continue;

      const get = (idx) => { const c = ws[XLSX.utils.encode_cell({ r, c: idx })]; return c ? c.v : undefined; };
      const gerenteRaw = get(idxGerente);
      if (!lnGerentePodeSerDoUniverso(gerenteRaw)) continue;

      const numeroCaso = lnNormalizarNumeroCaso(cellCaso.v);
      const linha = {
        subStatus: String(get(idxSubStatus) || '').trim(),
        pf: String(get(idxPF) || '').trim(),
        dataAberturaRaw: get(idxDataAbertura),
        matricula: lnNormalizarMatricula(get(idxMatricula)),
        validacaoEmail: String(get(idxValidacao) || '').trim().toUpperCase(),
        gerente: gerenteRaw,
        atendenteNome: idxAtendenteNome!==undefined ? String(get(idxAtendenteNome)||'').trim() : ''
      };
      (casosPorNumero[numeroCaso] || (casosPorNumero[numeroCaso] = [])).push(linha);
    }

    self.postMessage({ etapa: 'aplicando_elegibilidade', linhasAnalisadas: Object.keys(casosPorNumero).length });

    // Passo 3: elegibilidade + duplicidade/conflito. "Última linha vence"
    // NUNCA é usado — idêntico nos campos relevantes deduplica com alerta;
    // divergente vira conflito, fora do Resultado Oficial.
    const resultado = [];
    let comEmail = 0, semEmail = 0, pendenciaClassificacao = 0, naoElegiveis = 0,
        duplicidadeIdentica = 0, duplicidadeConflito = 0;

    for (const numeroCaso in casosPorNumero) {
      const linhas = casosPorNumero[numeroCaso];
      const base = linhas[0];
      let conflito = false;

      if (linhas.length > 1) {
        // Campos que afetam posto/classificação/universo. Sub Status e Ponto de
        // Fornecimento NÃO entram: não afetam mais o indicador (só diagnóstico).
        const assinatura = l => `${l.matricula}|${l.validacaoEmail}|${l.gerente}`;
        const distintos = new Set(linhas.map(assinatura));
        if (distintos.size > 1) { conflito = true; duplicidadeConflito++; }
        else duplicidadeIdentica++;
      }

      if (conflito) {
        resultado.push({ numeroCaso, situacao: 'conflito', linhasEnvolvidas: linhas });
        continue;
      }

      // REGRA DE NEGÓCIO: o indicador mede se o e-mail foi captado NO INGRESSO
      // da Ligação Nova — Sub Status e Ponto de Fornecimento (que refletem o
      // andamento posterior do processo) NÃO excluem mais o ingresso. Todo
      // ingresso do universo participa; ambos os campos seguem gravados só
      // pra diagnóstico/detalhamento.

      const dataAbertura = lnDataParaISO(base.dataAberturaRaw);
      let classificacao = 'PENDENTE_CLASSIFICACAO';
      if (base.validacaoEmail === 'COM EMAIL') { classificacao = 'COM_EMAIL'; comEmail++; }
      else if (base.validacaoEmail === 'SEM EMAIL') { classificacao = 'SEM_EMAIL'; semEmail++; }
      else { pendenciaClassificacao++; }

      resultado.push({
        numeroCaso, matricula: base.matricula, dataAbertura, classificacao,
        atendenteNome: base.atendenteNome || '',
        subStatus: base.subStatus || '',
        pontoFornecimento: base.pf || '',
        gerente: base.gerente, // usado na thread principal pra decidir universo/Sede
        situacao: 'elegivel' // gerente/matrícula->posto/Sede ainda não resolvidos aqui
      });
    }

    self.postMessage({ etapa: 'duplicidades_avaliadas' });

    self.postMessage({
      etapa: 'concluido',
      resultado: {
        dataExtracao: extracaoMaisRecente,
        totais: {
          linhasRealEncontradas: linhasComCaso,
          elegiveis: resultado.filter(r => r.situacao === 'elegivel').length,
          naoElegiveis, comEmail, semEmail, pendenciaClassificacao,
          duplicidadeIdentica, duplicidadeConflito
        },
        casos: resultado
      }
    });

    workbook = null;
  } catch (err) {
    self.postMessage({ etapa: 'erro', codigo: 'ERRO_INESPERADO', mensagem: String((err && err.message) || err) });
  }
};
