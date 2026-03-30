const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/player', (req, res) => res.sendFile(path.join(__dirname, 'public', 'player.html')));

const COLORS = ['red', 'blue', 'green', 'yellow'];
const START_CELLS = { red: 0, blue: 13, green: 26, yellow: 39 };
const HOME_ENTRY  = { red: 50, blue: 11, green: 24, yellow: 37 };
const SAFE_CELLS  = [0, 8, 13, 21, 26, 34, 39, 47];

let gameState = createInitialState();
let clients = new Map();

function createInitialState() {
  return {
    phase: 'lobby',
    players: [],
    pieces: initPieces(),
    currentTurn: null,
    diceValue: null,
    diceRolled: false,
    movablePieces: [],
    winner: null,
    consecutiveSixes: 0,
    log: [],
    seq: 0
  };
}

function initPieces() {
  const p = {};
  COLORS.forEach(c => {
    p[c] = [0,1,2,3].map(i => ({ id: i, color: c, trackPos: -1, homeStretchPos: -1, finished: false }));
  });
  return p;
}

function addLog(msg) {
  gameState.log.unshift(msg);
  if (gameState.log.length > 30) gameState.log.length = 30;
}

function isPlayerFinished(color) {
  return gameState.pieces[color].every(p => p.finished);
}

function nextTurn() {
  const active = gameState.players.filter(p => p.connected && !isPlayerFinished(p.color));
  if (!active.length) return;
  const idx = active.findIndex(p => p.color === gameState.currentTurn);
  gameState.currentTurn = active[(idx + 1) % active.length].color;
  gameState.diceValue = null;
  gameState.diceRolled = false;
  gameState.movablePieces = [];
  gameState.consecutiveSixes = 0;
}

function getMovablePieces(color, dice) {
  const movable = [];
  gameState.pieces[color].forEach(piece => {
    if (piece.finished) return;
    if (piece.trackPos === -1) { if (dice === 6) movable.push(piece.id); return; }
    if (piece.homeStretchPos >= 0) { if (piece.homeStretchPos + dice <= 5) movable.push(piece.id); return; }
    const curAbs = (START_CELLS[color] + piece.trackPos) % 52;
    const stepsToEntry = (HOME_ENTRY[color] - curAbs + 52) % 52 || 52;
    if (dice <= stepsToEntry) { movable.push(piece.id); }
    else { if (dice - stepsToEntry <= 6) movable.push(piece.id); }
  });
  return movable;
}

function movePiece(color, pieceId) {
  const piece = gameState.pieces[color].find(p => p.id === pieceId);
  const dice = gameState.diceValue;
  let captured = false;

  if (piece.trackPos === -1) {
    piece.trackPos = 0;
    addLog(`${emoji(color)} ${color} porta una pedina in gioco`);
    captured = checkCapture(color, piece);
    return captured;
  }

  if (piece.homeStretchPos >= 0) {
    piece.homeStretchPos = Math.min(5, piece.homeStretchPos + dice);
    if (piece.homeStretchPos >= 5) { piece.finished = true; addLog(`🏆 ${emoji(color)} pedina a casa!`); checkWinner(); }
    return false;
  }

  const curAbs = (START_CELLS[color] + piece.trackPos) % 52;
  const stepsToEntry = (HOME_ENTRY[color] - curAbs + 52) % 52 || 52;

  if (dice < stepsToEntry) {
    piece.trackPos += dice;
    captured = checkCapture(color, piece);
  } else {
    const extra = dice - stepsToEntry;
    piece.trackPos = -2;
    piece.homeStretchPos = Math.max(0, extra - 1);
    if (piece.homeStretchPos >= 5) { piece.homeStretchPos = 5; piece.finished = true; addLog(`🏆 ${emoji(color)} pedina a casa!`); checkWinner(); }
  }
  return captured;
}

function checkCapture(attColor, piece) {
  if (piece.trackPos === -2 || piece.trackPos < 0) return false;
  const absPos = (START_CELLS[attColor] + piece.trackPos) % 52;
  if (SAFE_CELLS.includes(absPos)) return false;
  let captured = false;
  COLORS.forEach(color => {
    if (color === attColor || !gameState.players.find(p => p.color === color)) return;
    gameState.pieces[color].forEach(t => {
      if (!t.finished && t.trackPos >= 0 && t.homeStretchPos < 0) {
        if ((START_CELLS[color] + t.trackPos) % 52 === absPos) {
          t.trackPos = -1; t.homeStretchPos = -1; captured = true;
          addLog(`💥 ${emoji(attColor)} cattura pedina di ${color}!`);
        }
      }
    });
  });
  return captured;
}

function checkWinner() {
  const w = gameState.players.find(p => isPlayerFinished(p.color));
  if (w) { gameState.winner = w.color; gameState.phase = 'finished'; addLog(`🎉 ${w.name} ha vinto!`); }
}

function emoji(c) { return {red:'🔴',blue:'🔵',green:'🟢',yellow:'🟡'}[c]||''; }

function broadcast(msg) {
  gameState.seq++;
  const data = JSON.stringify(msg);
  wss.clients.forEach(ws => { if (ws.readyState === WebSocket.OPEN) ws.send(data); });
}
function sendTo(ws, msg) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); }
function broadcastState() { broadcast({ type: 'state', state: gameState }); }

