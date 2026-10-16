const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

// ============================================================
// CONFIGURAÇÕES — EDITE AQUI
// ============================================================
const CONFIG = {
  // Número do dono (com DDI e DDD, sem +, sem espaços)
  // Ex: '5511999999999'
  NUMERO_DONO: '5511999999999',

  // Nome do bot (aparece nas mensagens)
  NOME_BOT: '🛡️ AntiNuke Bot',

  // Grupos onde a proteção está ATIVA (JIDs)
  // Ex: ['120363123456789@g.us']
  // Deixe vazio [] para proteger TODOS os grupos que o bot participar
  GRUPOS_PROTEGIDOS: [],

  // Tempo (em ms) para agrupar ações suspeitas em "rajada"
  JANELA_RAJADA_MS: 3000,

  // Número mínimo de ações suspeitas para banir em massa
  LIMITE_RAJADA: 3,
};

// ============================================================
// ESTADO
// ============================================================
const app = express();
const PORT = process.env.PORT || 3000;

// Cache de metadados dos grupos
const groupCache = new Map();

// Registro de ações por usuário (para detectar rajadas)
// { jid: { demotes: [], promotes: [], removes: [] } }
const registroAcoes = new Map();

// ============================================================
// FUNÇÕES AUXILIARES
// ============================================================

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function limparRegistro(jid) {
  setTimeout(() => {
    registroAcoes.delete(jid);
  }, CONFIG.JANELA_RAJADA_MS * 2);
}

function registrarAcao(jid, tipo) {
  if (!registroAcoes.has(jid)) {
    registroAcoes.set(jid, { demotes: 0, promotes: 0, removes: 0 });
  }
  const reg = registroAcoes.get(jid);
  reg[tipo] = (reg[tipo] || 0) + 1;
  limparRegistro(jid);
}

function ehDono(jid) {
  return jid && jid.includes(CONFIG.NUMERO_DONO);
}

function grupoEhProtegido(groupJid) {
  if (CONFIG.GRUPOS_PROTEGIDOS.length === 0) return true;
  return CONFIG.GRUPOS_PROTEGIDOS.includes(groupJid);
}

