require('dotenv').config();
const express = require('express');

const app = express();

app.get('/api/health', (req, res) => {
  res.json({
    ORG: process.env.ADO_ORG ? 'SET' : 'MISSING',
    PROJECT: process.env.ADO_PROJECT ? 'SET' : 'MISSING',
    PAT: process.env.ADO_PAT ? 'SET' : 'MISSING'
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('ok'));
