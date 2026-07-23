require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Features - placeholder por ahora
app.get('/api/features', (req, res) => {
  res.json({
    features: [],
    summary: { total: 0, timestamp: new Date().toISOString() }
  });
});

// Dashboard
app.get('/dashboard', (req, res) => {
  res.send('<h1>Dashboard</h1><p>Conectando a ADO...</p>');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
