require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Configuración
const ADO_ORG = process.env.ADO_ORG;
const ADO_PROJECT = process.env.ADO_PROJECT;
const ADO_PAT = process.env.ADO_PAT;

console.log('ADO_ORG:', ADO_ORG);
console.log('ADO_PROJECT:', ADO_PROJECT);
console.log('ADO_PAT:', ADO_PAT ? 'SET' : 'MISSING');

if (!ADO_ORG || !ADO_PROJECT || !ADO_PAT) {
  console.error('Error: Faltan variables de entorno');
  process.exit(1);
}

// Base64 encode PAT
const authHeader = Buffer.from(`:${ADO_PAT}`).toString('base64');

// Cliente ADO
const adoClient = axios.create({
  baseURL: `https://dev.azure.com/${ADO_ORG}/${ADO_PROJECT}/_apis`,
  headers: {
    Authorization: `Basic ${authHeader}`,
    'Content-Type': 'application/json'
  }
});

// Obtener Features
async function fetchFeatures() {
  try {
    console.log('Fetching features...');
    const response = await adoClient.post('/wit/wiql?api-version=7.0', {
      query: `SELECT [System.Id], [System.Title], [System.State] FROM workitems WHERE [System.WorkItemType] = 'Feature'`
    });

    console.log('Features found:', response.data.workItems.length);
    
    const ids = response.data.workItems.map(item => item.id);
    if (ids.length === 0) return [];

    // Obtener detalles
    const detailsResponse = await adoClient.post('/wit/workitemsbatch?api-version=7.0', {
      ids: ids,
      fields: ['System.Id', 'System.Title', 'System.State', 'System.TargetDate']
    });

    return detailsResponse.data.value.map(item => ({
      id: item.id,
      title: item.fields['System.Title'],
      state: item.fields['System.State'],
      targetDate: item.fields['System.TargetDate'] || '',
      estimated: 0,
      actual: 0,
      risk: 'unknown'
    }));
  } catch (error) {
    console.error('Error fetching features:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }
    throw error;
  }
}

// Endpoints
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/features', async (req, res) => {
  try {
    const features = await fetchFeatures();
    res.json({
      features: features,
      summary: {
        total: features.length,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('API Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ADO Sync API running on port ${PORT}`);
});
