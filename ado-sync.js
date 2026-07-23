require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const authHeader = Buffer.from(`:${process.env.ADO_PAT}`).toString('base64');
const client = axios.create({
  baseURL: `https://dev.azure.com/${process.env.ADO_ORG}/${process.env.ADO_PROJECT}/_apis`,
  headers: { 'Authorization': `Basic ${authHeader}`, 'Content-Type': 'application/json' }
});

const areaFilters = [
  'Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Online',
  'Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Print',
  'Commercial Engineering\\Digital\\Acquisition\\Cart and Checkout',
  'Commercial Engineering\\Digital\\Acquisition\\Global Product 1',
  'Commercial Engineering\\Digital\\Acquisition\\Global Product 2',
  'Commercial Engineering\\Digital\\Acquisition\\Global Product 3'
];

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/features', async (req, res) => {
  try {
    const resp = await client.post('/wit/wiql?api-version=7.0', {
      query: query: 'SELECT [System.Id], [System.Title], [System.AreaPath], [System.State] FROM workitems WHERE [System.WorkItemType] = "Feature" AND [System.State] = "In Process" AND [System.ChangedDate] >= @today - 90'
    });
    
    const filtered = resp.data.workItems.filter(item => 
      areaFilters.some(area => item.fields['System.AreaPath'] && item.fields['System.AreaPath'].includes(area))
    ).slice(0, 200);
    
    const ids = filtered.map(i => i.id);
    if (ids.length === 0) return res.json({ features: [], summary: { total: 0 } });
    
    const batch = await client.post('/wit/workitemsbatch?api-version=7.0', {
      ids: ids,
      fields: ['System.Id', 'System.Title', 'System.State', 'Custom.BEEstimate', 'Custom.FEEstimates', 'Custom.QASizing']
    });
    
    res.json({
      features: batch.data.value.map(i => ({
        id: i.id,
        title: i.fields['System.Title'] || '',
        state: i.fields['System.State'] || '',
        estimation: {
          be: i.fields['Custom.BEEstimate'] || '',
          fe: i.fields['Custom.FEEstimates'] || '',
          qa: i.fields['Custom.QASizing'] || '',
          estimatedSprints: 0
        },
        actualStoryPoints: 0,
        risk: 'unknown'
      })),
      summary: { total: batch.data.value.length }
    });
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Running'));
