// ligacaonova-worker.js  —  v3 (leitura INCREMENTAL do XLSX)
// Worker dedicado ao processamento da Base Oficial (Email Ligação Nova).
//
// POR QUE ESTA VERSÃO EXISTE
// O XLSX original da Enel tem ~150 MB e a aba "base" declara 1.048.562 linhas, das quais
// só ~283 mil têm dados (as outras ~765 mil são <row r="N"/> vazias). A versão anterior
// usava XLSX.read (SheetJS) com tetos de 100 mil / 300 mil / 1 milhão de linhas: isso
// materializa a planilha INTEIRA em memória (>5 GB medido) e, no teto de 1 milhão, o
// arquivo era simplesmente recusado. Um Web Worker isolado NÃO resolve consumo de memória.
//
// COMO FUNCIONA AGORA (nenhuma biblioteca externa, nenhuma planilha em memória)
//   1. O .xlsx é um ZIP. Lê-se só o diretório central (alguns KB no fim do arquivo).
//   2. A aba "base" (XML de ~500 MB descompactado) é lida em FLUXO: File.slice().stream()
//      → DecompressionStream('deflate-raw') → TextDecoder → varredura linha a linha.
//      O consumo de memória é constante (alguns MB de buffer), independente do tamanho.
//   3. UMA passada só: para cada competência (mês da Data/Hora de abertura) guarda-se
//      apenas as linhas da extração mais recente DELA; ao aparecer uma extração mais
//      nova, o acumulado daquela competência é descartado.
//   4. Só as linhas do universo (GERENTE = operação ou ambíguo/Sede) são retidas.
//
// Este Worker NÃO resolve matrícula→posto nem Sede (não tem acesso ao Firestore/cache de
// usuários da thread principal) — devolve os casos com GERENTE e matrícula normalizados.

const LN_WORKER_VERSAO = 'ln-worker-3.0-stream';

const LN_ABA_BASE = 'base';
const LN_GERENTE_OPERACAO = 'MARCELO PORTUGAL';
// Linhas sem Data/Hora de abertura válida não pertencem a nenhuma competência:
// formam um grupo próprio (com a sua própria extração mais recente).
const LN_SEM_DATA = 'SEM_DATA';

// Cabeçalhos obrigatórios e variações aceitas, já normalizadas (ver lnNormalizarCabecalho).
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
// Só usado pra exibição (coluna "Atendente" no Detalhamento) — opcional.
const LN_CAMPO_ATENDENTE_NOME = ['CRIADO POR: NOME COMPLETO'];

