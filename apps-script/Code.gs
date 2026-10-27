/**
 * M3 Solutions CRM — documentos dos clientes no Google Drive
 *
 * Web App do Google Apps Script. O CRM manda o login do Firebase (idToken) junto de cada pedido.
 * O script confere o acesso lendo o próprio card no Firestore COM o token do usuário, então valem as
 * mesmas regras do CRM: o consultor só mexe em documentos de clientes dele; master e Backoffice em todos.
 *
 * Configuração (Configurações do projeto → Propriedades do script):
 *   ROOT_FOLDER_ID = id da pasta raiz no Drive (a parte final do endereço da pasta)
 *
 * Os arquivos ficam privados na conta dona do script. Nada é compartilhado por link.
 */

var PROJETO_FIREBASE = 'crm-conex-4ceaf';
var MAX_BYTES = 20 * 1024 * 1024;
var TIPOS_OK = {
  'application/pdf': 1, 'image/jpeg': 1, 'image/png': 1, 'image/webp': 1,
  'application/zip': 1, 'application/vnd.rar': 1, 'application/x-7z-compressed': 1,
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 1,
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 1
};

function doGet() {
  return json_({ ok: true, servico: 'Documentos M3 Solutions' });
}

function doPost(e) {
  try {
    var req = JSON.parse(e.postData.contents);
    if (!req || !req.idToken || !req.acao) throw erro_('pedido-invalido', 'Pedido incompleto.');
    var usuario = autenticar_(req.idToken);
    var card = carregarCard_(req.origem, req.idToken);

    if (req.acao === 'listar') return json_({ ok: true, arquivos: listar_(card) });
    if (req.acao === 'enviar') return json_({ ok: true, arquivo: enviar_(card, usuario, req) });
    if (req.acao === 'baixar') return json_(Object.assign({ ok: true }, baixar_(card, req.id)));
    if (req.acao === 'excluir') return json_({ ok: true, removido: excluir_(card, usuario, req.id) });
    throw erro_('acao-invalida', 'Ação desconhecida.');
  } catch (err) {
    return json_({ ok: false, codigo: err.codigo || 'erro', erro: err.message || String(err) });
  }
}

// ---------- autenticação e autorização (via Firestore, com o token do usuário) ----------

function autenticar_(idToken) {
  var partes = String(idToken).split('.');
  if (partes.length !== 3) throw erro_('token-invalido', 'Login inválido.');
  var b64 = partes[1].replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  var payload = JSON.parse(Utilities.newBlob(Utilities.base64Decode(b64)).getDataAsString());
  var uid = payload.user_id || payload.sub;
  if (!uid || payload.aud !== PROJETO_FIREBASE || payload.exp * 1000 < Date.now()) {
    throw erro_('token-invalido', 'Login expirado. Entre de novo no CRM.');
  }
  // O Firestore valida a assinatura do token: se ele aceitar a leitura, o usuário é quem diz ser e está cadastrado.
  var mapa = firestoreGet_('config/uid_map', idToken);
  var chave = null;
  var rev = campo_(mapa, '_rev');
  if (rev && rev.mapValue && rev.mapValue.fields && rev.mapValue.fields[uid]) {
    chave = rev.mapValue.fields[uid].stringValue;
  }
  var master = campo_(mapa, 'master');
  var ehMaster = !!(master && master.stringValue === uid);
  if (!chave && ehMaster) chave = 'master';
  if (!chave) throw erro_('sem-acesso', 'Usuário não cadastrado no CRM.');

  var privilegiado = ehMaster;
  if (!privilegiado) {
    var us = firestoreGet_('config/usuarios', idToken);
    var perfil = campo_(us, chave);
    var flag = perfil && perfil.mapValue && perfil.mapValue.fields && perfil.mapValue.fields.podeBackoffice;
    privilegiado = !!(flag && flag.booleanValue === true);
  }
  return { uid: uid, chave: chave, privilegiado: privilegiado };
}

function carregarCard_(origem, idToken) {
  var m = /^(proposta|backoffice):([A-Za-z0-9]{10,40})$/.exec(String(origem || ''));
  if (!m) throw erro_('origem-invalida', 'Card inválido.');
  var colecao = m[1] === 'proposta' ? 'propostas' : 'backoffice';
  // Se as regras do Firestore não deixarem este usuário ler o card, o acesso é negado aqui também.
  var doc = firestoreGet_(colecao + '/' + m[2], idToken);
  var cnpj = String((campo_(doc, 'cnpj') || {}).stringValue || '').replace(/\D/g, '');
  if (cnpj.length !== 14) throw erro_('sem-cnpj', 'O card precisa ter o CNPJ do cliente.');
  return {
    cnpj: cnpj,
    razao: String((campo_(doc, 'razao') || {}).stringValue || ''),
    consultor: String((campo_(doc, 'consultor') || {}).stringValue || '')
  };
}

