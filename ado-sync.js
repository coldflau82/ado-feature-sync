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
    console.log('Step 1: Creating auth header');
    const authHeader = Buffer.from(`:${process.env.ADO_PAT}`).toString('base64');
    console.log('Step 2: Auth header created');
    
    const client = axios.create({
      baseURL: `https://dev.azure.com/${process.env.ADO_ORG}/${process.env.ADO_PROJECT}/_apis`,
      headers: {
        'Authorization': `Basic ${authHeader}`,
        'Content-Type': 'application/json'
      }
    });
    console.log('Step 3: Client created');

    const response = await client.post('/wit/wiql?api-version=7.0', {
      query: 'SELECT [System.Id], [System.Title] FROM workitems WHERE [System.WorkItemType] = "Feature" AND ([System.AreaPath] UNDER "Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Online" OR [System.AreaPath] UNDER "Commercial Engineering\\Go To Market\\Digital Sales Enablement\\Service-Print" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Cart and Checkout" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 1" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 2" OR [System.AreaPath] UNDER "Commercial Engineering\\Digital\\Acquisition\\Global Product 3")'
    });
    console.log('Step 4: WIQL query executed, items:', response.data.workItems.length);

    const ids = response.data.workItems.map(item => item.id);
    if (!ids.length) {
      console.log('Step 5: No items found');
      return res.json({ features: [] });
    }

    console.log('Step 6: Fetching details for', ids.length, 'items');
    const batch = await client.post('/wit/workitemsbatch?api-version=7.0', {
      ids: ids,
      fields: ['System.Id', 'System.Title', 'System.State', 'System.AreaPath', 'Custom.BEEstimate', 'Custom.FEEstimates', 'Custom.QASizing']
    });
    console.log('Step 7: Batch completed');

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
    console.error('ERROR:', error.message);
    console.error('Stack:', error.stack);
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running'));
