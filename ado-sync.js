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
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/json'
      }
    });

    const response = await client.post('/wit/wiql?api-version=7.0', {
      query: 'SELECT [System.Id], [System.Title] FROM workitems WHERE [System.WorkItemType] = "Feature" AND ([System.AreaPath] UNDER "Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Online" OR [System.AreaPath] UNDER "Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Print" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Cart and Checkout" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 1" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 2" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 3")'
    });

    const ids = response.data.workItems.map(item => item.id);
    
    if (!ids.length) {
      return res.json({ features: [] });
    }

    const batch = await client.post('/wit/workitemsbatch?api-version=7.0', {
      ids: ids,
      fields: ['System.Id', 'System.Title', 'System.State', 'System.AreaPath', 'Custom.BEEstimate', 'Custom.FEEstimates', 'Custom.QASizing']
    });

    const features = batch.data.value.map(item => ({
      id: item.id,
      title: item.fields['System.Title'] || '',
      state: item.fields['System.State'] || '',
      areaPath: item.fields['System.AreaPath'] || '',
      estimation: {
        be: item.fields['Custom.BEEstimate'] || '',
        fe: item.fields['Custom.FEEstimates'] || '',
        qa: item.fields['Custom.QASizing'] || ''
      }
    }));

    res.json({ features });
  } catch (error) {
    console.error('Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running'));
