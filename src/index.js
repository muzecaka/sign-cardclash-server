require("dotenv").config();
const express = require("express");
const { Server } = require("socket.io");
const http = require("http");
const admin = require("firebase-admin");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:5000", "https://sign-cardclash.vercel.app"],
    methods: ["GET", "POST"],
  },
});

// Initialize Firebase Admin SDK with environment variables
admin.initializeApp({
  credential: admin.credential.cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});

const db = admin.firestore();
const games = new Map();
const invites = new Map();
const lastGameDataEmission = new Map();
const timers = new Map();

function generateInviteCode(length = 6) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let code = "";
  for (let i = 0; i < length; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

const retryFirestoreOperation = async (
  operation,
  maxAttempts = 3,
  delay = 1000
) => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      console.error(`Firestore attempt ${attempt} failed:`, error);
      if (attempt === maxAttempts || error.code === 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, delay * attempt));
    }
  }
};

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

io.on("connection", async (socket) => {
  console.log("Socket connected, ID:", socket.id);

  socket.on(
    "createGame",
    async ({ title, playerCount, hostName, roundTimeLimit }) => {
      const gameId = generateInviteCode(6);
      const playerCodes = Array.from({ length: playerCount }, () =>
        generateInviteCode(8)
      );
      const spectatorCode = generateInviteCode(8);

      const cards = [
        ...Array.from({ length: 25 }, (_, i) => ({
          id: i + 1,
          value: i + 1,
          pickedBy: null,
          pickTime: null,
        })),
        ...Array.from({ length: 4 }, (_, i) => ({
          id: i + 26,
          value: 30,
          pickedBy: null,
          pickTime: null,
        })),
        { id: 30, value: 50, pickedBy: null, pickTime: null },
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
        maxPlayers: playerCount,
        roundTimeLimit: roundTimeLimit || 0,
        roundTimer: null,
        leaderboard: [],
        champion: null,
        allParticipants: [],
      };

      const invite = {
        gameId,
        playerCodes,
        spectatorCode,
        maxPlayers: playerCount,
      };

      games.set(gameId, game);
      invites.set(gameId, invite);

      try {
        await retryFirestoreOperation(async () => {
          await db.collection("games").doc(gameId).set(game);
          await db.collection("invites").doc(gameId).set(invite);
        });
        socket.join(gameId);
        socket.emit("gameCreated", { gameId, playerCodes, spectatorCode });
        socket.emit("gameData", { game, role: "host" });
        io.to(gameId).emit("chatMessage", {
          userId: "System",
          text: "Game created.",
          role: "system",
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        console.error("Firestore write error in createGame:", err);
        socket.emit("error", { message: "Failed to create game." });
      }
    }
  );

  socket.on("reconnect", async ({ gameId, oldSocketId, name }) => {
    const game = games.get(gameId);
    if (!game) {
      socket.emit("error", { message: "Game not found." });
      return;
    }
    const player = game.players.find(
      (p) => p.name === name && p.id === oldSocketId
    );
    if (player) {
      console.log("Reconnecting player:", {
        gameId,
        oldSocketId,
        newSocketId: socket.id,
        name,
      });
      player.id = socket.id;
      game.allParticipants = game.allParticipants.map((p) =>
        p.name === name && p.id === oldSocketId ? { ...p, id: socket.id } : p
      );
      try {
        await retryFirestoreOperation(async () => {
          await db.collection("games").doc(gameId).update({
            players: game.players,
            allParticipants: game.allParticipants,
          });
        });
        socket.join(gameId);
        socket.emit("gameData", { game, role: "player" });
        io.to(gameId).emit("chatMessage", {
          userId: "System",
          text: `${name} reconnected.`,
          role: "system",
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        console.error("Firestore write error in reconnect:", err);
        socket.emit("error", { message: "Failed to reconnect." });
      }
    } else {
      console.warn("Reconnect failed: Player not found:", {
        gameId,
        oldSocketId,
        name,
      });
      socket.emit("error", { message: "Player not found." });
    }
  });

  socket.on("joinGame", async ({ gameId, name, inviteCode, isSpectator }) => {
    const game = games.get(gameId);
    const invite = invites.get(gameId);

    if (!game || !invite) {
      console.error("Join error: Game or invite not found", {
        gameId,
        inviteCode,
      });
      socket.emit("joinError", { message: "Invalid game ID or invite code." });
      return;
    }

    if (!name?.trim()) {
      console.error("Join error: Name missing", { gameId, name });
      socket.emit("joinError", { message: "Name is required." });
      return;
    }

    const normalizedInviteCode = inviteCode?.trim()?.toUpperCase();

    if (isSpectator) {
      const normalizedSpectatorCode = invite.spectatorCode
        ?.trim()
        ?.toUpperCase();
      if (normalizedSpectatorCode !== normalizedInviteCode) {
        console.error("Join error: Invalid spectator code", {
          gameId,
          provided: normalizedInviteCode,
          expected: normalizedSpectatorCode,
        });
        socket.emit("joinError", {
          message: "Invalid spectator code.",
        });
        return;
      }
      if (
        game.spectators.some((s) => s.name.toLowerCase() === name.toLowerCase())
      ) {
        console.error("Join error: Spectator name taken", { gameId, name });
        socket.emit("joinError", {
          message: "Name already taken by another spectator.",
        });
        return;
      }
      try {
        await retryFirestoreOperation(async () => {
          const spectator = { id: socket.id, name };
          game.spectators.push(spectator);
          await db.collection("games").doc(gameId).update({
            spectators: game.spectators,
          });
        });
        socket.join(gameId);
        games.set(gameId, game);
        socket.emit("joinSuccess", { gameId, role: "spectator" });
        socket.emit("gameData", { game, role: "spectator" });
        io.to(gameId).emit("chatMessage", {
          userId: "System",
          text: `${name} joined as a spectator.`,
          role: "system",
          timestamp: new Date().toISOString(),
        });
        io.to(gameId).emit("gameData", { game });
      } catch (err) {
        console.error("Firestore write error in joinGame (spectator):", err);
        socket.emit("joinError", { message: "Failed to join as spectator." });
      }
    } else {
      const normalizedPlayerCode = normalizedInviteCode;
      if (!invite.playerCodes.includes(normalizedPlayerCode)) {
        console.error("Join error: Invalid player code", {
          gameId,
          provided: normalizedPlayerCode,
          expected: invite.playerCodes,
        });
        socket.emit("joinError", { message: "Invalid player code." });
        return;
      }
      if (game.players.length >= invite.maxPlayers) {
        console.error("Join error: Game full", {
          gameId,
          playerCount: game.players.length,
        });
        socket.emit("joinError", { message: "Game is full." });
        return;
      }
      if (
        game.players.some((p) => p.name.toLowerCase() === name.toLowerCase())
      ) {
        console.error("Join error: Player name taken", { gameId, name });
        socket.emit("joinError", {
          message: "Name already taken by another player.",
        });
        return;
      }
      try {
        await retryFirestoreOperation(async () => {
          invite.playerCodes = invite.playerCodes.filter(
            (code) => code !== normalizedPlayerCode
          );
          const newPlayer = { id: socket.id, name, score: 0 };
          game.players.push(newPlayer);
          game.allParticipants.push(newPlayer);
          await db.collection("games").doc(gameId).update({
            players: game.players,
            allParticipants: game.allParticipants,
          });
          await db.collection("invites").doc(gameId).update({
            playerCodes: invite.playerCodes,
          });
        });
        socket.join(gameId);
        games.set(gameId, game);
        invites.set(gameId, invite);
        socket.emit("joinSuccess", { gameId, role: "player" });
        socket.emit("gameData", { game, role: "player" });
        io.to(gameId).emit("chatMessage", {
          userId: "System",
          text: `${name} joined the game.`,
          role: "system",
          timestamp: new Date().toISOString(),
        });
        io.to(gameId).emit("gameData", { game });
      } catch (err) {
        console.error("Firestore write error in joinGame (player):", err);
        socket.emit("joinError", { message: "Failed to join as player." });
      }
    }
  });

  socket.on("startGame", async ({ gameId }) => {
    const game = games.get(gameId);
    if (!game || game.hostId !== socket.id) {
      socket.emit("joinError", {
        message: "Only the host can start the game.",
      });
      return;
    }
    if (game.players.length < 2) {
      socket.emit("gameError", {
        message: "At least 2 players are required to start the game.",
      });
      return;
    }
    try {
      await retryFirestoreOperation(async () => {
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
        await db.collection("games").doc(gameId).update({
          status: game.status,
          turnOrder: game.turnOrder,
          currentTurn: game.currentTurn,
          roundTimer: game.roundTimer,
          leaderboard: game.leaderboard,
        });
      });
      games.set(gameId, game);
      io.to(gameId).emit("gameStarted");
      io.to(gameId).emit("gameData", { game });
    } catch (err) {
      console.error("Firestore write error in startGame:", err);
      socket.emit("gameError", { message: "Failed to start game." });
    }
  });

  socket.on("leaveGame", async ({ gameId, userId }) => {
    const game = games.get(gameId);
    if (!game) {
      socket.emit("gameError", { message: "Game not found." });
      return;
    }
    const spectator = game.spectators.find((s) => s.id === userId);
    if (spectator) {
      try {
        await retryFirestoreOperation(async () => {
          game.spectators = game.spectators.filter((s) => s.id !== userId);
          await db.collection("games").doc(gameId).update({
            spectators: game.spectators,
          });
        });
        games.set(gameId, game);
        io.to(gameId).emit("chatMessage", {
          userId: "System",
          text: `${spectator.name} left the game.`,
          role: "system",
          timestamp: new Date().toISOString(),
        });
        io.to(gameId).emit("gameData", { game });
        socket.leave(gameId);
      } catch (err) {
        console.error("Firestore write error in leaveGame:", err);
        socket.emit("gameError", { message: "Failed to leave game." });
      }
    } else {
      socket.emit("gameError", {
        message: "Only spectators can leave the game.",
      });
    }
  });

  // socket.on("replayGame", async ({ gameId }) => {
  //   const game = games.get(gameId);
  //   if (!game || game.hostId !== socket.id) {
  //     socket.emit("gameError", {
  //       message: "Only the host can replay the game.",
  //     });
  //     return;
  //   }
  //   try {
  //     await retryFirestoreOperation(async () => {
  //       const timerInterval = timers.get(gameId);
  //       if (timerInterval) {
  //         clearInterval(timerInterval);
  //         timers.delete(gameId);
  //       }
  //       const newGameId = generateInviteCode(6);
  //       const newPlayerCodes = Array.from({ length: game.maxPlayers }, () =>
  //         generateInviteCode(8)
  //       );
  //       const newSpectatorCode = generateInviteCode(8);
  //       const cards = [
  //         ...Array.from({ length: 25 }, (_, i) => ({
  //           id: i + 1,
  //           value: i + 1,
  //           pickedBy: null,
  //           pickTime: null,
  //         })),
  //         ...Array.from({ length: 4 }, (_, i) => ({
  //           id: i + 26,
  //           value: 30,
  //           pickedBy: null,
  //           pickTime: null,
  //         })),
  //         { id: 30, value: 50, pickedBy: null, pickTime: null },
  //       ];
  //       shuffleArray(cards);
  //       const newGame = {
  //         id: newGameId,
  //         title: game.title,
  //         hostId: game.hostId,
  //         hostName: game.hostName,
  //         players: game.players.map((p) => ({ ...p, score: 0 })),
  //         spectators: game.spectators,
  //         cards,
  //         round: 1,
  //         currentTurn: null,
  //         turnOrder: [],
  //         status: "lobby",
  //         maxPlayers: game.maxPlayers,
  //         roundTimeLimit: game.roundTimeLimit,
  //         roundTimer: null,
  //         leaderboard: [],
  //         champion: null,
  //         allParticipants: game.allParticipants.map((p) => ({
  //           ...p,
  //           score: 0,
  //         })),
  //       };
  //       const newInvite = {
  //         gameId: newGameId,
  //         playerCodes: newPlayerCodes,
  //         spectatorCode: newSpectatorCode,
  //         maxPlayers: game.maxPlayers,
  //       };
  //       games.set(newGameId, newGame);
  //       invites.set(newGameId, newInvite);
  //       await db.collection("games").doc(newGameId).set(newGame);
  //       await db.collection("invites").doc(newGameId).set(newInvite);
  //       await db.collection("games").doc(gameId).delete();
  //       await db.collection("invites").doc(gameId).delete();
  //       games.delete(gameId);
  //       invites.delete(gameId);
  //       io.to(gameId).emit("gameReplayed", { newGameId });
  //       io.to(gameId).emit("chatMessage", {
  //         userId: "System",
  //         text: "Game has been replayed by the host.",
  //         role: "system",
  //         timestamp: new Date().toISOString(),
  //       });
  //     });
  //   } catch (err) {
  //     console.error("Firestore error in replayGame:", err);
  //     socket.emit("gameError", { message: "Failed to replay game." });
  //   }
  // });

  function emitGameData(gameId, socket, game, explicitRole = null) {
    const now = Date.now();
    const lastEmission = lastGameDataEmission.get(gameId) || 0;
    if (socket !== "broadcast" && now - lastEmission < 500) return;
    lastGameDataEmission.set(gameId, now);

    let role = explicitRole;
    if (!role) {
      if (game.hostId === socket.id) {
        role = "host";
      } else if (game.players.some((p) => p.id === socket.id)) {
        role = "player";
      } else if (game.spectators.some((s) => s.id === socket.id)) {
        role = "spectator";
      } else {
        role = null;
      }
    }

    console.log("Emitting gameData:", {
      gameId,
      socketId: socket.id || "broadcast",
      role,
      players: game.players.map((p) => p.id),
      spectators: game.spectators.map((s) => s.id),
      allParticipants: game.allParticipants.map((p) => p.id),
    });

    if (socket === "broadcast") {
      Array.from(io.sockets.sockets.values()).forEach((client) => {
        if (client.rooms.has(gameId)) {
          const clientRole =
            game.hostId === client.id
              ? "host"
              : game.players.some((p) => p.id === client.id)
              ? "player"
              : game.spectators.some((s) => s.id === client.id)
              ? "spectator"
              : null;
          if (clientRole) {
            client.emit("gameData", { game, role: clientRole });
          }
        }
      });
    } else {
      socket.emit("gameData", { game, role });
    }
  }

  socket.on("getGame", async ({ gameId }) => {
    const game = games.get(gameId);
    if (game) {
      emitGameData(gameId, socket, game);
    } else {
      console.warn("Game not found in getGame:", {
        gameId,
        socketId: socket.id,
      });
      socket.emit("gameData", { game: null, role: null });
    }
  });

  socket.on("revealCards", async ({ gameId }) => {
    const game = games.get(gameId);
    if (!game || game.hostId !== socket.id) {
      socket.emit("gameError", { message: "Only the host can reveal cards." });
      return;
    }
    try {
      await retryFirestoreOperation(async () => {
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
        for (let i = 0; i < pickedCards.length; i++) {
          const card = pickedCards[i];
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

        await new Promise((resolve) => setTimeout(resolve, 1000));

        game.leaderboard = calculateLeaderboard(game.players);
        const lowestScore =
          game.leaderboard[game.leaderboard.length - 1]?.score;
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

        await db.collection("games").doc(gameId).update({
          players: game.players,
          roundTimer: game.roundTimer,
          leaderboard: game.leaderboard,
          turnOrder: game.turnOrder,
          currentTurn: game.currentTurn,
          allParticipants: game.allParticipants,
        });

        if (game.players.length <= 1) {
          const champion = game.players.length === 1 ? game.players[0] : null;
          game.status = "ended";
          game.champion = champion;
          const finalLeaderboard = calculateLeaderboard(
            [],
            game.allParticipants
          );
          if (champion) {
            finalLeaderboard.find(
              (p) => p.id === champion.id
            ).isChampion = true;
          }
          await db.collection("games").doc(gameId).update({
            status: game.status,
            champion: champion,
            allParticipants: game.allParticipants,
          });
          games.set(gameId, game);
          console.log("Emitting finalLeaderboard:", {
            leaderboard: finalLeaderboard,
            champion: champion?.name,
          });
          io.to(gameId).emit("finalLeaderboard", {
            leaderboard: finalLeaderboard,
            champion: champion,
          });
          console.log("Emitting gameEnded for gameId:", gameId);
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
      });
    } catch (err) {
      console.error("Firestore write error in revealCards:", err);
      socket.emit("gameError", { message: "Failed to reveal cards." });
    }
  });

  socket.on("nextRound", async ({ gameId }) => {
    const game = games.get(gameId);
    if (!game || game.hostId !== socket.id) {
      socket.emit("gameError", {
        message: "Only the host can start the next round.",
      });
      return;
    }
    try {
      await retryFirestoreOperation(async () => {
        game.round += 1;
        game.cards = game.cards.map((c) => ({
          ...c,
          pickedBy: null,
          pickTime: null,
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
        await db.collection("games").doc(gameId).update({
          round: game.round,
          cards: game.cards,
          turnOrder: game.turnOrder,
          currentTurn: game.currentTurn,
          roundTimer: game.roundTimer,
          leaderboard: game.leaderboard,
        });
      });
      games.set(gameId, game);
      io.to(gameId).emit("nextRoundComplete");
      io.to(gameId).emit("chatMessage", {
        userId: "System",
        text: `Round ${game.round} started!`,
        role: "system",
        timestamp: new Date().toISOString(),
      });
      io.to(gameId).emit("gameData", { game });
    } catch (err) {
      console.error("Firestore write error in nextRound:", err);
      socket.emit("error", { message: "Failed to start next round." });
    }
  });

  socket.on("pickCard", async ({ gameId, cardId, playerId }) => {
    const game = games.get(gameId);
    if (!game) {
      console.error("Pick card error: Game not found", { gameId });
      socket.emit("gameError", { message: "Game not found." });
      return;
    }
    if (game.currentTurn !== playerId) {
      console.error("Pick card error: Not player turn or invalid player", {
        gameId,
        playerId,
      });
      socket.emit("gameError", { message: "Not your turn or invalid player." });
      return;
    }
    const card = game.cards.find((c) => c.id === cardId && !c.pickedBy);
    if (!card) {
      console.error("Invalid card or already picked:", { gameId, cardId });
      socket.emit("error", { message: "Card is invalid or already picked." });
      return;
    }
    try {
      await retryFirestoreOperation(async () => {
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

        await db.collection("games").doc(gameId).update({
          cards: game.cards,
          players: game.players,
          allParticipants: game.allParticipants,
          currentTurn: game.currentTurn,
          roundTimer: game.roundTimer,
        });
      });
      games.set(gameId, game);
      const player = game.players.find((p) => p.id === playerId);
      io.to(gameId).emit("cardPicked", { cardId, playerId });
      io.to(gameId).emit("chatMessage", {
        userId: "System",
        text: `${player.name} picked a card.`,
        role: "system",
        timestamp: new Date().toISOString(),
      });
      emitGameData(gameId, "broadcast", game);
    } catch (err) {
      console.error("Firestore write error in pickCard:", err);
      socket.emit("gameError", { message: "Failed to pick card." });
    }
  });

  socket.on("saveGame", async ({ gameId }) => {
    const game = games.get(gameId);
    if (!game || game.hostId !== socket.id) {
      socket.emit("gameError", { message: "Only the host can save the game." });
      return;
    }
    try {
      await retryFirestoreOperation(async () => {
        await db.collection("games").doc(gameId).set(game);
      });
      socket.emit("gameSaved");
      io.to(gameId).emit("chatMessage", {
        userId: "System",
        text: "Game saved.",
        role: "system",
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      console.error("Firestore write error in saveGame:", err);
      socket.emit("gameError", { message: "Failed to save game." });
    }
  });

  socket.on("resetGame", async ({ gameId }) => {
    const game = games.get(gameId);
    if (!game || game.hostId !== socket.id) {
      socket.emit("gameError", {
        message: "Only the host can reset the game.",
      });
      return;
    }
    console.log("Resetting game fully:", { gameId, stateBefore: { ...game } });
    try {
      await retryFirestoreOperation(async () => {
        const timerInterval = timers.get(gameId);
        if (timerInterval) {
          clearInterval(timerInterval);
          timers.delete(gameId);
        }
        await db.collection("games").doc(gameId).delete();
        await db.collection("invites").doc(gameId).delete();
      });
      games.delete(gameId);
      invites.delete(gameId);
      io.to(gameId).emit("gameFullReset");
      io.to(gameId).emit("chatMessage", {
        userId: "System",
        text: "Game has been fully reset by the host.",
        role: "system",
        timestamp: new Date().toISOString(),
      });
      console.log("Game fully reset:", { gameId });
    } catch (err) {
      console.error("Firestore delete error in resetGame:", err);
      socket.emit("error", { message: "Failed to fully reset game." });
    }
  });

  socket.on("chatMessage", ({ gameId, userId, text, role }) => {
    const game = games.get(gameId);
    if (!game || role === "spectator") return;
    io.to(gameId).emit("chatMessage", {
      userId,
      text,
      role,
      timestamp: new Date().toISOString(),
    });
  });

  socket.on("stopTimer", ({ gameId }) => {
    const game = games.get(gameId);
    if (game) {
      const timerInterval = timers.get(gameId);
      if (timerInterval) {
        clearInterval(timerInterval);
        timers.delete(gameId);
        game.roundTimer = null;
        io.to(gameId).emit("timerUpdate", { time: null });
      }
    }
  });

  socket.on("disconnect", async () => {
    console.log("Socket disconnected, ID:", socket.id);
    games.forEach(async (game, gameId) => {
      if (game.hostId === socket.id) {
        const timerInterval = timers.get(gameId);
        if (timerInterval) {
          clearInterval(timerInterval);
          timers.delete(gameId);
        }
        games.delete(gameId);
        invites.delete(gameId);
        io.to(gameId).emit("gameEnded");
        io.to(gameId).emit("chatMessage", {
          userId: "System",
          text: "Host disconnected. Game ended.",
          role: "system",
          timestamp: new Date().toISOString(),
        });
        try {
          await retryFirestoreOperation(async () => {
            await db.collection("games").doc(gameId).delete();
          });
        } catch (err) {
          console.error("Firestore delete error in disconnect:", err);
        }
      } else {
        const spectatorIndex = game.spectators.findIndex(
          (s) => s.id === socket.id
        );
        if (spectatorIndex !== -1) {
          const spectator = game.spectators[spectatorIndex];
          try {
            await retryFirestoreOperation(async () => {
              game.spectators.splice(spectatorIndex, 1);
              await db.collection("games").doc(gameId).update({
                spectators: game.spectators,
              });
            });
            games.set(gameId, game);
            io.to(gameId).emit("chatMessage", {
              userId: "System",
              text: `${spectator.name} left the game.`,
              role: "system",
              timestamp: new Date().toISOString(),
            });
            io.to(gameId).emit("gameData", { game });
          } catch (err) {
            console.error("Firestore write error in disconnect:", err);
          }
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