// ============================================================
// INICIALIZAÇÃO DO BOT
// ============================================================
async function iniciarBot() {
  const { state, saveCreds } = await useMultiFileAuthState('./sessao');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    auth: state,
    browser: ['AntiNuke Bot', 'Chrome', '1.0.0'],
    generateHighQualityLinkPreview: false,
  });

  // Salvar credenciais
  sock.ev.on('creds.update', saveCreds);

  // ==========================================================
  // CONEXÃO
  // ==========================================================
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        log('🔄 Reconectando...');
        iniciarBot();
      } else {
        log('❌ Sessão encerrada. Apague a pasta ./sessao e reinicie.');
      }
    } else if (connection === 'open') {
      log('✅ Bot conectado com sucesso!');
      log(`🛡️ Proteção ativa no número: ${CONFIG.NUMERO_DONO}`);

      // Envia mensagem de boas-vindas ao dono
      try {
        await sock.sendMessage(`${CONFIG.NUMERO_DONO}@s.whatsapp.net`, {
          text: `${CONFIG.NOME_BOT} está online! 🛡️\n\nProteção anti-nuke ativada.\nGrupos protegidos: ${CONFIG.GRUPOS_PROTEGIDOS.length === 0 ? 'TODOS' : CONFIG.GRUPOS_PROTEGIDOS.join(', ')}`,
        });
      } catch (e) {
        log('⚠️ Não foi possível enviar mensagem ao dono: ' + e.message);
      }
    }
  });

  // ==========================================================
  // EVENTO: MUDANÇA DE PARTICIPANTES (PROMOTE / DEMOTE / REMOVE / ADD)
  // ==========================================================
  sock.ev.on('group-participants.update', async (update) => {
    try {
      const { id: groupJid, participants, action, author } = update;

      // Ignora se o grupo não é protegido
      if (!grupoEhProtegido(groupJid)) return;

      // Ignora se a ação foi feita pelo DONO (ele pode tudo)
      if (ehDono(author)) return;

      // Ignora se o autor é o próprio bot
      if (author === sock.user.id) return;

      // Obtém metadados atualizados do grupo
      const metadata = await sock.groupMetadata(groupJid);
      groupCache.set(groupJid, metadata);

      // Verifica se o bot é ADM no grupo (necessário para banir)
      const botParticipante = metadata.participants.find(
        (p) => p.id === sock.user.id
      );
      const botEhAdmin = botParticipante?.admin === 'admin' ||
                         botParticipante?.admin === 'superadmin';

      // ==========================================================
      // 🚨 DETECÇÃO 1: Alguém tentou SE PROMOVER a ADM
      // ==========================================================
      if (action === 'promote') {
        for (const participante of participants) {
          // O autor promoveu a si mesmo?
          if (autorPromoveuASiMesmo(author, participante)) {
            log(`🚨 AUTO-PROMOÇÃO detectada! ${author} se promoveu em ${groupJid}`);
            await banirDoGrupo(sock, groupJid, [author], botEhAdmin);
            await notificarDono(sock, groupJid, author, 'AUTO-PROMOÇÃO',
              `Tentou se promover a ADM sem permissão.`);
            return;
          }
        }
      }

      // ==========================================================
      // 🚨 DETECÇÃO 2: Alguém tentou REBAIXAR (demote) um ADM
      // ==========================================================
      if (action === 'demote') {
        for (const participante of participants) {
          // Verifica se o alvo era ADM
          const alvo = metadata.participants.find((p) => p.id === participante);
          if (!alvo) continue;

          // O autor NÃO é o dono e está rebaixando outro ADM?
          if (alvo.admin && !ehDono(author)) {
            log(`🚨 DEMOTE INDEVIDO! ${author} rebaixou ${participante} em ${groupJid}`);

            // Registra a ação para detectar rajada
            registrarAcao(author, 'demotes');

            // Tenta reverter o demote
            if (botEhAdmin) {
              try {
                await sock.groupParticipantsUpdate(groupJid, [participante], 'promote');
                log(`↩️ ${participante} foi repromovido a ADM.`);
              } catch (e) {
                log(`⚠️ Não foi possível repromover: ${e.message}`);
              }
            }

            // Bane o autor do demote
            await banirDoGrupo(sock, groupJid, [author], botEhAdmin);
            await notificarDono(sock, groupJid, author, 'DEMOTE INDEVIDO',
              `Tentou rebaixar o ADM ${participante}.`);

            // Verifica rajada
            await verificarRajada(sock, groupJid, author, botEhAdmin);
            return;
          }
        }
      }

      // ==========================================================
      // 🚨 DETECÇÃO 3: NUKE — Muitas remoções em sequência
      // ==========================================================
      if (action === 'remove') {
        registrarAcao(author, 'removes');

        // Verifica se é uma rajada (nuke)
        await verificarRajada(sock, groupJid, author, botEhAdmin);
      }

      // ==========================================================
      // 🚨 DETECÇÃO 4: Adição suspeita (bots/adicionar em massa)
      // ==========================================================
      if (action === 'add') {
        // Se alguém adicionou 3+ pessoas de uma vez sem ser dono
        if (participants.length >= 3 && !ehDono(author)) {
          log(`🚨 ADIÇÃO EM MASSA! ${author} adicionou ${participants.length} pessoas em ${groupJid}`);
          await banirDoGrupo(sock, groupJid, [author], botEhAdmin);
          await notificarDono(sock, groupJid, author, 'ADIÇÃO EM MASSA',
            `Adicionou ${participants.length} pessoas de uma vez.`);
        }
      }

    } catch (err) {
      log(`❌ Erro no handler de participantes: ${err.message}`);
    }
  });

  // ==========================================================
  // EVENTO: MENSAGENS (detecção de comandos "nuke" no chat)
  // ==========================================================
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      try {
        if (!msg.message) continue;

        const groupJid = msg.key.remoteJid;
        if (!groupJid?.endsWith('@g.us')) continue;
        if (!grupoEhProtegido(groupJid)) continue;

        const sender = msg.key.participant || msg.key.remoteJid;
        if (ehDono(sender)) continue;

        const texto = extrairTexto(msg);
        if (!texto) continue;

        // Detecta comandos de "nuke" ou "ban all"
        const padroesNuke = [
          /\.?nuke/i,
          /\.?ban\s*all/i,
          /\.?banir\s*todos/i,
          /\.?kick\s*all/i,
          /\.?raid/i,
        ];

        for (const padrao of padroesNuke) {
          if (padrao.test(texto)) {
            log(`🚨 COMANDO NUKE detectado! ${sender} enviou: "${texto.substring(0, 50)}"`);
            await banirDoGrupo(sock, groupJid, [sender], true);
            await notificarDono(sock, groupJid, sender, 'COMANDO NUKE',
              `Enviou comando suspeito: "${texto.substring(0, 100)}"`);
            break;
          }
        }
      } catch (e) {
        // ignora erros individuais
      }
    }
  });

  return sock;
}