function lnNormalizarCabecalho(h) {
  return String(h == null ? '' : h)
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // remove acentos
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

// Serial de data do Excel (dias desde 1899-12-30; 25569 = 1970-01-01) -> "AAAA-MM-DD".
function lnSerialParaISO(n) {
  if (!(n > 0) || !isFinite(n)) return null;
  const d = new Date(Math.round((Math.floor(n) - 25569) * 86400000));
  if (isNaN(d.getTime())) return null;
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Converte valor de célula de data (número serial do Excel, ou texto "dd/mm/aaaa ..." /
// "aaaa-mm-dd ...") pra "AAAA-MM-DD". Nunca deixa passar serial numérico cru.
function lnDataParaISO(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  if (typeof v === 'number') return lnSerialParaISO(v);
  const s = String(v).trim();
  let m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

function lnNormalizarMatricula(v) {
  return String(v == null ? '' : v).trim().toUpperCase();
}

// Chave canônica do "Número do caso" — SEMPRE string, trim, e sem ".0" à direita.
function lnNormalizarNumeroCaso(v) {
  if (v === null || v === undefined) return '';
  let s = (typeof v === 'number') ? (Number.isInteger(v) ? String(v) : String(v)) : String(v).trim();
  s = s.replace(/\.0+$/, '');
  return s;
}

// Universo pré-filtrado: GERENTE literalmente a operação, ou ambíguo/vazio (0, "-", vazio) —
// esses PODEM ser Sede e são decididos na thread principal, por matrícula.
function lnGerentePodeSerDoUniverso(gerenteRaw) {
  const g = gerenteRaw;
  if (g === undefined || g === null) return true;
  const s = String(g).trim();
  if (s === '' || s === '0' || s === '-') return true;
  return s.toUpperCase() === LN_GERENTE_OPERACAO;
}

// ═══════════════════════════ ZIP / XLSX EM FLUXO ═══════════════════════════

async function lnLerFatia(blob, ini, fim) {
  return new Uint8Array(await blob.slice(ini, fim).arrayBuffer());
}

// Lê só o diretório central do ZIP (fim do arquivo). Devolve { nome -> entrada }.
async function lnLerDiretorioZip(blob) {
  const tam = blob.size;
  if (tam < 22) throw new Error('O arquivo não é um .xlsx válido (muito pequeno).');
  const cab = await lnLerFatia(blob, 0, 4);
  if (cab[0] !== 0x50 || cab[1] !== 0x4B) throw new Error('O arquivo não é um .xlsx válido (assinatura ZIP ausente). Se for .xls antigo, salve como .xlsx.');
  const ini = Math.max(0, tam - 65557);
  const tail = await lnLerFatia(blob, ini, tam);
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let i = tail.length - 22;
  for (; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) break;
  if (i < 0) throw new Error('O arquivo .xlsx está corrompido (fim do ZIP não encontrado).');
  const total = dv.getUint16(i + 10, true), cdTam = dv.getUint32(i + 12, true), cdOff = dv.getUint32(i + 16, true);
  if (total === 0xFFFF || cdTam === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) throw new Error('ZIP64 (arquivo acima de 4 GB) não é suportado.');
  const cd = await lnLerFatia(blob, cdOff, cdOff + cdTam);
  const cv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const dec = new TextDecoder('utf-8');
  const entradas = {};
  let p = 0;
  for (let n = 0; n < total && p + 46 <= cd.length; n++) {
    if (cv.getUint32(p, true) !== 0x02014b50) break;
    const metodo = cv.getUint16(p + 10, true), compTam = cv.getUint32(p + 20, true), descTam = cv.getUint32(p + 24, true);
    const nomeLen = cv.getUint16(p + 28, true), extraLen = cv.getUint16(p + 30, true), comLen = cv.getUint16(p + 32, true), localOff = cv.getUint32(p + 42, true);
    if (compTam === 0xFFFFFFFF || descTam === 0xFFFFFFFF || localOff === 0xFFFFFFFF) throw new Error('ZIP64 não é suportado.');
    const nome = dec.decode(cd.subarray(p + 46, p + 46 + nomeLen));
    entradas[nome] = { nome, metodo, compTam, descTam, localOff };
    p += 46 + nomeLen + extraLen + comLen;
  }
  return entradas;
}

// Fluxo de bytes (já descompactados) de uma entrada do ZIP.
async function lnAbrirEntrada(blob, e) {
  const lh = await lnLerFatia(blob, e.localOff, e.localOff + 30);
  const lv = new DataView(lh.buffer, lh.byteOffset, lh.byteLength);
  if (lv.getUint32(0, true) !== 0x04034b50) throw new Error('Cabeçalho local do ZIP inválido (' + e.nome + ').');
  const ini = e.localOff + 30 + lv.getUint16(26, true) + lv.getUint16(28, true);
  let s = blob.slice(ini, ini + e.compTam).stream();
  if (e.metodo === 8) s = s.pipeThrough(new DecompressionStream('deflate-raw'));
  else if (e.metodo !== 0) throw new Error('Método de compressão ZIP não suportado (' + e.metodo + ').');
  return s;
}

// Itera o conteúdo de uma entrada como TEXTO, em pedaços (memória constante).
async function* lnPedacosTexto(blob, e, aoLerBytes) {
  const reader = (await lnAbrirEntrada(blob, e)).getReader();
  const dec = new TextDecoder('utf-8');
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (aoLerBytes) aoLerBytes(value.length);
      const txt = dec.decode(value, { stream: true });
      if (txt) yield txt;
    }
    const resto = dec.decode();
    if (resto) yield resto;
  } finally { try { reader.releaseLock(); } catch (_) {} }
}

async function lnTextoCompleto(blob, e) {
  let out = '';
  for await (const t of lnPedacosTexto(blob, e)) out += t;
  return out;
}

function lnDecodificarEntidades(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, g) => {
    if (g === 'amp') return '&'; if (g === 'lt') return '<'; if (g === 'gt') return '>'; if (g === 'quot') return '"'; if (g === 'apos') return "'";
    const cp = g[1] === 'x' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
    try { return String.fromCodePoint(cp); } catch (_) { return m; }
  });
}

