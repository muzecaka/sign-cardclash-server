require("dotenv").config();
const express = require("express");
const { Server } = require("socket.io");
const http = require("http");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);

// Use CLIENT_URL from .env, split by comma for multiple origins
const allowedOrigins = (
  process.env.CLIENT_URL ||
  "http://localhost:3000,https://sign-cardclash.vercel.app"
).split(",");

const io = new Server(server, {
  cors: {
    origin: allowedOrigins,
    methods: ["GET", "POST"],
  },
});

// ... (rest of your 658-line index.js remains unchanged)

// In-memory game storage
const games = new Map();
const timers = new Map();

// Generate 6-character code (e.g., ABC123)
function generateInviteCode(length = 6) {
  return crypto
    .randomBytes(Math.ceil(length / 2))
    .toString("hex")
    .slice(0, length)
    .toUpperCase();
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function calculateLeaderboard(players, allParticipants = null) {
  const target = allParticipants || players;
  return [...target]
    .sort((a, b) => b.score - a.score)
    .map((p, index) => ({
      ...p,
      rank: index + 1,
    }));
}

// Cleanup stale games (older than 24 hours)
setInterval(() => {
  const now = Date.now();
  for (const [gameId, game] of games) {
    if (now - game.createdAt > 24 * 60 * 60 * 1000) {
      const timerInterval = timers.get(gameId);
      if (timerInterval) clearInterval(timerInterval);
      timers.delete(gameId);
      games.delete(gameId);
      io.to(gameId).emit("gameEnded", { message: "Game expired." });
      io.to(gameId).emit("chatMessage", {
        userId: "System",
        text: "Game expired and was removed.",
        role: "system",
        timestamp: new Date().toISOString(),
      });
    }
  }
}, 60 * 60 * 1000); // Check hourly

io.on("connection", (socket) => {
  console.log("Socket connected, ID:", socket.id);

  socket.on(
    "createGame",
    ({ title, playerCount, hostName, roundTimeLimit }) => {
      const gameId = generateInviteCode(6);

      const cards = [
        ...Array.from({ length: 25 }, (_, i) => ({
          id: i + 1,
          value: i + 1,
          pickedBy: null,
          pickTime: null,
          revealed: false,
        })),
        ...Array.from({ length: 4 }, (_, i) => ({
          id: i + 26,
          value: 30,
          pickedBy: null,
          pickTime: null,
          revealed: false,
        })),
        { id: 30, value: 50, pickedBy: null, pickTime: null, revealed: false },
      ];
      shuffleArray(cards);

      const game = {
        id: gameId,
        title,
        hostId: socket.id,
        hostName: hostName || "Host",
        players: [],
        spectators: [],
        cards,
        round: 1,
        currentTurn: null,
        turnOrder: [],
        status: "lobby",
        maxPlayers: Math.min(playerCount, 10),
        roundTimeLimit: roundTimeLimit || 0,
        roundTimer: null,
        chatMessages: [],
        leaderboard: [],
        champion: null,
        allParticipants: [],
        createdAt: Date.now(),
      };

      games.set(gameId, game);
      socket.join(gameId);
      socket.emit("gameCreated", { gameId });
      socket.emit("gameData", { game, role: "host" });
      io.to(gameId).emit("chatMessage", {
        userId: "System",
        text: `Game created. Share code: ${gameId}`,
        role: "system",
        timestamp: new Date().toISOString(),
      });
    }
  );

  socket.on("joinGame", ({ gameId, name, isSpectator }) => {
    const game = games.get(gameId);
    if (!game) {
      socket.emit("joinError", { message: "Invalid game code." });
      return;
    }

    if (!name?.trim()) {
      socket.emit("joinError", { message: "Name is required." });
      return;
    }

    if (game.status !== "lobby") {
      socket.emit("joinError", { message: "Game has already started." });
      return;
    }

    if (isSpectator) {
      if (
        game.spectators.some((s) => s.name.toLowerCase() === name.toLowerCase())
      ) {
        socket.emit("joinError", {
          message: "Name already taken by another spectator.",
        });
        return;
      }
      const spectator = { id: socket.id, name };
      game.spectators.push(spectator);
      socket.join(gameId);
      socket.emit("joinSuccess", { gameId, role: "spectator" });
      socket.emit("gameData", { game, role: "spectator" });
      io.to(gameId).emit("chatMessage", {
        userId: "System",
        text: `${name} joined as a spectator.`,
        role: "system",
        timestamp: new Date().toISOString(),
      });
      io.to(gameId).emit("gameData", { game });
    } else {
      if (game.players.length >= game.maxPlayers) {
        socket.emit("joinError", { message: "Maximum players reached (10)." });
        return;
      }
      if (
        game.players.some((p) => p.name.toLowerCase() === name.toLowerCase())
      ) {
        socket.emit("joinError", {
          message: "Name already taken by another player.",
        });
        return;
      }
      const newPlayer = { id: socket.id, name, score: 0 };
      game.players.push(newPlayer);
      game.allParticipants.push(newPlayer);
      socket.join(gameId);
      socket.emit("joinSuccess", { gameId, role: "player" });
      socket.emit("gameData", { game, role: "player" });
      io.to(gameId).emit("chatMessage", {
        userId: "System",
        text: `${name} joined the game.`,
        role: "system",
        timestamp: new Date().toISOString(),
      });
      io.to(gameId).emit("gameData", { game });
    }
    games.set(gameId, game);
  });

  socket.on("startGame", ({ gameId }) => {
    const game = games.get(gameId);
    if (!game || game.hostId !== socket.id) {
      socket.emit("joinError", {
        message: "Only the host can start the game.",
      });
      return;
    }
    if (game.players.length < 2) {
      socket.emit("gameError", {
        message: "At least 2 players are required to start.",
      });
      return;
    }
    game.status = "playing";
    game.leaderboard = calculateLeaderboard(game.players);
    game.turnOrder = game.leaderboard.map((p, index) => ({
      id: p.id,
      order: index + 1,
    }));
    game.currentTurn = game.turnOrder[0]?.id || null;
    if (game.roundTimeLimit > 0) {
      game.roundTimer = game.roundTimeLimit;
      startTimer(gameId, game);
    }
    games.set(gameId, game);
    io.to(gameId).emit("gameStarted");
    io.to(gameId).emit("gameData", { game });
  });

  socket.on("leaveGame", ({ gameId, userId }) => {
    const game = games.get(gameId);
    if (!game) {
      socket.emit("gameError", { message: "Game not found." });
      return;
    }
    const spectator = game.spectators.find((s) => s.id === userId);
    if (spectator) {
      game.spectators = game.spectators.filter((s) => s.id !== userId);
      games.set(gameId, game);
      io.to(gameId).emit("chatMessage", {
        userId: "System",
        text: `${spectator.name} left the game.`,
        role: "system",
        timestamp: new Date().toISOString(),
      });
      io.to(gameId).emit("gameData", { game });
      socket.leave(gameId);
    } else {
      socket.emit("gameError", {
        message: "Only spectators can leave the game.",
      });
    }
  });

  socket.on("revealCards", async ({ gameId }) => {
    const game = games.get(gameId);
    if (!game || game.hostId !== socket.id) {
      socket.emit("gameError", { message: "Only the host can reveal cards." });
      return;
    }

    try {
      const timerInterval = timers.get(gameId);
      if (timerInterval) {
        clearInterval(timerInterval);
        timers.delete(gameId);
        game.roundTimer = null;
        io.to(gameId).emit("timerUpdate", { time: null });
      }

      const pickedCards = game.cards
        .filter((c) => c.pickedBy)
        .sort((a, b) => (a.pickTime || 0) - (b.pickTime || 0));

      // Sequentially reveal cards like in the OLD file
      for (let i = 0; i < pickedCards.length; i++) {
        const card = pickedCards[i];
        game.cards = game.cards.map((c) =>
          c.id === card.id ? { ...c, revealed: true } : c
        );
        io.to(gameId).emit("revealCard", {
          cardId: card.id,
          value: card.value,
          pickedBy: card.pickedBy,
          enlarge: true,
        });
        await new Promise((resolve) => setTimeout(resolve, 3000));
        io.to(gameId).emit("revealCard", {
          cardId: card.id,
          value: card.value,
          pickedBy: card.pickedBy,
          enlarge: false,
        });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      // Update leaderboard and handle elimination
      game.leaderboard = calculateLeaderboard(game.players);
      const lowestScore = game.leaderboard[game.leaderboard.length - 1]?.score;
      const tiedPlayers = game.leaderboard.filter(
        (p) => p.score === lowestScore
      );

      let eliminatedPlayer = null;
      if (tiedPlayers.length > 1) {
        const tiedWithPickTimes = tiedPlayers.map((p) => {
          const pickTime =
            game.cards.find((c) => c.pickedBy === p.id)?.pickTime || Infinity;
          return { ...p, pickTime };
        });
        tiedWithPickTimes.sort((a, b) => a.pickTime - b.pickTime);
        eliminatedPlayer = tiedWithPickTimes[tiedWithPickTimes.length - 1];
      } else if (tiedPlayers.length === 1) {
        eliminatedPlayer = tiedPlayers[0];
      }

      if (eliminatedPlayer) {
        const playerId = eliminatedPlayer.id;
        const playerName = eliminatedPlayer.name;
        game.allParticipants = game.allParticipants.map((p) =>
          p.id === playerId ? { ...p, score: eliminatedPlayer.score } : p
        );
        game.players = game.players.filter((p) => p.id !== playerId);
        game.leaderboard = calculateLeaderboard(game.players);
        game.turnOrder = game.leaderboard.map((p, index) => ({
          id: p.id,
          order: index + 1,
        }));
        game.currentTurn = game.turnOrder[0]?.id || null;
        io.to(gameId).emit("playerEliminated", playerId);
        io.to(gameId).emit("chatMessage", {
          userId: "System",
          text:
            tiedPlayers.length > 1
              ? `${playerName} was eliminated due to tiebreaker (slowest pick)!`
              : `${playerName} was eliminated!`,
          role: "system",
          timestamp: new Date().toISOString(),
        });
      } else {
        game.turnOrder = game.leaderboard.map((p, index) => ({
          id: p.id,
          order: index + 1,
        }));
        game.currentTurn = game.turnOrder[0]?.id || null;
      }

      if (game.players.length <= 1) {
        const champion = game.players.length === 1 ? game.players[0] : null;
        game.status = "ended";
        game.champion = champion;
        const finalLeaderboard = calculateLeaderboard([], game.allParticipants);
        if (champion) {
          finalLeaderboard.find((p) => p.id === champion.id).isChampion = true;
        }
        io.to(gameId).emit("finalLeaderboard", {
          leaderboard: finalLeaderboard,
          champion,
        });
        io.to(gameId).emit("gameEnded");
        io.to(gameId).emit("winnerDeclared", {
          championName: champion ? champion.name : null,
        });
        io.to(gameId).emit("chatMessage", {
          userId: "System",
          text: champion
            ? `${champion.name} is the Champion!`
            : "Game ended with no winner!",
          role: "system",
          timestamp: new Date().toISOString(),
        });
      }

      games.set(gameId, game);
      io.to(gameId).emit("gameData", { game });
    } catch (err) {
      console.error("Error in revealCards:", err);
      socket.emit("gameError", { message: "Failed to reveal cards." });
    }
  });

  socket.on("nextRound", ({ gameId }) => {
    const game = games.get(gameId);
    if (!game || game.hostId !== socket.id) {
      socket.emit("gameError", {
        message: "Only the host can start the next round.",
      });
      return;
    }
    game.round += 1;
    game.cards = game.cards.map((c) => ({
      ...c,
      pickedBy: null,
      pickTime: null,
      revealed: false,
    }));
    shuffleArray(game.cards);
    game.leaderboard = calculateLeaderboard(game.players);
    game.turnOrder = game.leaderboard.map((p, index) => ({
      id: p.id,
      order: index + 1,
    }));
    game.currentTurn = game.turnOrder[0]?.id || null;
    if (game.roundTimeLimit > 0) {
      game.roundTimer = game.roundTimeLimit;
      startTimer(gameId, game);
    }
    games.set(gameId, game);
    io.to(gameId).emit("nextRoundComplete");
    io.to(gameId).emit("chatMessage", {
      userId: "System",
      text: `Round ${game.round} started!`,
      role: "system",
      timestamp: new Date().toISOString(),
    });
    io.to(gameId).emit("gameData", { game });
  });

  socket.on("pickCard", ({ gameId, cardId, playerId }) => {
    const game = games.get(gameId);
    if (!game) {
      socket.emit("gameError", { message: "Game not found." });
      return;
    }
    if (game.currentTurn !== playerId) {
      socket.emit("gameError", { message: "Not your turn or invalid player." });
      return;
    }
    const card = game.cards.find((c) => c.id === cardId && !c.pickedBy);
    if (!card) {
      socket.emit("error", { message: "Card is invalid or already picked." });
      return;
    }

    card.pickedBy = playerId;
    card.pickTime = Date.now();
    const player = game.players.find((p) => p.id === playerId);
    player.score = (player.score || 0) + card.value;
    game.allParticipants = game.allParticipants.map((p) =>
      p.id === playerId ? { ...p, score: player.score } : p
    );
    const currentIndex = game.turnOrder.findIndex((t) => t.id === playerId);
    const nextIndex = (currentIndex + 1) % game.turnOrder.length;
    game.currentTurn = game.turnOrder[nextIndex]?.id || null;

    const pickedCount = game.cards.filter((c) => c.pickedBy).length;
    const activePlayers = game.players.length;
    if (pickedCount === activePlayers) {
      const timerInterval = timers.get(gameId);
      if (timerInterval) {
        clearInterval(timerInterval);
        timers.delete(gameId);
      }
      game.roundTimer = null;
      io.to(gameId).emit("timerUpdate", { time: null });
      io.to(gameId).emit("lastCardPicked", {
        message: `All ${activePlayers} active players picked! Host, please reveal cards.`,
      });
      const hostSocket = Array.from(io.sockets.sockets.values()).find(
        (s) => s.id === game.hostId
      );
      if (hostSocket) {
        hostSocket.emit("hostNotification", {
          message: `All ${activePlayers} players picked! Reveal cards now?`,
        });
      }
    } else if (game.roundTimeLimit > 0) {
      const timerInterval = timers.get(gameId);
      if (timerInterval) {
        clearInterval(timerInterval);
        timers.delete(gameId);
      }
      game.roundTimer = game.roundTimeLimit;
      startTimer(gameId, game);
    }

    games.set(gameId, game);
    io.to(gameId).emit("cardPicked", { cardId, playerId });
    io.to(gameId).emit("chatMessage", {
      userId: "System",
      text: `${player.name} picked a card.`,
      role: "system",
      timestamp: new Date().toISOString(),
    });
    io.to(gameId).emit("gameData", { game });
  });

  socket.on("resetGame", ({ gameId }) => {
    const game = games.get(gameId);
    if (!game || game.hostId !== socket.id) {
      socket.emit("gameError", {
        message: "Only the host can reset the game.",
      });
      return;
    }
    console.log("Resetting game fully:", { gameId, stateBefore: { ...game } });
    try {
      const timerInterval = timers.get(gameId);
      if (timerInterval) {
        clearInterval(timerInterval);
        timers.delete(gameId);
      }
      games.delete(gameId);
      io.to(gameId).emit("gameFullReset");
      io.to(gameId).emit("chatMessage", {
        userId: "System",
        text: "Game has been fully reset by the host.",
        role: "system",
        timestamp: new Date().toISOString(),
      });
      console.log("Game fully reset:", { gameId });
    } catch (err) {
      console.error("Error in resetGame:", err);
      socket.emit("error", { message: "Failed to fully reset game." });
    }
  });

  socket.on("chatMessage", ({ gameId, userId, text, role }) => {
    const game = games.get(gameId);
    if (!game) {
      socket.emit("error", { message: "Game not found." });
      return;
    }
    if (role === "spectator") {
      socket.emit("error", { message: "Spectators cannot send messages." });
      return;
    }
    const message = {
      userId,
      text,
      role,
      timestamp: new Date().toISOString(),
    };
    game.chatMessages.push(message);
    io.to(gameId).emit("chatMessage", message);
  });

  socket.on("getGame", ({ gameId }) => {
    const game = games.get(gameId);
    if (game) {
      const role =
        game.hostId === socket.id
          ? "host"
          : game.players.some((p) => p.id === socket.id)
          ? "player"
          : game.spectators.some((s) => s.id === socket.id)
          ? "spectator"
          : null;
      socket.emit("gameData", { game, role });
    } else {
      socket.emit("gameData", { game: null, role: null });
    }
  });

  socket.on("disconnect", () => {
    console.log("Socket disconnected, ID:", socket.id);
    games.forEach((game, gameId) => {
      if (game.hostId === socket.id) {
        const timerInterval = timers.get(gameId);
        if (timerInterval) clearInterval(timerInterval);
        timers.delete(gameId);
        games.delete(gameId);
        io.to(gameId).emit("gameEnded", { message: "Host disconnected." });
        io.to(gameId).emit("chatMessage", {
          userId: "System",
          text: "Host disconnected. Game ended.",
          role: "system",
          timestamp: new Date().toISOString(),
        });
      } else {
        const spectatorIndex = game.spectators.findIndex(
          (s) => s.id === socket.id
        );
        if (spectatorIndex !== -1) {
          const spectator = game.spectators[spectatorIndex];
          game.spectators.splice(spectatorIndex, 1);
          games.set(gameId, game);
          io.to(gameId).emit("chatMessage", {
            userId: "System",
            text: `${spectator.name} left the game.`,
            role: "system",
            timestamp: new Date().toISOString(),
          });
          io.to(gameId).emit("gameData", { game });
        }
      }
    });
  });

  function startTimer(gameId, game) {
    if (!game.cards.some((c) => !c.pickedBy)) {
      game.roundTimer = null;
      io.to(gameId).emit("timerUpdate", { time: null });
      return;
    }
    const timerInterval = setInterval(() => {
      if (game.roundTimer > 0) {
        game.roundTimer -= 1;
        io.to(gameId).emit("timerUpdate", { time: game.roundTimer });
      }
      if (game.roundTimer <= 0) {
        clearInterval(timerInterval);
        timers.delete(gameId);
        autoAssignCard(gameId, game);
        const currentIndex = game.turnOrder.findIndex(
          (t) => t.id === game.currentTurn
        );
        const nextIndex = (currentIndex + 1) % game.turnOrder.length;
        game.currentTurn = game.turnOrder[nextIndex]?.id || null;
        io.to(gameId).emit("chatMessage", {
          userId: "System",
          text: "Time's up! Card auto-assigned, turn advanced.",
          role: "system",
          timestamp: new Date().toISOString(),
        });
        if (game.cards.some((c) => !c.pickedBy)) {
          game.roundTimer = game.roundTimeLimit;
          startTimer(gameId, game);
        }
        games.set(gameId, game);
        io.to(gameId).emit("gameData", { game });
      }
    }, 1000);
    timers.set(gameId, timerInterval);
  }

  function autoAssignCard(gameId, game) {
    const unpickedCards = game.cards.filter((c) => !c.pickedBy);
    if (unpickedCards.length > 0) {
      const randomCard =
        unpickedCards[Math.floor(Math.random() * unpickedCards.length)];
      randomCard.pickedBy = game.currentTurn;
      randomCard.pickTime = Date.now();
      const player = game.players.find((p) => p.id === game.currentTurn);
      player.score = (player.score || 0) + randomCard.value;
      game.allParticipants = game.allParticipants.map((p) =>
        p.id === game.currentTurn ? { ...p, score: player.score } : p
      );
      io.to(gameId).emit("cardPicked", {
        cardId: randomCard.id,
        playerId: game.currentTurn,
      });
      io.to(gameId).emit("chatMessage", {
        userId: "System",
        text: `${player.name} was auto-assigned a card.`,
        role: "system",
        timestamp: new Date().toISOString(),
      });
    }
  }
});

app.use((req, res) => {
  console.warn("No route found:", req.url);
  res.status(404).send("Not Found");
});

server.listen(process.env.PORT || 5001, () => {
  console.log(`Server running on port ${process.env.PORT || 5001}`);
});
