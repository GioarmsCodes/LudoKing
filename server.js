const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.static(path.join(__dirname, 'public')));

// ─── Game State ───────────────────────────────────────────────────────────────

const COLORS = ['red', 'blue', 'green', 'yellow'];
const HOME_POSITIONS = { red: [0,1,2,3], blue: [4,5,6,7], green: [8,9,10,11], yellow: [12,13,14,15] };
const START_CELLS = { red: 0, blue: 13, green: 26, yellow: 39 };
const HOME_ENTRY = { red: 50, blue: 11, green: 24, yellow: 37 };
const HOME_STRETCH = { red: [51,52,53,54,55,56], blue: [57,58,59,60,61,62], green: [63,64,65,66,67,68], yellow: [69,70,71,72,73,74] };
const SAFE_CELLS = [0, 8, 13, 21, 26, 34, 39, 47];

let gameState = createInitialState();
let clients = new Map(); // ws -> {id, color, name}

function createInitialState() {
  return {
    phase: 'lobby', // lobby | playing | finished
    players: [],    // [{id, color, name, connected}]
    pieces: initPieces(),
    currentTurn: null,
    diceValue: null,
    diceRolled: false,
    movablePieces: [],
    winner: null,
    turnCount: 0,
    consecutiveSixes: 0,
    log: []
  };
}

function initPieces() {
  const pieces = {};
  COLORS.forEach(color => {
    pieces[color] = [0,1,2,3].map(i => ({
      id: i,
      color,
      cell: -1,       // -1 = home base, 0-51 = main track, 51-74 = home stretch, 100 = finished
      trackPos: -1,   // position on the main track (0-51)
      homeStretchPos: -1, // position in home stretch (0-5)
      finished: false
    }));
  });
  return pieces;
}

function addLog(msg) {
  gameState.log.unshift(msg);
  if (gameState.log.length > 50) gameState.log.pop();
}

// ─── Game Logic ───────────────────────────────────────────────────────────────

function getActivePlayers() {
  return gameState.players.filter(p => p.connected);
}

function nextTurn() {
  const active = gameState.players.filter(p => p.connected && !isPlayerFinished(p.color));
  if (active.length === 0) return;
  
  const currentIdx = active.findIndex(p => p.color === gameState.currentTurn);
  const nextIdx = (currentIdx + 1) % active.length;
  gameState.currentTurn = active[nextIdx].color;
  gameState.diceValue = null;
  gameState.diceRolled = false;
  gameState.movablePieces = [];
  gameState.consecutiveSixes = 0;
}

function isPlayerFinished(color) {
  return gameState.pieces[color].every(p => p.finished);
}

function rollDice() {
  return Math.floor(Math.random() * 6) + 1;
}

function getMainTrackCell(color, steps) {
  // Returns actual track position (0-51) for a piece starting at its start cell + steps
  return (START_CELLS[color] + steps) % 52;
}

function getMovablePieces(color, dice) {
  const pieces = gameState.pieces[color];
  const movable = [];

  pieces.forEach(piece => {
    if (piece.finished) return;

    if (piece.trackPos === -1) {
      // In home base: need a 6 to come out
      if (dice === 6) movable.push(piece.id);
      return;
    }

    if (piece.homeStretchPos >= 0) {
      // In home stretch
      const newPos = piece.homeStretchPos + dice;
      if (newPos <= 5) movable.push(piece.id);
      return;
    }

    // On main track: check if entering home stretch or moving normally
    const currentAbsPos = (START_CELLS[color] + piece.trackPos) % 52;
    const entryAbs = HOME_ENTRY[color];
    
    // Calculate steps from current position to home entry
    let stepsToEntry = (entryAbs - currentAbsPos + 52) % 52;
    if (stepsToEntry === 0) stepsToEntry = 52; // already past entry

    if (dice <= stepsToEntry) {
      // Can move (either on track or enter stretch)
      movable.push(piece.id);
    } else {
      // Would overshoot home stretch
      const extraSteps = dice - stepsToEntry;
      if (extraSteps <= 6 && piece.homeStretchPos + extraSteps <= 5) {
        movable.push(piece.id);
      }
    }
  });

  return movable;
}