wss.on('connection', (ws) => {
  const id = uuidv4();
  clients.set(ws, { id, color: null, name: null, role: null });
  sendTo(ws, { type: 'hello', id, state: gameState });

  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const client = clients.get(ws);

    switch (msg.type) {

      case 'register_display': {
        client.role = 'display';
        sendTo(ws, { type: 'state', state: gameState });
        break;
      }

      case 'join': {
        if (gameState.phase !== 'lobby') { sendTo(ws, { type: 'error', message: 'Partita già iniziata' }); return; }
        if (gameState.players.length >= 4) { sendTo(ws, { type: 'error', message: 'Lobby piena' }); return; }
        const taken = gameState.players.map(p => p.color);
        const color = COLORS.find(c => !taken.includes(c));
        if (!color) return;
        const name = (msg.name || 'Giocatore').slice(0, 16);
        client.color = color; client.name = name; client.role = 'player';
        gameState.players.push({ id, color, name, connected: true });
        addLog(`${emoji(color)} ${name} è entrato`);
        sendTo(ws, { type: 'joined', color, name });
        broadcastState();
        break;
      }

      case 'start': {
        if (gameState.phase !== 'lobby' || !gameState.players.length) return;
        gameState.phase = 'playing';
        gameState.currentTurn = gameState.players[0].color;
        addLog('🎮 Partita iniziata!');
        broadcastState();
        break;
      }

      case 'roll': {
        if (gameState.phase !== 'playing') return;
        if (client.color !== gameState.currentTurn) { sendTo(ws, { type: 'error', message: 'Non è il tuo turno' }); return; }
        if (gameState.diceRolled) return;

        const dice = Math.floor(Math.random() * 6) + 1;
        gameState.diceValue = dice;
        gameState.diceRolled = true;
        addLog(`${emoji(client.color)} lancia ${dice}`);

        const movable = getMovablePieces(client.color, dice);
        gameState.movablePieces = movable;
        broadcastState();

        if (movable.length === 0) {
          setTimeout(() => {
            if (dice === 6) {
              if (++gameState.consecutiveSixes >= 3) { addLog('⚠️ Tre sei: turno saltato'); nextTurn(); }
              else { gameState.diceRolled = false; gameState.diceValue = null; gameState.movablePieces = []; }
            } else { nextTurn(); }
            broadcastState();
          }, 900);
        } else if (movable.length === 1) {
          setTimeout(() => {
            const cap = movePiece(client.color, movable[0]);
            gameState.movablePieces = [];
            if (gameState.phase !== 'finished') {
              if (dice === 6 || cap) {
                gameState.consecutiveSixes = dice === 6 ? gameState.consecutiveSixes + 1 : 0;
                if (gameState.consecutiveSixes >= 3) { addLog('⚠️ Tre sei: turno saltato'); nextTurn(); }
                else { gameState.diceRolled = false; gameState.diceValue = null; }
              } else { gameState.consecutiveSixes = 0; nextTurn(); }
            }
            broadcastState();
          }, 500);
        }
        break;
      }

      case 'move': {
        if (gameState.phase !== 'playing') return;
        if (client.color !== gameState.currentTurn) return;
        if (!gameState.diceRolled || !gameState.movablePieces.includes(msg.pieceId)) return;
        const cap = movePiece(client.color, msg.pieceId);
        gameState.movablePieces = [];
        if (gameState.phase !== 'finished') {
          const d = gameState.diceValue;
          if (d === 6 || cap) {
            gameState.consecutiveSixes = d === 6 ? gameState.consecutiveSixes + 1 : 0;
            if (gameState.consecutiveSixes >= 3) { addLog('⚠️ Tre sei: turno saltato'); nextTurn(); }
            else { gameState.diceRolled = false; gameState.diceValue = null; }
          } else { gameState.consecutiveSixes = 0; nextTurn(); }
        }
        broadcastState();
        break;
      }

      case 'restart': {
        if (gameState.phase !== 'finished') return;
        const old = gameState.players.map(p => ({...p}));
        gameState = createInitialState();
        old.forEach(p => {
          if ([...clients.values()].find(cl => cl.id === p.id)) gameState.players.push({...p, connected: true});
        });
        addLog('🔄 Nuova partita!');
        broadcastState();
        break;
      }

      case 'reset': {
        gameState = createInitialState();
        clients.forEach(c => { c.color = null; c.name = null; });
        broadcastState();
        break;
      }
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (client?.color) {
      const p = gameState.players.find(p => p.id === client.id);
      if (p) {
        p.connected = false;
        addLog(`❌ ${client.name} disconnesso`);
        if (gameState.currentTurn === client.color && gameState.phase === 'playing') nextTurn();
        broadcastState();
      }
    }
    clients.delete(ws);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎲 Ludo King`);
  console.log(`📺 Display (scacchiera): http://localhost:${PORT}/`);
  console.log(`📱 Giocatori (dado):     http://localhost:${PORT}/player`);
  console.log(`\n🌐 Su rete locale sostituisci localhost con il tuo IP\n`);
});
