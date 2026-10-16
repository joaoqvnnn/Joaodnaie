const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const express = require('express');
const pino = require('pino');

// ============================================================
// CONFIGURAÇÕES — EDITE AQUI
// ============================================================
const CONFIG = {
  // O número será puxado automaticamente das variáveis do Render
  NUMERO_DONO: process.env.NUMERO_DONO || '5511999999999',

  // Nome do bot (aparece nas mensagens)
  NOME_BOT: '🛡️ AntiNuke Bot',

  // Grupos onde a proteção está ATIVA (JIDs)
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
    auth: state,
    browser: ['AntiNuke Bot', 'Chrome', '1.0.0'],
    generateHighQualityLinkPreview: false,
  });

  // Salvar credenciais
  sock.ev.on('creds.update', saveCreds);

  // ==========================================================
  // CONEXÃO E CÓDIGO DE PAREAMENTO
  // ==========================================================
  let codigoGerado = false; // Evita pedir código repetido (causa bloqueio no WhatsApp)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    // Gera o código de pareamento APENAS UMA VEZ
    if (qr && !codigoGerado) {
      codigoGerado = true;
      try {
        // Espera 3 segundos para garantir que o socket esteja pronto
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        const numero = CONFIG.NUMERO_DONO;
        const codigo = await sock.requestPairingCode(numero);
        
        log(`🔑 SEU CÓDIGO DE PAREAMENTO É: ${codigo}`);
        log(`📱 Abra o WhatsApp no celular > Dispositivos Conectados > Conectar com número de telefone > Digite o código AGORA.`);
      } catch (e) {
        log(`❌ Erro ao gerar código de pareamento: ${e.message}`);
      }
    }

    if (connection === 'close') {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) {
        log('🔄 Reconectando...');
        codigoGerado = false; // Permite gerar novo código se cair
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
          text: `${CONFIG.NOME_BOT} está online! 🛡️\n\nProteção anti-nuke ativada.`,
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

      if (!grupoEhProtegido(groupJid)) return;
      if (ehDono(author)) return;
      if (author === sock.user.id) return;

      const metadata = await sock.groupMetadata(groupJid);
      groupCache.set(groupJid, metadata);

      const botParticipante = metadata.participants.find(
        (p) => p.id === sock.user.id
      );
      const botEhAdmin = botParticipante?.admin === 'admin' ||
                         botParticipante?.admin === 'superadmin';

      // 🚨 DETECÇÃO 1: AUTO-PROMOÇÃO
      if (action === 'promote') {
        for (const participante of participants) {
          if (autorPromoveuASiMesmo(author, participante)) {
            log(`🚨 AUTO-PROMOÇÃO detectada! ${author} se promoveu em ${groupJid}`);
            await banirDoGrupo(sock, groupJid, [author], botEhAdmin);
            await notificarDono(sock, groupJid, author, 'AUTO-PROMOÇÃO',
              `Tentou se promover a ADM sem permissão.`);
            return;
          }
        }
      }

      // 🚨 DETECÇÃO 2: DEMOTE INDEVIDO
      if (action === 'demote') {
        for (const participante of participants) {
          const alvo = metadata.participants.find((p) => p.id === participante);
          if (!alvo) continue;

          if (alvo.admin && !ehDono(author)) {
            log(`🚨 DEMOTE INDEVIDO! ${author} rebaixou ${participante} em ${groupJid}`);
            registrarAcao(author, 'demotes');

            if (botEhAdmin) {
              try {
                await sock.groupParticipantsUpdate(groupJid, [participante], 'promote');
                log(`↩️ ${participante} foi repromovido a ADM.`);
              } catch (e) {
                log(`⚠️ Não foi possível repromover: ${e.message}`);
              }
            }

            await banirDoGrupo(sock, groupJid, [author], botEhAdmin);
            await notificarDono(sock, groupJid, author, 'DEMOTE INDEVIDO',
              `Tentou rebaixar o ADM ${participante}.`);
            await verificarRajada(sock, groupJid, author, botEhAdmin);
            return;
          }
        }
      }

      // 🚨 DETECÇÃO 3: NUKE (Rajada de remoções)
      if (action === 'remove') {
        registrarAcao(author, 'removes');
        await verificarRajada(sock, groupJid, author, botEhAdmin);
      }

      // 🚨 DETECÇÃO 4: ADIÇÃO EM MASSA
      if (action === 'add') {
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
      await sock.groupParticipantsUpdate(groupJid, [jid], 'remove');
      log(`🔨 ${jid} foi REMOVIDO do grupo ${groupJid}.`);
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
