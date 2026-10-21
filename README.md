# Habitly full-stack starter (login + MongoDB + AI coach)

## Run it
1. Install Node.js 18+ and MongoDB (local), or create a free MongoDB Atlas cluster and copy its connection string.
2. `cp .env.example .env`, then fill in `MONGODB_URI`, a long random `JWT_SECRET`, and `GROQ_API_KEY`.
3. `npm install`
4. `npm start`, then open http://localhost:3000 (you will be sent to the login page).

## What is included
- `server.js`: Express API with signup, login and logout (bcrypt + JWT in an httpOnly cookie), per-user data in MongoDB, and an AI route that calls Groq so the key never reaches the browser.
- `public/login.html`: login and create-account page.
- `public/index.html`: the Habitly app, loading and saving each user's data through the API.

## API
POST /api/auth/signup, /api/auth/login, /api/auth/logout · GET /api/me · GET/PUT /api/state · POST /api/ai/chat

## Before going public
Use HTTPS and set NODE_ENV=production, use a strong JWT_SECRET, keep .env out of git, add email verification and password reset, and move from one document per user to separate collections (habits, check-ins, mood logs) as the PRD describes.
