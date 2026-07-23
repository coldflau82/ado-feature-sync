require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const ADO_ORG = process.env.ADO_ORG;
const ADO_PROJECT = process.env.ADO_PROJECT;
const ADO_PAT = process.env.ADO_PAT;

console.log('Starting ADO Sync...');
console.log('ADO_ORG:', ADO_ORG);
console.log('ADO_PROJECT:', ADO_PROJECT);
console.log('ADO_PAT provided:', !!ADO_PAT);

if (!ADO_ORG || !ADO_PROJECT || !ADO_PAT) {
  console.error('Missing environment variables');
  process.exit(1);
}

const authHeader = Buffer.from(`:${ADO_PAT}`).toString('base64');

const adoClient = axios.create({
  baseURL: `https://dev.azure.com/${ADO_ORG}/${ADO_PROJECT}/_apis`,
  headers: {
    'Authorization': `Basic ${authHeader}`,
    'Content-Type': 'application/json'
  }
});

async function fetchFeatures() {
  try {
    console.log('Fetching from:', `https://dev.azure.com/${ADO_ORG}/${ADO_PROJECT}/_apis/wit/wiql?api-version=7.0`);
    
    const response = await adoClient.post('/wit/wiql?api-version=7.0', {
      query: 'SELECT TOP 200 [System.Id], [System.Title], [System.State] FROM workitems WHERE [System.WorkItemType] = "Feature" AND [System.AreaPath] UNDER "Commercial Engineering" AND [System.State] IN ("New", "In Planning", "In Shaping", "In Process", "Planned") ORDER BY [System.ChangedDate] DESC'
    });

    console.log('Success! Found features:', response.data.workItems.length);
    const ids = response.data.workItems.map(item => item.id);
    
    if (ids.length === 0) return [];

    const batch = await adoClient.post('/wit/workitemsbatch?api-version=7.0', {
      ids: ids,
      fields: ['System.Id', 'System.Title', 'System.State', 'System.TargetDate']
    });

    return batch.data.value.map(item => ({
      id: item.id,
      title: item.fields['System.Title'] || '',
      state: item.fields['System.State'] || '',
      targetDate: item.fields['System.TargetDate'] || ''
    }));
  } catch (error) {
    console.error('Error:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', JSON.stringify(error.response.data, null, 2));
    }
    throw error;
  }
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/features', async (req, res) => {
  try {
    const features = await fetchFeatures();
    res.json({
      features: features,
      count: features.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('API Error:', error.message);
    res.status(500).json({ 
      error: error.message,
      details: error.response?.data || 'No additional details'
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