function lnAtributo(tag, nome) {
  const k = ' ' + nome + '="';
  const i = tag.indexOf(k);
  if (i < 0) return null;
  const f = tag.indexOf('"', i + k.length);
  return f < 0 ? null : lnDecodificarEntidades(tag.slice(i + k.length, f));
}

// Texto de um <si> (string compartilhada) ou <is> (inline): concatena os <t>, ignorando fonético (<rPh>).
function lnTextoDeSi(xml) {
  if (xml.indexOf('<rPh') >= 0) xml = xml.replace(/<rPh[\s\S]*?<\/rPh>/g, '');
  let out = '', i = 0;
  for (;;) {
    const a = xml.indexOf('<t', i);
    if (a < 0) break;
    const c = xml.charCodeAt(a + 2);
    if (c !== 62 && c !== 32) { i = a + 2; continue; } // <tag... diferente de <t> / <t ...>
    const gt = xml.indexOf('>', a);
    if (xml.charCodeAt(gt - 1) === 47) { i = gt + 1; continue; } // <t/>
    const f = xml.indexOf('</t>', gt);
    if (f < 0) break;
    out += xml.slice(gt + 1, f);
    i = f + 4;
  }
  return lnDecodificarEntidades(out);
}

async function lnLerStringsCompartilhadas(blob, e) {
  const lista = [];
  let buf = '';
  for await (const t of lnPedacosTexto(blob, e)) {
    buf += t;
    let pos = 0;
    for (;;) {
      const a = buf.indexOf('<si', pos);
      if (a < 0) break;
      if (a + 3 >= buf.length) { pos = a; break; } // '<si' cortado no fim do pedaço: espera o próximo
      const c = buf.charCodeAt(a + 3);
      if (c !== 62 && c !== 47 && c !== 32) { pos = a + 3; continue; } // <sst...>
      const gt = buf.indexOf('>', a);
      if (gt < 0) break;
      if (buf.charCodeAt(gt - 1) === 47) { lista.push(''); pos = gt + 1; continue; } // <si/>
      const f = buf.indexOf('</si>', gt);
      if (f < 0) break;
      lista.push(lnTextoDeSi(buf.slice(gt + 1, f)));
      pos = f + 5;
    }
    buf = buf.slice(pos);
  }
  return lista;
}

// Descobre o caminho do XML da aba pelo nome (workbook.xml + rels).
async function lnLocalizarAba(blob, entradas, nomeAba) {
  const ew = entradas['xl/workbook.xml'], er = entradas['xl/_rels/workbook.xml.rels'];
  if (!ew || !er) throw new Error('Estrutura de .xlsx não reconhecida (workbook.xml ausente).');
  const wb = await lnTextoCompleto(blob, ew), rels = await lnTextoCompleto(blob, er);
  let rid = null, achouNomes = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*>/g)) {
    const nome = lnAtributo(m[0], 'name');
    achouNomes.push(nome);
    if (nome && nome.trim().toLowerCase() === nomeAba) rid = lnAtributo(m[0], 'r:id') || lnAtributo(m[0], 'id');
  }
  if (!rid) return { erro: 'ABA_BASE_NAO_ENCONTRADA', abas: achouNomes };
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    if (lnAtributo(m[0], 'Id') === rid) {
      let alvo = lnAtributo(m[0], 'Target') || '';
      alvo = alvo.charAt(0) === '/' ? alvo.slice(1) : 'xl/' + alvo;
      return { caminho: alvo };
    }
  }
  return { erro: 'ABA_BASE_NAO_ENCONTRADA', abas: achouNomes };
}

