const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const pino = require('pino');
const { Boom } = require('@hapi/boom');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
  jidNormalizedUser
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const PREFIX = process.env.PREFIX || '.';
const root = __dirname;
const sessionsDir = path.join(root, 'data', 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const sessions = new Map();

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(root, 'frontend')));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const cleanNumber = n => String(n || '').replace(/\D/g, '');
const validPhone = n => /^[1-9]\d{7,14}$/.test(n);
const sid = n => n.slice(-20);
const errText = e => e?.message || String(e);
const group = jid => String(jid || '').endsWith('@g.us');
const link = text => /(?:https?:\/\/|www\.|wa\.me\/|chat\.whatsapp\.com\/|t\.me\/)/i.test(text || '');
const textOf = m => m?.message?.conversation || m?.message?.extendedTextMessage?.text || m?.message?.imageMessage?.caption || m?.message?.videoMessage?.caption || '';

function sessionInfo(x) {
  return { ok:true, id:x.id, phone:x.phone, status:x.status, code:x.code || null, connectedAt:x.connectedAt || null, lastError:x.lastError || null, user:x.sock?.user || null };
}

function admin(metadata, jid) {
  const p = metadata?.participants?.find(x => jidNormalizedUser(x.id) === jidNormalizedUser(jid));
  return !!p?.admin;
}

function restorable(m) {
  const x = m?.message || {};
  if (x.conversation) return '💬 ' + x.conversation;
  if (x.extendedTextMessage?.text) return '💬 ' + x.extendedTextMessage.text;
  if (x.imageMessage?.caption) return '🖼️ Photo supprimée\n' + x.imageMessage.caption;
  if (x.videoMessage?.caption) return '🎬 Vidéo supprimée\n' + x.videoMessage.caption;
  if (x.audioMessage) return '🎵 Audio supprimé.';
  if (x.documentMessage) return '📄 Document supprimé.';
  if (x.stickerMessage) return '🧩 Sticker supprimé.';
  return 'Contenu supprimé (type non pris en charge).';
}

async function metadata(sock, jid) {
  try { return await sock.groupMetadata(jid); } catch { return null; }
}

async function command(x, msg) {
  const sock = x.sock, jid = msg.key.remoteJid;
  if (!jid || jid === 'status@broadcast') return;
  const text = textOf(msg).trim();
  const sender = msg.key.participant || jid;
  if (group(jid) && x.settings.antiLink && text && link(text)) {
    const md = await metadata(sock, jid);
    if (md && !admin(md, sender)) {
      try { await sock.sendMessage(jid, { delete:{ remoteJid:jid, fromMe:false, id:msg.key.id, participant:sender } }); } catch {}
      return;
    }
  }
  if (!text.startsWith(PREFIX)) return;
  const [raw,...args] = text.slice(PREFIX.length).trim().split(/\s+/);
  const c = (raw || '').toLowerCase(), arg = args.join(' ');
  const md = group(jid) ? await metadata(sock,jid) : null;
  const isAdmin = !group(jid) || admin(md,sender);
  const send = t => sock.sendMessage(jid,{text:t});
  if (c === 'menu' || c === 'help') return send('╭━━━ ⚡ HEXGATE ━━━╮\n┃ .menu\n┃ .ping\n┃ .fakerecording on|off\n┃ .antilink on|off\n┃ .antidelete on|off\n┃ .tagall\n┃ .groupinfo\n┃ .status\n╰━━━━━━━━━━━━━━━━╯');
  if (c === 'ping') return send('⚡ HEXGATE: PONG');
  if (c === 'status') return send(`⚡ HEXGATE STATUS\nConnexion: ${x.status}\nAnti-link: ${x.settings.antiLink?'ON':'OFF'}\nAnti-delete: ${x.settings.antiDelete?'ON':'OFF'}\nFake recording: ${x.settings.fakeRecording?'ON':'OFF'}`);
  if (['fakerecording','antilink','antidelete'].includes(c)) {
    if (!isAdmin) return send('⛔ Commande réservée aux admins.');
    if (!['on','off'].includes(args[0]?.toLowerCase())) return send(`Usage: .${c} on|off`);
    const v = args[0].toLowerCase() === 'on';
    if (c === 'fakerecording') x.settings.fakeRecording=v;
    if (c === 'antilink') x.settings.antiLink=v;
    if (c === 'antidelete') x.settings.antiDelete=v;
    return send(`${c==='fakerecording'?'🎙️ Fake recording':c==='antilink'?'🔗 Anti-link':'♻️ Anti-delete'}: ${v?'ON':'OFF'}`);
  }
  if (c === 'tagall') {
    if (!group(jid) || !md) return send('Cette commande fonctionne dans un groupe.');
    if (!isAdmin) return send('⛔ Commande réservée aux admins.');
    const mentions=md.participants.map(p=>p.id);
    return sock.sendMessage(jid,{text:`📢 ${arg || 'HEXGATE TAG ALL'}\n\n${mentions.map((p,i)=>`${i+1}. @${p.split('@')[0]}`).join('\n')}`,mentions});
  }
  if (c === 'groupinfo') {
    if (!group(jid) || !md) return send('Cette commande fonctionne dans un groupe.');
    return send(`╭━━ GROUP INFO ━━╮\n┃ Nom: ${md.subject || 'N/A'}\n┃ Membres: ${md.participants?.length || 0}\n╰━━━━━━━━━━━━━━╯`);
  }
}

