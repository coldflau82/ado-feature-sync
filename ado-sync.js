require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/features', async (req, res) => {
  try {
    const authHeader = Buffer.from(`:${process.env.ADO_PAT}`).toString('base64');
    const client = axios.create({
      baseURL: `https://dev.azure.com/${process.env.ADO_ORG}/${process.env.ADO_PROJECT}/_apis`,
      headers: { 'Authorization': `Basic ${authHeader}`, 'Content-Type': 'application/json' }
    });
    
    const resp = await client.post('/wit/wiql?api-version=7.0', {
      query: 'SELECT [System.Id], [System.Title] FROM workitems WHERE [System.WorkItemType] = "Feature" ORDER BY [System.Id] DESC'
    });
    
    const ids = resp.data.workItems.slice(0, 10).map(i => i.id);
    if (ids.length === 0) return res.json({ features: [] });
    
    const batch = await client.post('/wit/workitemsbatch?api-version=7.0', {
      ids: ids,
      fields: ['System.Id', 'System.Title', 'System.State']
    });
    
    res.json({
      features: batch.data.value.map(i => ({
        id: i.id,
        title: i.fields['System.Title'],
        state: i.fields['System.State']
      }))
    });
  } catch (error) {
    res.status(500).json({ error: error.message, details: error.response?.data });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running'));
