require('dotenv').config();
const express = require('express');
const axios = require('axios');

const app = express();
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ ok: 1 });
});

app.get('/api/features', async (req, res) => {
  try {
    const c = axios.create({
      baseURL: `https://dev.azure.com/${process.env.ADO_ORG}/${process.env.ADO_PROJECT}/_apis`,
      headers: { 
        Authorization: `Basic ${Buffer.from(`:${process.env.ADO_PAT}`).toString('base64')}`,
        'Content-Type': 'application/json'
      }
    });

    const r = await c.post('/wit/wiql?api-version=7.0', {
      query: 'SELECT [System.Id], [System.Title] FROM workitems WHERE [System.WorkItemType] = "Feature"'
    });

    res.json({ 
      total: r.data.workItems.length,
      first5: r.data.workItems.slice(0, 5)
    });
  } catch (error) {
    res.status(500).json({ 
      error: error.message,
      details: error.response?.data || 'No response data'
    });
  }
});

app.listen(process.env.PORT || 3000, () => console.log('ok'));