// ============================================================
// FUNÇÕES DE PROTEÇÃO
// ============================================================

function autorPromoveuASiMesmo(author, participante) {
  if (!author || !participante) return false;
  // author = quem fez a ação, participante = quem foi promovido
  const authorNum = author.split('@')[0].split(':')[0];
  const partNum = participante.split('@')[0].split(':')[0];
  return authorNum === partNum;
}

async function banirDoGrupo(sock, groupJid, jids, botEhAdmin) {
  if (!botEhAdmin) {
    log(`⚠️ Bot não é ADM em ${groupJid}. Não é possível banir.`);
    return false;
  }

  for (const jid of jids) {
    try {
      // 1. Remove do grupo
      await sock.groupParticipantsUpdate(groupJid, [jid], 'remove');
      log(`🔨 ${jid} foi REMOVIDO do grupo ${groupJid}.`);

      // 2. Bloqueia o usuário
      await sock.updateBlockStatus(jid, 'block');
      log(`🚫 ${jid} foi BLOQUEADO.`);

    } catch (e) {
      log(`❌ Erro ao banir ${jid}: ${e.message}`);
    }
  }
  return true;
}

async function verificarRajada(sock, groupJid, author, botEhAdmin) {
  const reg = registroAcoes.get(author);
  if (!reg) return;

  const totalRemoves = reg.removes || 0;
  const totalDemotes = reg.demotes || 0;

  if (totalRemoves >= CONFIG.LIMITE_RAJADA || totalDemotes >= CONFIG.LIMITE_RAJADA) {
    log(`🚨🚨 RAJADA DETECTADA! ${author} executou ${totalRemoves} removes e ${totalDemotes} demotes em ${CONFIG.JANELA_RAJADA_MS}ms!`);
    await banirDoGrupo(sock, groupJid, [author], botEhAdmin);
    await notificarDono(sock, groupJid, author, 'RAJADA DE AÇÕES (NUKE)',
      `Executou ${totalRemoves} remoções e ${totalDemotes} demotes em sequência rápida.`);
    registroAcoes.delete(author);
  }
}

async function notificarDono(sock, groupJid, infrator, tipo, detalhe) {
  try {
    const metadata = groupCache.get(groupJid) || await sock.groupMetadata(groupJid);
    const nomeGrupo = metadata.subject || groupJid;

    const msg = `${CONFIG.NOME_BOT} — ALERTA DE SEGURANÇA\n\n` +
      `📌 *Tipo:* ${tipo}\n` +
      `👥 *Grupo:* ${nomeGrupo}\n` +
      `🚫 *Infrator:* ${infrator.split('@')[0]}\n` +
      `📝 *Detalhe:* ${detalhe}\n` +
      `⏰ *Data:* ${new Date().toLocaleString('pt-BR')}`;

    await sock.sendMessage(`${CONFIG.NUMERO_DONO}@s.whatsapp.net`, { text: msg });
    log(`📩 Dono notificado sobre ${tipo} de ${infrator}.`);
  } catch (e) {
    log(`⚠️ Erro ao notificar dono: ${e.message}`);
  }
}

function extrairTexto(msg) {
  const m = msg.message;
  if (!m) return null;
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    null
  );
}

// ============================================================
// SERVIDOR EXPRESS (necessário para manter vivo no Render)
// ============================================================
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    bot: CONFIG.NOME_BOT,
    grupos_protegidos: CONFIG.GRUPOS_PROTEGIDOS.length || 'TODOS',
    uptime: process.uptime(),
  });
});

app.listen(PORT, () => {
  log(`🌐 Servidor HTTP rodando na porta ${PORT}`);
});

// ============================================================
// INICIA O BOT
// ============================================================
iniciarBot().catch((err) => {
  log(`❌ Erro fatal: ${err.message}`);
  process.exit(1);
});