function firestoreGet_(caminho, idToken) {
  var url = 'https://firestore.googleapis.com/v1/projects/' + PROJETO_FIREBASE + '/databases/(default)/documents/' + caminho;
  var r = UrlFetchApp.fetch(url, { headers: { Authorization: 'Bearer ' + idToken }, muteHttpExceptions: true });
  var codigo = r.getResponseCode();
  if (codigo === 200) return JSON.parse(r.getContentText());
  if (codigo === 401) throw erro_('token-invalido', 'Login expirado. Entre de novo no CRM.');
  throw erro_('sem-acesso', 'Sem acesso a este cliente.');
}

function campo_(doc, nome) {
  return doc && doc.fields ? doc.fields[nome] : null;
}

// ---------- Drive ----------

function raiz_() {
  var id = PropertiesService.getScriptProperties().getProperty('ROOT_FOLDER_ID');
  if (!id) throw erro_('config', 'ROOT_FOLDER_ID não configurado no script.');
  return DriveApp.getFolderById(id);
}

function pastaCliente_(card, criar) {
  var raiz = raiz_();
  var it = raiz.searchFolders("title contains '" + card.cnpj + "' and trashed = false");
  if (it.hasNext()) return it.next();
  if (!criar) return null;
  var nome = card.cnpj + ' - ' + String(card.razao).replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 80);
  return raiz.createFolder(nome);
}

function descricao_(arquivo) {
  try { return JSON.parse(arquivo.getDescription() || '{}'); } catch (e) { return {}; }
}

function arquivoDaPasta_(card, id) {
  var pasta = pastaCliente_(card, false);
  if (!pasta) throw erro_('nao-encontrado', 'Documento não encontrado.');
  var arquivo;
  try { arquivo = DriveApp.getFileById(String(id)); } catch (e) { throw erro_('nao-encontrado', 'Documento não encontrado.'); }
  var pais = arquivo.getParents();
  if (!pais.hasNext() || pais.next().getId() !== pasta.getId() || arquivo.isTrashed()) {
    throw erro_('nao-encontrado', 'Documento não encontrado.');
  }
  return arquivo;
}

function listar_(card) {
  var pasta = pastaCliente_(card, false);
  if (!pasta) return [];
  var out = [];
  var it = pasta.getFiles();
  while (it.hasNext()) {
    var f = it.next();
    if (f.isTrashed()) continue;
    var d = descricao_(f);
    out.push({
      id: f.getId(), nome: f.getName(), tipo: f.getMimeType(), tamanho: f.getSize(),
      criadoEm: f.getDateCreated().getTime(), autor: d.autor || ''
    });
  }
  return out;
}

function enviar_(card, usuario, req) {
  var tipo = String(req.tipo || '');
  if (!TIPOS_OK[tipo]) throw erro_('tipo-invalido', 'Tipo de arquivo não permitido.');
  var b64 = String(req.dados || '');
  if (!b64) throw erro_('arquivo-vazio', 'Arquivo vazio.');
  if (b64.length * 0.75 > MAX_BYTES) throw erro_('arquivo-grande', 'O arquivo passa de 20 MB.');
  var nome = String(req.nome || 'documento').replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 120) || 'documento';
  var blob = Utilities.newBlob(Utilities.base64Decode(b64), tipo, nome);
  var pasta = pastaCliente_(card, true);
  var arquivo = pasta.createFile(blob);
  arquivo.setDescription(JSON.stringify({ autor: usuario.chave, consultor: card.consultor, data: Date.now() }));
  return { id: arquivo.getId(), nome: arquivo.getName(), tipo: arquivo.getMimeType(), tamanho: arquivo.getSize(), criadoEm: Date.now(), autor: usuario.chave };
}

function baixar_(card, id) {
  var arquivo = arquivoDaPasta_(card, id);
  var blob = arquivo.getBlob();
  return { nome: arquivo.getName(), tipo: arquivo.getMimeType(), dados: Utilities.base64Encode(blob.getBytes()) };
}

function excluir_(card, usuario, id) {
  var arquivo = arquivoDaPasta_(card, id);
  var d = descricao_(arquivo);
  if (!usuario.privilegiado && d.autor !== usuario.chave) {
    throw erro_('sem-permissao', 'Só quem anexou, o Backoffice ou o master pode excluir.');
  }
  arquivo.setTrashed(true);
  return true;
}

// ---------- utilitários ----------

function erro_(codigo, mensagem) {
  var e = new Error(mensagem);
  e.codigo = codigo;
  return e;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
