// ligacaonova-worker.js
// Worker dedicado ao processamento da Base Oficial (Email Ligação Nova).
// Roda inteiramente fora da thread principal — medido empiricamente que o
// parse do SheetJS 0.18.5 bloqueia quem o chama por vários segundos (6-14s
// no arquivo real de 24MB), então esse trabalho só pode rodar aqui.
//
// Este Worker NÃO resolve matrícula→posto (não tem acesso ao Firestore/cache
// de usuários da thread principal) — ele devolve os casos com a matrícula já
// normalizada, e a resolução matrícula→posto acontece na thread principal,
// que já mantém allUsers em memória.

importScripts('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');

const LN_ABA_BASE = 'base';

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
  'DATA DE EXTRACAO': ['DATA DE EXTRACAO']
};

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

function lnParseDataAbertura(str) {
  // Formato real observado: "dd/mm/aaaa hh:mm" (string, não objeto data).
  const m = /^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/.exec(String(str || '').trim());
  if (!m) return null;
  const [, d, mo, y] = m;
  return `${y}-${mo}-${d}`; // AAAA-MM-DD, base da agregação por dia
}

function lnDataCelulaParaISO(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  // Alguns exports trazem "Data de extração" como texto dd/mm/aaaa também.
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return s.slice(0, 10);
}

function lnNormalizarMatricula(v) {
  return String(v || '').trim().toUpperCase();
}
function lnNormalizarCaso(v) {
  return String(v == null ? '' : v).trim();
}

self.onmessage = function (e) {
  const { tipo, buffer } = e.data || {};
  if (tipo !== 'processar_base_oficial') return;

  try {
    self.postMessage({ etapa: 'lendo_planilha' });

    // Escalada de teto sem suposição silenciosa: se o resultado bater
    // exatamente no teto pedido, pode haver mais linha abaixo — tenta de
    // novo com um teto maior antes de aceitar como completo.
    const tetos = [100000, 300000, 1000000];
    let workbook = null, truncado = true;

    for (let i = 0; i < tetos.length; i++) {
      const teto = tetos[i];
      if (i > 0) self.postMessage({ etapa: 'lendo_planilha', tentativaAmpliada: true, novoTeto: teto });
      workbook = XLSX.read(buffer, { type: 'array', sheets: [LN_ABA_BASE], sheetRows: teto });
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

    // Passo 1: varre só "Número do caso" + "Data de extração" pra achar a
    // extração mais recente, sem montar o objeto completo de cada linha.
    let extracaoMaisRecente = null;
    let linhasComCaso = 0;
    for (let r = 1; r <= range.e.r; r++) {
      const cellCaso = ws[XLSX.utils.encode_cell({ r, c: idxCaso })];
      if (!cellCaso || cellCaso.v === undefined || cellCaso.v === '') continue;
      linhasComCaso++;
      const cellExt = ws[XLSX.utils.encode_cell({ r, c: idxExtracao })];
      const dataExt = cellExt ? lnDataCelulaParaISO(cellExt.v) : null;
      if (dataExt && (!extracaoMaisRecente || dataExt > extracaoMaisRecente)) extracaoMaisRecente = dataExt;
      if (r % 5000 === 0) self.postMessage({ etapa: 'lendo_planilha', linhaAtual: r });
    }

    if (!extracaoMaisRecente) {
      self.postMessage({ etapa: 'erro', codigo: 'DATA_EXTRACAO_NAO_ENCONTRADA', mensagem: 'Nenhuma "Data de extração" válida foi encontrada no arquivo.' });
      return;
    }

    self.postMessage({ etapa: 'extraindo_extracao_mais_recente', dataExtracao: extracaoMaisRecente, linhasRealEncontradas: linhasComCaso });

    // Passo 2: lê por completo só as linhas da extração mais recente,
    // agrupando por Número do caso (pra detectar duplicidade/conflito).
    const casosPorNumero = {};
    for (let r = 1; r <= range.e.r; r++) {
      const cellCaso = ws[XLSX.utils.encode_cell({ r, c: idxCaso })];
      if (!cellCaso || cellCaso.v === undefined || cellCaso.v === '') continue;
      const cellExt = ws[XLSX.utils.encode_cell({ r, c: idxExtracao })];
      const dataExt = cellExt ? lnDataCelulaParaISO(cellExt.v) : null;
      if (dataExt !== extracaoMaisRecente) continue;

      const numeroCaso = lnNormalizarCaso(cellCaso.v);
      const get = (idx) => { const c = ws[XLSX.utils.encode_cell({ r, c: idx })]; return c ? c.v : undefined; };
      const linha = {
        subStatus: String(get(idxSubStatus) || '').trim(),
        pf: String(get(idxPF) || '').trim(),
        dataAberturaRaw: get(idxDataAbertura),
        matricula: lnNormalizarMatricula(get(idxMatricula)),
        validacaoEmail: String(get(idxValidacao) || '').trim().toUpperCase()
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
        const assinatura = l => `${l.subStatus}|${l.pf}|${l.matricula}|${l.validacaoEmail}`;
        const distintos = new Set(linhas.map(assinatura));
        if (distintos.size > 1) { conflito = true; duplicidadeConflito++; }
        else duplicidadeIdentica++;
      }

      if (conflito) {
        resultado.push({ numeroCaso, situacao: 'conflito', linhasEnvolvidas: linhas });
        continue;
      }

      const elegivel = base.subStatus === 'Contrato Ativo' && base.pf !== '';
      if (!elegivel) { naoElegiveis++; continue; }

      const dataAbertura = lnParseDataAbertura(base.dataAberturaRaw);
      let classificacao = 'PENDENTE_CLASSIFICACAO';
      if (base.validacaoEmail === 'COM EMAIL') { classificacao = 'COM_EMAIL'; comEmail++; }
      else if (base.validacaoEmail === 'SEM EMAIL') { classificacao = 'SEM_EMAIL'; semEmail++; }
      else { pendenciaClassificacao++; }

      resultado.push({
        numeroCaso, matricula: base.matricula, dataAbertura, classificacao,
        situacao: 'elegivel' // matrícula->posto ainda não resolvida aqui
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

    // Libera a referência do workbook parseado — não fica retido depois do
    // postMessage; o Worker também será finalizado (terminate()) pela
    // thread principal assim que a mensagem for processada.
    workbook = null;
  } catch (err) {
    self.postMessage({ etapa: 'erro', codigo: 'ERRO_INESPERADO', mensagem: String((err && err.message) || err) });
  }
};