function movePiece(color, pieceId) {
  const piece = gameState.pieces[color].find(p => p.id === pieceId);
  const dice = gameState.diceValue;
  let captured = false;

  if (piece.trackPos === -1 && dice === 6) {
    // Leave home base
    piece.trackPos = 0;
    const cell = START_CELLS[color];
    piece.cell = cell;
    addLog(`${colorEmoji(color)} ${color} porta una pedina in campo`);

    // Check capture
    captured = checkCapture(color, piece, cell);
    return captured;
  }

  if (piece.homeStretchPos >= 0) {
    // Moving in home stretch
    piece.homeStretchPos += dice;
    if (piece.homeStretchPos === 5) {
      piece.finished = true;
      piece.cell = 100;
      addLog(`🏆 ${colorEmoji(color)} ${color} ha portato una pedina a casa!`);
      checkWinner();
    }
    return false;
  }

  // On main track
  const entryAbs = HOME_ENTRY[color];
  const currentAbs = (START_CELLS[color] + piece.trackPos) % 52;
  const stepsToEntry = (entryAbs - currentAbs + 52) % 52 || 52;

  if (dice <= stepsToEntry) {
    piece.trackPos += dice;
    const newAbs = (START_CELLS[color] + piece.trackPos) % 52;
    
    if (dice === stepsToEntry) {
      // Enter home stretch at position 0
      piece.homeStretchPos = 0;
      piece.cell = HOME_STRETCH[color][0];
      piece.trackPos = -2; // sentinel: in home stretch
    } else {
      piece.cell = newAbs;
      captured = checkCapture(color, piece, newAbs);
    }
  } else {
    // Enter home stretch
    const extraSteps = dice - stepsToEntry;
    piece.homeStretchPos = extraSteps - 1;
    piece.cell = HOME_STRETCH[color][piece.homeStretchPos];
    piece.trackPos = -2;
    if (piece.homeStretchPos === 5) {
      piece.finished = true;
      piece.cell = 100;
      addLog(`🏆 ${colorEmoji(color)} ${color} ha portato una pedina a casa!`);
      checkWinner();
    }
  }

  return captured;
}

function checkCapture(attackerColor, piece, cell) {
  if (SAFE_CELLS.includes(cell)) return false;
  
  let captured = false;
  COLORS.forEach(color => {
    if (color === attackerColor) return;
    if (!gameState.players.find(p => p.color === color)) return;
    
    gameState.pieces[color].forEach(target => {
      if (target.cell === cell && !target.finished && target.trackPos >= 0 && target.homeStretchPos < 0) {
        // Captured! Send back home
        target.trackPos = -1;
        target.homeStretchPos = -1;
        target.cell = -1;
        captured = true;
        addLog(`💥 ${colorEmoji(attackerColor)} ${attackerColor} ha catturato una pedina di ${color}!`);
      }
    });
  });
  return captured;
}

function checkWinner() {
  const winner = gameState.players.find(p => isPlayerFinished(p.color));
  if (winner) {
    gameState.winner = winner.color;
    gameState.phase = 'finished';
    addLog(`🎉 ${colorEmoji(winner.color)} ${winner.name} ha vinto la partita!`);
  }
}

function colorEmoji(color) {
  return { red: '🔴', blue: '🔵', green: '🟢', yellow: '🟡' }[color] || '';
}

// ─── WebSocket Handlers ───────────────────────────────────────────────────────

function broadcast(msg) {
  const data = JSON.stringify(msg);
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  });
}

