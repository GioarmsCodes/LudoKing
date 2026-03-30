# 🎲 Ludo King - Multiplayer

Gioco da tavolo Ludo online per 1-4 giocatori, hostato sul tuo laptop.

## 🚀 Avvio rapido

```bash
# Installa dipendenze (solo la prima volta)
npm install

# Avvia il server
npm start
```

Il server partirà su `http://localhost:3000`

## 🌐 Come giocare con altri

1. **Trova il tuo IP locale:**
   - **Windows:** Apri cmd → `ipconfig` → cerca "IPv4 Address" (es: `192.168.1.10`)
   - **Mac/Linux:** Apri terminale → `ifconfig` o `ip addr` (es: `192.168.1.10`)

2. **Condividi l'indirizzo** con i tuoi giocatori: `192.168.1.10:3000`

3. **Ogni giocatore** apre il browser e va su `http://192.168.1.10:3000`

4. I giocatori inseriscono il loro nome e l'IP del server, poi cliccano "Connettiti"

5. Il **primo giocatore** connesso è il **host** e può avviare la partita

## 🎮 Regole

- Da 1 a 4 giocatori (rosso, blu, verde, giallo)
- Ogni giocatore lancia il dado quando è il suo turno
- **Dado 6:** Puoi portare una pedina in campo + tiro extra
- **Cattura:** Atterrando su una pedina avversaria la mandi a casa
- **Celle sicure** (⭐): Nessuna cattura possibile
- **Vittoria:** Porta tutte e 4 le pedine nella zona finale

## 📁 Struttura

```
ludo-king/
├── server.js      # Server WebSocket + logica di gioco
├── public/
│   └── index.html # Client del gioco
└── package.json
```
