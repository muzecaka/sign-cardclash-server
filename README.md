Sign Card Clash - Server
This is the server-side of Sign Card Clash, powering real-time multiplayer card battles for up to 10 players. Built with Node.js and Socket.IO, it manages game state, card picks, and chat. Deployed at https://sign-cardclash-server-527i.onrender.com. Clone to contribute or run locally!

🎮 Game Overview

The server supports Sign Card Clash, where players pick from a 30-card deck (25 valued 1-25, 4 valued 30, 1 valued 50) to outscore opponents. It handles game creation, player joins, card shuffling, and eliminations, syncing all actions in real-time.

🧠 AI Techniques Used

Randomized Card Shuffling: Fisher-Yates algorithm (shuffleArray) ensures fair card distribution.
Automated Card Assignment: Auto-assigns cards for missed turns (autoAssignCard), using random selection from unpicked cards.
Leaderboard Calculation: Sorts players by score (calculateLeaderboard), with pick-time tiebreakers.
Game Cleanup: Removes games older than 24 hours to manage resources.

⚙️ Game Mechanics
Scoring System

Card Values: 25 cards (1-25), 4 cards (30), 1 card (50).
Scoring: Players pick one card per round, adding its value to their score.
Tiebreakers: Slowest picker in a lowest-score tie is eliminated.

AI Behaviors

No NPCs: All actions are player-driven.
Automation: Handles turn timers, auto-assignments, and game state transitions (lobby, playing, ended).

Level Progression

Rounds: Players pick in turn; lowest scorer is eliminated.
Turn Order: Leaderboard-based (highest score first).
Endgame: Last player is champion, or no winner if all eliminated.

🛠️ Technical Details
Tech Stack

Node.js + Express: Lightweight server framework.
Socket.IO Server: Real-time communication for events (createGame, pickCard).
In-Memory Storage: Map for game state and timers.
Crypto: Generates 6-character game codes (e.g., ABC123).

Architecture

Real-Time Sync: Socket.IO broadcasts updates (e.g., card picks, eliminations).
Scalability: Supports 10 players per game, with cleanup for stale games.
Security: CORS restricts to trusted origins (e.g., https://sign-cardclash.vercel.app).

🚀 Getting Started
Prerequisites

Node.js (v16+)
npm or yarn
Git

Installation

Clone the server repo:
git clone https://github.com/muzecaka/sign-cardclash-server.git
cd sign-cardclash-server

Install dependencies:
npm install

Set up environment variables (create .env):
PORT=5001
CLIENT_URL=http://localhost:3000,https://sign-cardclash.vercel.app

Run the server:
npm start

Note: Requires the client running (sign-cardclash repo).
🤝 Contributing

Fork the repo.
Create a feature branch (git checkout -b feature/YourFeature).
Commit changes (git commit -m "Add YourFeature").
Push (git push origin feature/YourFeature).
Open a Pull Request.

📜 License
MIT License. Include the copyright notice (“Sign Card Clash by @muzecaka”) in derivatives.
🙌 Acknowledgments

By Muze Caka
X @muzecaka.
Discord KanmiNFT.
