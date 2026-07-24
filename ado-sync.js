const express = require('express');
const app = express();

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/test', (req, res) => {
  res.json({ message: 'Server is working' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Running'));