async function start(phone, id=sid(phone)) {
  if (sessions.get(id)?.sock) return sessions.get(id);
  const dir = path.join(sessionsDir,id);
  fs.mkdirSync(dir,{recursive:true});
  const {state,saveCreds}=await useMultiFileAuthState(dir);
  let version;
  try { version=(await fetchLatestBaileysVersion()).version; } catch {}
  const x={id,phone,status:state.creds.registered?'starting':'pairing',code:null,sock:null,connectedAt:null,lastError:null,settings:{fakeRecording:false,antiLink:true,antiDelete:true},cache:new Map(),reconnecting:false};
  sessions.set(id,x);
  const sock=makeWASocket({...(version?{version}:{}),auth:state,browser:Browsers.macOS('Desktop'),printQRInTerminal:false,markOnlineOnConnect:false,syncFullHistory:false,connectTimeoutMs:60000,keepAliveIntervalMs:25000,logger:pino({level:'silent'})});
  x.sock=sock; sock.ev.on('creds.update',saveCreds);
  sock.ev.on('connection.update',async u=>{
    const {connection,lastDisconnect}=u;
    if(connection==='open'){
      x.status='connected'; x.connectedAt=new Date().toISOString(); x.lastError=null;
      logger.info({id},'WhatsApp connected');
      try { const me=jidNormalizedUser(sock.user?.id||''); if(me) await sock.sendMessage(me,{text:'⚡ HEXGATE CONNECTED\n\nVotre bot est maintenant connecté.\nTapez .menu pour les commandes.'}); } catch {}
      return;
    }
    if(connection==='close'){
      const code=lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output?.statusCode : lastDisconnect?.error?.output?.statusCode;
      x.lastError=`WhatsApp closed (${code || 'unknown'})`;
      logger.warn({id,code,error:errText(lastDisconnect?.error)},'WhatsApp connection closed');
      if(code===DisconnectReason.loggedOut){x.status='logged_out';x.sock=null;return;}
      if(!x.reconnecting){
        x.reconnecting=true; x.status='reconnecting';
        setTimeout(async()=>{ try { sessions.delete(id); await start(phone,id); } catch(e){ x.status='error';x.lastError=errText(e);sessions.set(id,x); } }, code===DisconnectReason.restartRequired?500:2000);
      }
    }
  });
  sock.ev.on('messages.upsert',async ({messages,type})=>{
    if(type!=='notify') return;
    for(const m of messages){
      if(!m?.key?.id || !m.message) continue;
      x.cache.set(m.key.id,m); if(x.cache.size>500) x.cache.delete(x.cache.keys().next().value);
      try { await command(x,m); } catch(e){ logger.warn({error:errText(e)},'command handler failed'); }
    }
  });
  sock.ev.on('messages.update',async updates=>{
    if(!x.settings.antiDelete) return;
    for(const u of updates){
      const p=u?.update?.message?.protocolMessage;
      const old=p?.key?.id ? x.cache.get(p.key.id) : null;
      if(!p || !old || !old.key?.remoteJid) continue;
      try { await sock.sendMessage(old.key.remoteJid,{text:'♻️ HEXGATE — message supprimé détecté.\n\n'+restorable(old)}); } catch {}
    }
  });
  if(!state.creds.registered){
    setTimeout(async()=>{
      if(x.status==='connected' || !sessions.has(id)) return;
      try { const code=await sock.requestPairingCode(phone); x.code=String(code).replace(/(.{4})/g,'$1-').replace(/-$/,''); x.status='code_ready'; logger.info({id},'Pairing code generated'); }
      catch(e){x.status='pairing_error';x.lastError=errText(e);logger.error({id,error:errText(e)},'Pairing code failed');}
    },1800);
  }
  return x;
}