// Varre a aba em fluxo. `aoCabecalho(vetorPorColuna)` roda na 1ª linha com células e devolve
// o conjunto de colunas desejadas; `aoLinha(valores)` roda nas demais (valores por posição de
// `colunas`). Valores: texto (string) ou número (células numéricas). Memória constante.
async function lnVarrerAba(blob, entrada, sst, aoCabecalho, aoLinha, aoProgresso) {
  let precisa = null, colunas = null, maxCol = -1, cabecalhoFeito = false, linhas = 0;
  let buf = '';
  const total = entrada.descTam || 1;
  let lidos = 0, ultimoAviso = 0;

  const processarLinha = (b, ini, fim, ehCabecalho) => {
    // ini = primeiro char após o '>' da tag <row>, fim = posição de '</row>'
    let p = ini;
    const vals = ehCabecalho ? [] : new Array(colunas.length);
    let algum = false;
    for (;;) {
      const c = b.indexOf('<c ', p);
      if (c < 0 || c >= fim) break;
      const gt = b.indexOf('>', c);
      const rIdx = b.indexOf(' r="', c);
      let col = 0;
      if (rIdx > 0 && rIdx < gt) {
        for (let k = rIdx + 4, ch; (ch = b.charCodeAt(k)) >= 65 && ch <= 90; k++) col = col * 26 + ch - 64;
        col -= 1;
      } else col = -1;
      if (b.charCodeAt(gt - 1) === 47) { p = gt + 1; continue; } // célula vazia <c .../>
      const fc = b.indexOf('</c>', gt);
      p = fc + 4;
      if (col < 0) continue;
      if (!ehCabecalho && (col > maxCol || precisa[col] === 0)) continue;
      const tIdx = b.indexOf(' t="', c);
      // Tipo COMPLETO da célula: n | s (string compartilhada) | str (resultado de fórmula, texto) | inlineStr | b | e | d
      let t = 'n';
      if (tIdx > 0 && tIdx < gt) { const tf = b.indexOf('"', tIdx + 4); t = b.slice(tIdx + 4, tf); }
      const tFull = t;
      let v = null;
      if (t === 's') {
        const a = b.indexOf('<v>', gt), f = a >= 0 && a < fc ? b.indexOf('</v>', a) : -1;
        if (f > 0) v = sst[parseInt(b.slice(a + 3, f), 10)];
        if (v === undefined) v = null;
      } else if (tFull === 'inlineStr') {
        const a = b.indexOf('<is>', gt);
        if (a >= 0 && a < fc) v = lnTextoDeSi(b.slice(a + 4, b.indexOf('</is>', a)));
      } else {
        const a = b.indexOf('<v>', gt), f = a >= 0 && a < fc ? b.indexOf('</v>', a) : -1;
        if (f > 0) {
          const raw = b.slice(a + 3, f);
          if (t === 'n') { const num = Number(raw); v = isNaN(num) ? raw : num; }
          else v = lnDecodificarEntidades(raw); // str (fórmula), b, e, d
        }
      }
      if (v === null) continue;
      if (ehCabecalho) vals[col] = v;
      else { vals[precisa[col] - 1] = v; algum = true; }
    }
    return ehCabecalho ? vals : (algum ? vals : null);
  };

  for await (const t of lnPedacosTexto(blob, entrada, n => { lidos += n; })) {
    buf += t;
    let pos = 0;
    for (;;) {
      const a = buf.indexOf('<row', pos);
      if (a < 0) break;
      const gt = buf.indexOf('>', a);
      if (gt < 0) break;
      if (buf.charCodeAt(gt - 1) === 47) { pos = gt + 1; continue; } // <row r="N"/> vazia (≈765 mil no arquivo real)
      const fim = buf.indexOf('</row>', gt);
      if (fim < 0) break;
      linhas++;
      if (!cabecalhoFeito) {
        const cab = processarLinha(buf, gt + 1, fim, true);
        const pedido = aoCabecalho(cab);
        colunas = pedido; maxCol = Math.max(...pedido);
        precisa = new Int32Array(maxCol + 1);
        pedido.forEach((c, k) => { precisa[c] = k + 1; });
        cabecalhoFeito = true;
      } else {
        const vals = processarLinha(buf, gt + 1, fim, false);
        if (vals) aoLinha(vals);
      }
      pos = fim + 6;
    }
    buf = buf.slice(pos);
    const agora = Date.now();
    if (aoProgresso && agora - ultimoAviso > 400) { ultimoAviso = agora; aoProgresso(lidos, total, linhas); }
  }
  if (aoProgresso) aoProgresso(total, total, linhas);
  return linhas;
}

