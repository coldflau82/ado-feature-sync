require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => res.json({ ok: 1 }));

app.get('/api/features', async (req, res) => {
  try {
    const c = axios.create({
      baseURL: `https://dev.azure.com/${process.env.ADO_ORG}/${process.env.ADO_PROJECT}/_apis`,
      headers: { Authorization: `Basic ${Buffer.from(`:${process.env.ADO_PAT}`).toString('base64')}`, 'Content-Type': 'application/json' }
    });
    const r = await c.post('/wit/wiql?api-version=7.0', { query: 'SELECT [System.Id], [System.Title] FROM workitems WHERE [System.WorkItemType] = "Feature" AND ([System.AreaPath] UNDER "Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Online" OR [System.AreaPath] UNDER "Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Print" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Cart and Checkout" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 1" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 2" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 3")' });
    const ids = r.data.workItems.map(i => i.id);
    if (!ids.length) return res.json({ features: [] });
    const b = await c.post('/wit/workitemsbatch?api-version=7.0', { ids, fields: ['System.Id', 'System.Title', 'System.State', 'System.AreaPath', 'Custom.BEEstimate', 'Custom.FEEstimates', 'Custom.QASizing'] });
    res.json({ features: b.data.value.map(i => ({ id: i.id, title: i.fields['System.Title'] || '', state: i.fields['System.State'] || '', areaPath: i.fields['System.AreaPath'] || '', estimation: { be: i.fields['Custom.BEEstimate'] || '', fe: i.fields['Custom.FEEstimates'] || '', qa: i.fields['Custom.QASizing'] || '' } })) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('ok'));