function sendTo(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcastState() {
  broadcast({ type: 'state', state: gameState });
}

wss.on('connection', (ws) => {
  const clientId = uuidv4();
  clients.set(ws, { id: clientId, color: null, name: null });

  sendTo(ws, { type: 'connected', id: clientId, state: gameState });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const client = clients.get(ws);

    switch (msg.type) {

      case 'join': {
        if (gameState.phase !== 'lobby') {
          sendTo(ws, { type: 'error', message: 'Partita già iniziata' });
          return;
        }
        if (gameState.players.length >= 4) {
          sendTo(ws, { type: 'error', message: 'Lobby piena (max 4 giocatori)' });
          return;
        }
        const takenColors = gameState.players.map(p => p.color);
        const availableColor = COLORS.find(c => !takenColors.includes(c));
        if (!availableColor) return;

        const name = (msg.name || 'Giocatore').slice(0, 16);
        client.color = availableColor;
        client.name = name;

        gameState.players.push({ id: clientId, color: availableColor, name, connected: true });
        addLog(`${colorEmoji(availableColor)} ${name} è entrato come ${availableColor}`);
        sendTo(ws, { type: 'joined', color: availableColor, name });
        broadcastState();
        break;
      }

      case 'start': {
        if (gameState.phase !== 'lobby') return;
        if (gameState.players.length < 1) return;
        if (client.color !== gameState.players[0].color) {
          sendTo(ws, { type: 'error', message: 'Solo il primo giocatore può avviare' });
          return;
        }
        gameState.phase = 'playing';
        gameState.currentTurn = gameState.players[0].color;
        addLog('🎮 La partita è iniziata!');
        broadcastState();
        break;
      }

      case 'roll': {
        if (gameState.phase !== 'playing') return;
        if (client.color !== gameState.currentTurn) {
          sendTo(ws, { type: 'error', message: 'Non è il tuo turno' });
          return;
        }
        if (gameState.diceRolled) {
          sendTo(ws, { type: 'error', message: 'Dado già lanciato' });
          return;
        }

        const dice = rollDice();
        gameState.diceValue = dice;
        gameState.diceRolled = true;

        addLog(`${colorEmoji(client.color)} ${client.color} ha lanciato: ${dice}`);

        const movable = getMovablePieces(client.color, dice);
        gameState.movablePieces = movable;

        if (movable.length === 0) {
          addLog(`${colorEmoji(client.color)} ${client.color} non ha mosse disponibili`);
          setTimeout(() => {
            if (dice === 6) {
              gameState.consecutiveSixes++;
              if (gameState.consecutiveSixes >= 3) {
                addLog(`⚠️ ${client.color} tre sei di fila: turno saltato`);
                nextTurn();
              } else {
                gameState.diceRolled = false;
                gameState.diceValue = null;
                gameState.movablePieces = [];
              }
            } else {
              nextTurn();
            }
            broadcastState();
          }, 1200);
        } else if (movable.length === 1) {
          // Auto-move if only one option
          setTimeout(() => {
            const captured = movePiece(client.color, movable[0]);
            gameState.movablePieces = [];
            
            if (gameState.phase !== 'finished') {
              if (dice === 6 || captured) {
                gameState.consecutiveSixes = dice === 6 ? gameState.consecutiveSixes + 1 : 0;
                if (gameState.consecutiveSixes >= 3) {
                  addLog(`⚠️ Tre sei di fila: turno saltato`);
                  nextTurn();
                } else {
                  gameState.diceRolled = false;
                  gameState.diceValue = null;
                }
              } else {
                gameState.consecutiveSixes = 0;
                nextTurn();
              }
            }
            broadcastState();
          }, 600);
        } else {
          broadcastState();
        }
        break;
      }

      case 'move': {
        if (gameState.phase !== 'playing') return;
        if (client.color !== gameState.currentTurn) return;
        if (!gameState.diceRolled) return;
        if (!gameState.movablePieces.includes(msg.pieceId)) return;

        const captured = movePiece(client.color, msg.pieceId);
        gameState.movablePieces = [];

        if (gameState.phase !== 'finished') {
          const dice = gameState.diceValue;
          if (dice === 6 || captured) {
            gameState.consecutiveSixes = dice === 6 ? gameState.consecutiveSixes + 1 : 0;
            if (gameState.consecutiveSixes >= 3) {
              addLog(`⚠️ Tre sei di fila: turno saltato`);
              nextTurn();
            } else {
              gameState.diceRolled = false;
              gameState.diceValue = null;
            }
          } else {
            gameState.consecutiveSixes = 0;
            nextTurn();
          }
        }
        broadcastState();
        break;
      }

      case 'restart': {
        if (gameState.phase !== 'finished') return;
        gameState = createInitialState();
        // Re-add players
        clients.forEach((c, clientWs) => {
          if (c.color) {
            const player = { id: c.id, color: c.color, name: c.name, connected: true };
            gameState.players.push(player);
          }
        });
        addLog('🔄 Nuova partita iniziata!');
        broadcastState();
        break;
      }

      case 'reset': {
        gameState = createInitialState();
        clients.forEach((c) => { c.color = null; c.name = null; });
        addLog('🔄 Lobby resettata');
        broadcastState();
        break;
      }
    }
  });

  ws.on('close', () => {
    const client = clients.get(ws);
    if (client && client.color) {
      const player = gameState.players.find(p => p.id === client.id);
      if (player) {
        player.connected = false;
        addLog(`❌ ${client.name} si è disconnesso`);
        // If it's their turn, skip
        if (gameState.currentTurn === client.color && gameState.phase === 'playing') {
          nextTurn();
        }
        broadcastState();
      }
    }
    clients.delete(ws);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎲 Ludo King Server running!`);
  console.log(`📡 Local:   http://localhost:${PORT}`);
  console.log(`🌐 Network: http://YOUR_IP:${PORT}`);
  console.log(`\nCondividi l'IP di rete con i tuoi giocatori!\n`);
});