// ═══════════════════════════ PROCESSAMENTO ═══════════════════════════

async function lnProcessarBase(blob) {
  const post = (m) => self.postMessage(m);
  post({ etapa: 'versao', versao: LN_WORKER_VERSAO });
  post({ etapa: 'lendo_planilha', modo: 'fluxo' });

  const entradas = await lnLerDiretorioZip(blob);
  const aba = await lnLocalizarAba(blob, entradas, LN_ABA_BASE);
  if (aba.erro) { post({ etapa: 'erro', codigo: 'ABA_BASE_NAO_ENCONTRADA', mensagem: 'A aba "base" não foi encontrada neste arquivo. Abas vistas: ' + (aba.abas || []).join(', ') }); return; }
  const eAba = entradas[aba.caminho];
  if (!eAba) { post({ etapa: 'erro', codigo: 'ABA_BASE_NAO_ENCONTRADA', mensagem: 'O XML da aba "base" não foi localizado dentro do arquivo.' }); return; }

  const eSst = entradas['xl/sharedStrings.xml'];
  const sst = eSst ? await lnLerStringsCompartilhadas(blob, eSst) : [];
  post({ etapa: 'aba_localizada', abaEncontrada: LN_ABA_BASE, bytesDescompactadosDaAba: eAba.descTam, stringsCompartilhadas: sst.length });

  // Estado por competência (mês da Data/Hora de abertura): só guarda as linhas da extração mais recente DELA.
  const comps = {};
  let linhasComCaso = 0;
  let idx = null; // índices (posição em `colunas`) resolvidos no cabeçalho
  let faltando = null;

  const linhasLidas = await lnVarrerAba(blob, eAba, sst,
    (cab) => {
      const mapa = lnResolverCabecalhos(cab);
      faltando = Object.keys(LN_CAMPOS_OBRIGATORIOS).filter(k => mapa[k] === undefined);
      let idxAtendente;
      cab.forEach((h, c) => { if (idxAtendente === undefined && h != null && LN_CAMPO_ATENDENTE_NOME.includes(lnNormalizarCabecalho(h))) idxAtendente = c; });
      const pedido = [mapa['NUMERO DO CASO'], mapa['DATA DE EXTRACAO'], mapa['DATA/HORA DE ABERTURA'], mapa['GERENTE'], mapa['SUB STATUS'],
                      mapa['NUMERO DO PONTO DE FORNECIMENTO'], mapa['CRIADO POR: N DO FUNCIONARIO'], mapa['VALIDACAO EMAIL']];
      if (idxAtendente !== undefined) pedido.push(idxAtendente);
      idx = { caso: 0, ext: 1, ab: 2, ger: 3, sub: 4, pf: 5, mat: 6, val: 7, atend: idxAtendente !== undefined ? 8 : -1 };
      if (faltando.length) return [0]; // lê só a coluna A; o erro é reportado logo abaixo
      return pedido;
    },
    (v) => {
      if (faltando && faltando.length) return;
      const casoRaw = v[idx.caso];
      if (casoRaw === undefined || casoRaw === null || casoRaw === '') return;
      linhasComCaso++;
      const dataExt = lnDataParaISO(v[idx.ext]);
      const dataAb = lnDataParaISO(v[idx.ab]);
      const comp = dataAb ? dataAb.slice(0, 7) : LN_SEM_DATA;
      const rc = comps[comp] || (comps[comp] = { linhas: 0, linhasSemExtracao: 0, extracao: null, extracoes: new Set(), visto: new Map(), ultimoVisto: new Map(), casos: new Map() });
      rc.linhas++;
      if (!dataExt) { rc.linhasSemExtracao++; return; } // sem data real de extração: nunca se inventa uma
      rc.extracoes.add(dataExt);
      const numeroCaso = lnNormalizarNumeroCaso(casoRaw);
      const gerenteRaw = v[idx.ger];

      // diagnóstico (últimas extrações em que o caso aparece / era explicitamente da operação)
      const vAny = rc.visto.get(numeroCaso);
      if (!vAny || dataExt > vAny) rc.visto.set(numeroCaso, dataExt);
      if (String(gerenteRaw == null ? '' : gerenteRaw).trim().toUpperCase() === LN_GERENTE_OPERACAO) {
        const vUni = rc.ultimoVisto.get(numeroCaso);
        if (!vUni || dataExt > vUni) rc.ultimoVisto.set(numeroCaso, dataExt);
      }

      // Extração mais recente DESTA competência: ao aparecer uma mais nova, descarta o acumulado.
      if (!rc.extracao || dataExt > rc.extracao) { rc.extracao = dataExt; rc.casos = new Map(); }
      if (dataExt !== rc.extracao) return;
      if (!lnGerentePodeSerDoUniverso(gerenteRaw)) return;

      const linha = {
        competencia: comp,
        subStatus: String(v[idx.sub] == null ? '' : v[idx.sub]).trim(),
        pf: String(v[idx.pf] == null ? '' : v[idx.pf]).trim(),
        dataAberturaRaw: v[idx.ab],
        matricula: lnNormalizarMatricula(v[idx.mat]),
        validacaoEmail: String(v[idx.val] == null ? '' : v[idx.val]).trim().toUpperCase(),
        gerente: gerenteRaw,
        atendenteNome: idx.atend >= 0 ? String(v[idx.atend] == null ? '' : v[idx.atend]).trim() : ''
      };
      const arr = rc.casos.get(numeroCaso);
      if (arr) arr.push(linha); else rc.casos.set(numeroCaso, [linha]);
    },
    (lidos, total, linhas) => post({ etapa: 'lendo_planilha', modo: 'fluxo', progresso: Math.min(1, lidos / total), linhasVarridas: linhas })
  );

  if (faltando && faltando.length) {
    post({ etapa: 'erro', codigo: 'CABECALHO_FALTANDO', mensagem: 'Coluna(s) obrigatória(s) não encontrada(s) no arquivo: ' + faltando.join(', ') });
    return;
  }

  const extracaoPorComp = {};
  const competenciasSemExtracao = [];
  const diagnosticoCompetencias = {};
  Object.keys(comps).sort().forEach(c => {
    const rc = comps[c];
    if (!rc.extracao) { competenciasSemExtracao.push({ competencia: c, linhas: rc.linhas }); return; }
    extracaoPorComp[c] = rc.extracao;
    let sumiram = 0, reatribuidos = 0;
    rc.ultimoVisto.forEach((vExt, k) => { if (vExt < rc.extracao) { if (rc.visto.get(k) === rc.extracao) reatribuidos++; else sumiram++; } });
    diagnosticoCompetencias[c] = { extracao: rc.extracao, linhasDaCompetencia: rc.linhas, extracoesDistintas: rc.extracoes.size, linhasSemExtracao: rc.linhasSemExtracao, casosSoEmExtracoesAnteriores: sumiram, casosReatribuidosOutraGerencia: reatribuidos };
  });
  const extracaoMaisRecente = Object.values(extracaoPorComp).sort().pop() || null;
  if (!extracaoMaisRecente) {
    post({ etapa: 'erro', codigo: 'DATA_EXTRACAO_NAO_ENCONTRADA', mensagem: 'Nenhuma "Data de extração" válida foi encontrada no arquivo.' });
    return;
  }
  post({ etapa: 'extraindo_extracao_mais_recente', dataExtracao: extracaoMaisRecente, extracoesPorCompetencia: extracaoPorComp, linhasRealEncontradas: linhasComCaso });

  // Une os casos das extrações escolhidas (agrupa por Número do caso pra duplicidade/conflito).
  const casosPorNumero = {};
  Object.keys(comps).forEach(c => { comps[c].casos.forEach((linhas, numero) => { (casosPorNumero[numero] || (casosPorNumero[numero] = [])).push(...linhas); }); });
  post({ etapa: 'aplicando_elegibilidade', linhasAnalisadas: Object.keys(casosPorNumero).length });

  // Elegibilidade + duplicidade/conflito. "Última linha vence" NUNCA é usado — idêntico nos
  // campos relevantes deduplica; divergente vira conflito, fora do Resultado Oficial.
  const resultado = [];
  let comEmail = 0, semEmail = 0, cancelados = 0, pendenciaClassificacao = 0, naoElegiveis = 0, duplicidadeIdentica = 0, duplicidadeConflito = 0;

  for (const numeroCaso in casosPorNumero) {
    const linhas = casosPorNumero[numeroCaso];
    const base = linhas[0];
    let conflito = false;
    const compDoCaso = base.competencia;

    // Mesmo número de caso caindo em competências diferentes: ambíguo, nunca se escolhe uma.
    if (new Set(linhas.map(l => l.competencia)).size > 1) { conflito = true; duplicidadeConflito++; }
    else if (linhas.length > 1) {
      const assinatura = l => `${l.matricula}|${l.validacaoEmail}|${l.gerente}`;
      if (new Set(linhas.map(assinatura)).size > 1) { conflito = true; duplicidadeConflito++; }
      else duplicidadeIdentica++;
    }

    if (conflito) {
      resultado.push({ numeroCaso, situacao: 'conflito', competencia: compDoCaso === LN_SEM_DATA ? null : compDoCaso, dataExtracao: extracaoPorComp[compDoCaso] || null, linhasEnvolvidas: linhas });
      continue;
    }

    // REGRA DE NEGÓCIO: o indicador mede se o e-mail foi captado NO INGRESSO — Sub Status e
    // Ponto de Fornecimento NÃO excluem o ingresso (seguem gravados só pra diagnóstico).
    const dataAbertura = lnDataParaISO(base.dataAberturaRaw);
    let classificacao = 'PENDENTE_CLASSIFICACAO';
    if (base.validacaoEmail === 'COM EMAIL') { classificacao = 'COM_EMAIL'; comEmail++; }
    else if (base.validacaoEmail === 'SEM EMAIL') { classificacao = 'SEM_EMAIL'; semEmail++; }
    else if (base.validacaoEmail === 'CANCELADO') { classificacao = 'CANCELADO'; cancelados++; }
    else { pendenciaClassificacao++; }

    resultado.push({
      numeroCaso, matricula: base.matricula, dataAbertura, classificacao,
      competencia: dataAbertura ? dataAbertura.slice(0, 7) : null,
      dataExtracao: extracaoPorComp[compDoCaso] || null,
      atendenteNome: base.atendenteNome || '',
      subStatus: base.subStatus || '',
      pontoFornecimento: base.pf || '',
      gerente: base.gerente,
      situacao: 'elegivel'
    });
  }

  post({ etapa: 'duplicidades_avaliadas' });
  post({
    etapa: 'concluido',
    resultado: {
      workerVersao: LN_WORKER_VERSAO,
      dataExtracao: extracaoMaisRecente, // a mais recente de todas (compatibilidade)
      extracoesPorCompetencia: extracaoPorComp,
      diagnosticoCompetencias,
      competenciasSemExtracao,
      leitura: { modo: 'fluxo', linhasXmlVarridas: linhasLidas, bytesDescompactadosDaAba: eAba.descTam, stringsCompartilhadas: sst.length },
      totais: {
        linhasRealEncontradas: linhasComCaso,
        elegiveis: resultado.filter(r => r.situacao === 'elegivel').length,
        naoElegiveis, comEmail, semEmail, cancelados, pendenciaClassificacao,
        duplicidadeIdentica, duplicidadeConflito
      },
      casos: resultado
    }
  });
}

self.onmessage = function (e) {
  const { tipo, file, buffer } = e.data || {};
  if (tipo !== 'processar_base_oficial') return;
  const blob = file || (buffer ? new Blob([buffer]) : null);
  if (!blob) { self.postMessage({ etapa: 'erro', codigo: 'SEM_ARQUIVO', mensagem: 'Nenhum arquivo recebido pelo processamento.' }); return; }
  lnProcessarBase(blob).catch(err => {
    self.postMessage({ etapa: 'erro', codigo: 'ERRO_INESPERADO', mensagem: String((err && err.message) || err) });
  });
};
