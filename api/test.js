// api/test.js — Phase 2.1/2.2: confirm the frontend can reach a serverless backend.
// Vercel auto-detects any .js file in /api as a serverless function — no config needed.
 
module.exports = (req, res) => {
  res.status(200).json({ message: "Backend connected!" });
};
 