app.get('/api/health',(req,res)=>res.json({ok:true,name:'HEXGATE',version:'3.0.0',uptime:process.uptime(),sessions:sessions.size}));
app.post('/api/pair',async(req,res)=>{
  try{
    const phone=cleanNumber(req.body?.phone);
    if(!validPhone(phone)) return res.status(400).json({ok:false,error:'Numéro invalide. Format international sans +, espaces ou tirets.'});
    const id=sid(phone); let x=sessions.get(id);
    if(!x) x=await start(phone,id);
    const deadline=Date.now()+15000;
    while(Date.now()<deadline && !x.code && !['connected','pairing_error','error'].includes(x.status)) await sleep(300);
    if(x.status==='pairing_error') return res.status(502).json({ok:false,id,status:x.status,error:x.lastError});
    res.json({ok:true,id,status:x.status,code:x.code,message:x.code?'Code prêt.':x.status==='connected'?'Session déjà connectée.':'Session encore en initialisation.'});
  }catch(e){res.status(500).json({ok:false,error:errText(e)});}
});
app.get('/api/session/:id',(req,res)=>res.json(sessions.get(req.params.id)?sessionInfo(sessions.get(req.params.id)):{ok:false,status:'not_found'}));
app.post('/api/session/:id/retry',async(req,res)=>{try{const old=sessions.get(req.params.id);try{await old?.sock?.end()}catch{} sessions.delete(req.params.id);const phone=cleanNumber(req.body?.phone||old?.phone);if(!validPhone(phone))return res.status(400).json({ok:false,error:'Numéro invalide.'});const x=await start(phone,req.params.id);res.json(sessionInfo(x));}catch(e){res.status(500).json({ok:false,error:errText(e)});}});
app.post('/api/session/:id/logout',async(req,res)=>{const x=sessions.get(req.params.id);if(!x)return res.status(404).json({ok:false,error:'Session introuvable.'});try{await x.sock?.logout()}catch{}sessions.delete(req.params.id);try{fs.rmSync(path.join(sessionsDir,req.params.id),{recursive:true,force:true})}catch{}res.json({ok:true});});
app.get('*',(req,res)=>res.sendFile(path.join(root,'frontend','index.html')));
const server=app.listen(PORT,'0.0.0.0',()=>logger.info(`HEXGATE listening on ${PORT}`));
const shutdown=async()=>{for(const x of sessions.values())try{await x.sock?.end()}catch{} server.close(()=>process.exit(0));};
process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
